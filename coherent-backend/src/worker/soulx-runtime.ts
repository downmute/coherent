import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import os from 'node:os';
import type { AvatarConfig, RtcCredentials } from '../shared/types.js';
import { createRtcPublisher, type RtcPublisher } from './rtc-publisher.js';
import type { WorkerConfig } from '../shared/config.js';

export interface SegmentReadyEvent {
  sessionId: string;
  segmentIndex: number;
  fileName: string;
  absolutePath: string;
  final: boolean;
  durationSeconds?: number;
}

interface BridgeHandle {
  id: string;
  conditionImage: string;
  mediaDir: string;
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  readyResolve?: () => void;
  readyReject?: (error: Error) => void;
  resetPromise: Promise<void> | null;
  resetResolve?: () => void;
  resetReject?: (error: Error) => void;
  audioEndPromise: Promise<void> | null;
  audioEndResolve?: () => void;
  audioEndReject?: (error: Error) => void;
  alive: boolean;
  failure: string | null;
  currentSessionId: string | null;
}

interface RuntimeSession {
  sessionId: string;
  avatarConfig: AvatarConfig;
  publisher: RtcPublisher;
  conditionImage: string;
  mediaDir: string;
  bridge?: BridgeHandle;
  runtimeFailure?: string | null;
  closing?: boolean;
  frameQueue: string[][];
  framePump: Promise<void> | null;
  droppedFrameCount: number;
  queuedFrameCount: number;
  publishedFrameCount: number;
  startedAt: number;
  publisherJoinedAt?: number;
  firstAudioAt?: number;
  firstBridgeFrameAt?: number;
  firstRtcPublishAt?: number;
}

interface RuntimeStartInput {
  sessionId: string;
  avatarConfig: AvatarConfig;
  publisherRtc: RtcCredentials;
  publisherOptions: {
    mode: 'mock' | 'browser';
    browserExecutablePath: string;
    headless: boolean;
    width: number;
    height: number;
    fps: number;
  };
}

export class SoulxRuntime extends EventEmitter {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly maxQueuedFrameBatches = 6;
  private readonly idleBridges = new Map<string, BridgeHandle[]>();
  private readonly warmingBridges = new Map<string, Promise<void>>();

  constructor(private readonly config: WorkerConfig) {
    super();
  }

  private markSessionFailed(session: RuntimeSession, message: string): void {
    if (session.runtimeFailure) {
      return;
    }

    session.runtimeFailure = message;
    if (session.bridge) {
      session.bridge.failure = session.bridge.failure ?? message;
      session.bridge.alive = false;
      session.bridge.audioEndReject?.(new Error(message));
      session.bridge.audioEndPromise = null;
      session.bridge.audioEndReject = undefined;
      session.bridge.audioEndResolve = undefined;
      session.bridge.resetReject?.(new Error(message));
      session.bridge.resetPromise = null;
      session.bridge.resetReject = undefined;
      session.bridge.resetResolve = undefined;
      session.bridge.readyReject?.(new Error(message));
      session.bridge.readyReject = undefined;
      session.bridge.readyResolve = undefined;
    }
    console.error(`[soulx-runtime:${session.sessionId}] ${message}`);
  }

  private ensureSessionHealthy(session: RuntimeSession): void {
    if (session.runtimeFailure) {
      throw new Error(session.runtimeFailure);
    }
    if (session.bridge?.failure && !session.bridge.alive) {
      throw new Error(session.bridge.failure);
    }
  }

  private listFaceImages(folder: 'male' | 'female'): string[] {
    const baseDir = path.join(this.config.SOULX_FACES_DIR, folder);
    if (!fs.existsSync(baseDir)) {
      return [];
    }

    return fs
      .readdirSync(baseDir)
      .filter((entry) => /\.(png|jpe?g)$/i.test(entry))
      .sort()
      .map((entry) => path.join(baseDir, entry));
  }

  private resolveConditionImage(avatarConfig: AvatarConfig): string {
    const explicitPath =
      typeof avatarConfig.imagePath === 'string' && avatarConfig.imagePath.trim().length > 0
        ? avatarConfig.imagePath
        : null;
    if (explicitPath) {
      return explicitPath;
    }

    const avatarId =
      typeof avatarConfig.avatarId === 'string' && avatarConfig.avatarId.trim().length > 0
        ? avatarConfig.avatarId.trim().toLowerCase()
        : null;
    const gender =
      typeof avatarConfig.gender === 'string' && avatarConfig.gender.trim().length > 0
        ? avatarConfig.gender.trim().toLowerCase()
        : null;

    const tryFolders = new Set<'male' | 'female'>();
    if (gender === 'male' || gender === 'female') {
      tryFolders.add(gender);
    }
    if (avatarId?.startsWith('male')) {
      tryFolders.add('male');
    }
    if (avatarId?.startsWith('female')) {
      tryFolders.add('female');
    }
    if (avatarId === 'default-male') {
      tryFolders.add('male');
    }
    if (avatarId === 'default-female') {
      tryFolders.add('female');
    }

    for (const folder of tryFolders) {
      const files = this.listFaceImages(folder);
      if (files.length === 0) {
        continue;
      }

      if (avatarId) {
        const exact = files.find((file) => path.parse(file).name.toLowerCase() === avatarId);
        if (exact) {
          return exact;
        }
      }

      const offset = avatarId
        ? avatarId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
        : 0;
      return files[offset % files.length]!;
    }

    return this.config.SOULX_COND_IMAGE;
  }

  private createBridgeMediaDir(): string {
    const dir = path.join(os.tmpdir(), 'coherent-soulx', 'bridge', randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private spawnBridge(conditionImage: string): BridgeHandle {
    const cwd = process.env.SOULX_DIR || '/opt/SoulX-FlashHead';
    if (!fs.existsSync(this.config.SOULX_PYTHON_BIN)) {
      throw new Error(
        `SOULX_PYTHON_BIN was not found at ${this.config.SOULX_PYTHON_BIN}. ` +
          'For a laptop smoke test, set SOULX_RUNTIME_MODE=mock instead of python_bridge.',
      );
    }
    if (!fs.existsSync(this.config.SOULX_BRIDGE_SCRIPT)) {
      throw new Error(
        `SOULX_BRIDGE_SCRIPT was not found at ${this.config.SOULX_BRIDGE_SCRIPT}. ` +
          'Check your worker env or use SOULX_RUNTIME_MODE=mock for a local smoke test.',
      );
    }
    if (!fs.existsSync(cwd)) {
      throw new Error(
        `SOULX working directory was not found at ${cwd}. ` +
          'Check SOULX_DIR or use SOULX_RUNTIME_MODE=mock for a local smoke test.',
      );
    }

    const mediaDir = this.createBridgeMediaDir();
    const bridge = spawn(
      this.config.SOULX_PYTHON_BIN,
      [
        this.config.SOULX_BRIDGE_SCRIPT,
        '--ckpt_dir',
        this.config.SOULX_CKPT_DIR,
        '--wav2vec_dir',
        this.config.SOULX_WAV2VEC_DIR,
        '--model_type',
        this.config.SOULX_MODEL_TYPE,
        '--cond_image',
        conditionImage,
        '--base_seed',
        String(this.config.SOULX_BASE_SEED),
        '--use_face_crop',
        this.config.SOULX_USE_FACE_CROP ? 'true' : 'false',
        '--output_dir',
        mediaDir,
        '--chunks_per_segment',
        String(this.config.SOULX_CHUNKS_PER_SEGMENT),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
      },
    );

    const handle: BridgeHandle = {
      id: randomUUID(),
      conditionImage,
      mediaDir,
      process: bridge,
      ready: Promise.resolve(),
      resetPromise: null,
      audioEndPromise: null,
      alive: true,
      failure: null,
      currentSessionId: null,
    };

    handle.ready = new Promise<void>((resolve, reject) => {
      handle.readyResolve = resolve;
      handle.readyReject = reject;
    });

    const stdout = createInterface({ input: bridge.stdout });
    stdout.on('line', (line) => {
      void this.handleBridgeMessage(handle, line);
    });

    bridge.stdin.on('error', (error) => {
      handle.alive = false;
      handle.failure = error instanceof Error ? error.message : 'SoulX bridge stdin failed.';
      if (handle.currentSessionId) {
        const session = this.sessions.get(handle.currentSessionId);
        if (session && !session.closing) {
          this.markSessionFailed(session, handle.failure);
        }
      } else {
        console.error(`[soulx-bridge:${handle.id}] stdin error: ${handle.failure}`);
      }
    });

    bridge.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        const target = handle.currentSessionId ?? handle.id;
        console.error(`[soulx-bridge:${target}] ${message}`);
      }
    });

    bridge.on('error', (error) => {
      handle.alive = false;
      handle.failure = error instanceof Error ? error.message : 'SoulX bridge failed to spawn.';
      handle.readyReject?.(new Error(handle.failure));
      handle.readyReject = undefined;
      handle.readyResolve = undefined;
      if (handle.currentSessionId) {
        const session = this.sessions.get(handle.currentSessionId);
        if (session && !session.closing) {
          this.markSessionFailed(session, handle.failure);
        }
      } else {
        console.error(`[soulx-bridge:${handle.id}] spawn error: ${handle.failure}`);
      }
    });

    bridge.on('exit', (code, signal) => {
      handle.alive = false;
      const message =
        handle.failure ?? `SoulX bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      handle.failure = message;
      if (handle.currentSessionId) {
        const session = this.sessions.get(handle.currentSessionId);
        if (session && !session.closing) {
          this.markSessionFailed(session, message);
          console.warn(
            `[soulx-bridge:${handle.currentSessionId}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
          );
        }
      }
    });

    return handle;
  }

  private async resetBridge(handle: BridgeHandle, mediaDir: string): Promise<void> {
    handle.mediaDir = mediaDir;
    if (!handle.alive || handle.process.stdin.destroyed || !handle.process.stdin.writable) {
      throw new Error(handle.failure || 'SoulX bridge is no longer available.');
    }
    handle.resetPromise = new Promise<void>((resolve, reject) => {
      handle.resetResolve = resolve;
      handle.resetReject = reject;
    });

    const payload = `${JSON.stringify({
      type: 'reset',
      outputDir: mediaDir,
      chunksPerSegment: this.config.SOULX_CHUNKS_PER_SEGMENT,
    })}\n`;
    await new Promise<void>((resolve, reject) => {
      handle.process.stdin.write(payload, (error) => {
        if (error) {
          handle.alive = false;
          handle.failure = error.message;
          reject(error);
          return;
        }
        resolve();
      });
    });
    await handle.resetPromise;
  }

  private async ensureIdleBridge(conditionImage: string): Promise<void> {
    const pool = this.idleBridges.get(conditionImage);
    if (pool && pool.length > 0) {
      return;
    }

    const warming = this.warmingBridges.get(conditionImage);
    if (warming) {
      await warming;
      return;
    }

    const warmup = (async () => {
      const handle = this.spawnBridge(conditionImage);
      await handle.ready;
      const nextPool = this.idleBridges.get(conditionImage) ?? [];
      nextPool.push(handle);
      this.idleBridges.set(conditionImage, nextPool);
      console.log(`[soulx-runtime] prewarmed bridge for ${conditionImage}`);
    })();

    this.warmingBridges.set(conditionImage, warmup);
    try {
      await warmup;
    } finally {
      this.warmingBridges.delete(conditionImage);
    }
  }

  private async acquireBridge(conditionImage: string, sessionId: string, mediaDir: string): Promise<BridgeHandle> {
    const pool = this.idleBridges.get(conditionImage);
    let handle = pool?.shift();
    if (!handle) {
      await this.ensureIdleBridge(conditionImage);
      handle = this.idleBridges.get(conditionImage)?.shift();
    }
    handle ??= this.spawnBridge(conditionImage);
    await handle.ready;
    handle.currentSessionId = sessionId;
    handle.failure = null;
    handle.alive = true;
    await this.resetBridge(handle, mediaDir);
    return handle;
  }

  private async releaseBridge(handle: BridgeHandle): Promise<void> {
    handle.currentSessionId = null;
    if (!handle.alive) {
      await this.destroyBridge(handle);
      return;
    }
    const idleMediaDir = this.createBridgeMediaDir();
    try {
      await this.resetBridge(handle, idleMediaDir);
    } catch {
      await this.destroyBridge(handle);
      return;
    }
    const pool = this.idleBridges.get(handle.conditionImage) ?? [];
    pool.push(handle);
    this.idleBridges.set(handle.conditionImage, pool);
  }

  private async destroyBridge(handle: BridgeHandle): Promise<void> {
    handle.currentSessionId = null;
    try {
      if (!handle.process.stdin.destroyed && handle.process.stdin.writable) {
        handle.process.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
      }
    } catch {}
    try {
      handle.process.kill('SIGTERM');
    } catch {}
    try {
      fs.rmSync(handle.mediaDir, { recursive: true, force: true });
    } catch {}
  }

  async prewarmCommonBridges(): Promise<void> {
    if (this.config.SOULX_RUNTIME_MODE !== 'python_bridge') {
      return;
    }

    const avatars: AvatarConfig[] = [
      { avatarId: 'default-male', gender: 'male' },
      { avatarId: 'default-female', gender: 'female' },
    ];
    const uniqueConditionImages = [...new Set(avatars.map((avatar) => this.resolveConditionImage(avatar)))];
    for (const conditionImage of uniqueConditionImages.slice(0, this.config.SOULX_PREWARM_MAX_BRIDGES)) {
      await this.ensureIdleBridge(conditionImage);
    }
  }

  async startSession(input: RuntimeStartInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) {
      return;
    }

    const mediaDir = path.join(os.tmpdir(), 'coherent-soulx', input.sessionId);
    fs.mkdirSync(mediaDir, { recursive: true });
    const conditionImage = this.resolveConditionImage(input.avatarConfig);

    const startTime = Date.now();
    const publisher = createRtcPublisher(input.publisherRtc, input.publisherOptions);
    await publisher.join();
    const publisherJoinedAt = Date.now();

    const session: RuntimeSession = {
      sessionId: input.sessionId,
      avatarConfig: input.avatarConfig,
      publisher,
      conditionImage,
      mediaDir,
      runtimeFailure: null,
      closing: false,
      frameQueue: [],
      framePump: null,
      droppedFrameCount: 0,
      queuedFrameCount: 0,
      publishedFrameCount: 0,
      startedAt: startTime,
      publisherJoinedAt,
    };

    this.sessions.set(input.sessionId, session);
    console.log(
      `[soulx-runtime:${input.sessionId}] publisher joined in ${publisherJoinedAt - startTime}ms`,
    );

    if (this.config.SOULX_RUNTIME_MODE !== 'python_bridge') {
      return;
    }

    session.bridge = await this.acquireBridge(conditionImage, input.sessionId, mediaDir);
  }

  private async handleBridgeMessage(handle: BridgeHandle, line: string): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      const target = handle.currentSessionId ?? handle.id;
      console.warn(`[soulx-bridge:${target}] non-json stdout: ${line}`);
      return;
    }

    if (payload.type === 'ready') {
      handle.readyResolve?.();
      handle.readyResolve = undefined;
      handle.readyReject = undefined;
      handle.alive = true;
      handle.failure = null;
      return;
    }

    if (payload.type === 'reset_ack') {
      handle.resetResolve?.();
      handle.resetPromise = null;
      handle.resetResolve = undefined;
      handle.resetReject = undefined;
      return;
    }

    const sessionId = handle.currentSessionId;
    if (!sessionId) {
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (payload.type === 'frames') {
      const frames = Array.isArray(payload.frames)
        ? payload.frames.filter((frame): frame is string => typeof frame === 'string')
        : [];
      if (frames.length > 0) {
        const now = Date.now();
        if (!session.firstBridgeFrameAt) {
          session.firstBridgeFrameAt = now;
          console.log(
            `[soulx-runtime:${sessionId}] first bridge frame batch after ${now - session.startedAt}ms` +
              (session.firstAudioAt
                ? ` (${now - session.firstAudioAt}ms after first audio)`
                : ''),
          );
        }
        console.log(`[soulx-bridge:${sessionId}] received ${frames.length} frame(s) from Python bridge`);
        this.enqueueFrameBatch(session, frames);
      }
      return;
    }

    if (payload.type === 'segment') {
      const rawPath = typeof payload.path === 'string' ? payload.path : '';
      const fileName = rawPath ? path.basename(rawPath) : '';
      if (!fileName) {
        return;
      }

      const absolutePath = path.join(session.mediaDir, fileName);
      console.log(
        `[soulx-bridge:${sessionId}] segment ready index=${String(payload.segmentIndex)} file=${fileName} final=${String(payload.final)}`,
      );
      this.emit('segment', {
        sessionId,
        segmentIndex:
          typeof payload.segmentIndex === 'number' && Number.isFinite(payload.segmentIndex)
            ? payload.segmentIndex
            : 0,
        fileName,
        absolutePath,
        final: Boolean(payload.final),
        durationSeconds:
          typeof payload.durationSeconds === 'number' && Number.isFinite(payload.durationSeconds)
            ? payload.durationSeconds
            : undefined,
      } satisfies SegmentReadyEvent);
      return;
    }

    if (payload.type === 'audio_end_ack') {
      handle.audioEndResolve?.();
      handle.audioEndPromise = null;
      handle.audioEndResolve = undefined;
      handle.audioEndReject = undefined;
      return;
    }

    if (payload.type === 'error') {
      const message = typeof payload.message === 'string' ? payload.message : 'Unknown SoulX bridge error.';
      if (message.startsWith('Failed to decode PCM chunk')) {
        console.warn(`[soulx-runtime:${sessionId}] ${message}`);
        return;
      }
      this.markSessionFailed(session, message);
      return;
    }

    if (payload.type === 'stats') {
      console.log(
        `[soulx-bridge:${sessionId}] stats frames=${String(payload.frames)} buffered=${String(payload.samplesBuffered)} pending=${String(payload.samplesPending)}`,
      );
    }
  }

  private enqueueFrameBatch(session: RuntimeSession, frames: string[]): void {
    if (frames.length === 0) {
      return;
    }

    while (session.frameQueue.length >= this.maxQueuedFrameBatches) {
      const dropped = session.frameQueue.shift();
      if (!dropped) {
        break;
      }
      session.droppedFrameCount += dropped.length;
      console.warn(
        `[soulx-runtime:${session.sessionId}] dropping ${dropped.length} queued frame(s); totalDropped=${session.droppedFrameCount}`,
      );
    }

    session.frameQueue.push(frames);
    session.queuedFrameCount += frames.length;
    console.log(
      `[soulx-runtime:${session.sessionId}] enqueued ${frames.length} frame(s); batches=${session.frameQueue.length} queuedFrames=${session.queuedFrameCount} publishedFrames=${session.publishedFrameCount}`,
    );

    if (!session.framePump) {
      session.framePump = this.flushFrameQueue(session)
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : 'RTC frame queue failed unexpectedly.';
          this.markSessionFailed(session, message);
        })
        .finally(() => {
          session.framePump = null;
        });
    }
  }

  private async flushFrameQueue(session: RuntimeSession): Promise<void> {
    while (!session.closing && this.sessions.has(session.sessionId) && session.frameQueue.length > 0) {
      this.ensureSessionHealthy(session);
      const frames = session.frameQueue.shift();
      if (!frames || frames.length === 0) {
        continue;
      }

      session.queuedFrameCount = Math.max(0, session.queuedFrameCount - frames.length);

      try {
        await session.publisher.publishEncodedFrames(frames);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'RTC publisher failed to consume frame batch.';
        this.markSessionFailed(session, `RTC frame publish failed: ${message}`);
        session.frameQueue.length = 0;
        throw error;
      }

      session.publishedFrameCount += frames.length;
      const now = Date.now();
      if (!session.firstRtcPublishAt) {
        session.firstRtcPublishAt = now;
        console.log(
          `[soulx-runtime:${session.sessionId}] first RTC frame batch published after ${now - session.startedAt}ms` +
            (session.firstAudioAt ? ` (${now - session.firstAudioAt}ms after first audio)` : ''),
        );
      }
      console.log(
        `[soulx-runtime:${session.sessionId}] published ${frames.length} frame(s); queuedFrames=${session.queuedFrameCount} publishedFrames=${session.publishedFrameCount} droppedFrames=${session.droppedFrameCount}`,
      );
    }
  }

  async appendAudio(
    sessionId: string,
    chunk: Buffer,
    options: {
      sequence?: number;
      pcmBase64?: string;
      sampleRate: number;
      channels: number;
      format: 'f32le' | 's16le';
    },
  ): Promise<{ totalAudioBytes: number; estimatedFrames: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}.`);
    }

    this.ensureSessionHealthy(session);
    if (!session.firstAudioAt) {
      session.firstAudioAt = Date.now();
      console.log(`[soulx-runtime:${sessionId}] first audio received`);
    }

    await session.publisher.publishAudioChunk(chunk, options);

    if (this.config.SOULX_RUNTIME_MODE === 'python_bridge') {
      if (!session.bridge) {
        throw new Error('SoulX bridge is not ready.');
      }

      await session.bridge.ready;
      this.ensureSessionHealthy(session);
      if (
        !session.bridge.alive ||
        session.bridge.process.stdin.destroyed ||
        !session.bridge.process.stdin.writable
      ) {
        throw new Error(session.bridge.failure || 'SoulX bridge is no longer available.');
      }

      const payload = `${JSON.stringify({
        type: 'audio_chunk',
        sequence: options.sequence ?? null,
        pcmBase64: options.pcmBase64 ?? chunk.toString('base64'),
        sampleRate: options.sampleRate,
        channels: options.channels,
        format: options.format,
      })}\n`;

      await new Promise<void>((resolve, reject) => {
        session.bridge!.process.stdin.write(payload, (error) => {
          if (error) {
            session.bridge!.alive = false;
            session.bridge!.failure = error.message;
            this.markSessionFailed(session, error.message);
            reject(error);
            return;
          }
          resolve();
        });
      });
      return session.publisher.getMetrics();
    }

    const estimatedFrames = Math.max(1, Math.ceil(chunk.length / 3200));
    await session.publisher.publishFrameBatch(estimatedFrames);
    return session.publisher.getMetrics();
  }

  async signalAudioEnd(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}.`);
    }

    this.ensureSessionHealthy(session);
    if (this.config.SOULX_RUNTIME_MODE !== 'python_bridge') {
      return;
    }

    if (!session.bridge) {
      throw new Error('SoulX bridge is not ready.');
    }

    await session.bridge.ready;
    this.ensureSessionHealthy(session);
    if (
      !session.bridge.alive ||
      session.bridge.process.stdin.destroyed ||
      !session.bridge.process.stdin.writable
    ) {
      throw new Error(session.bridge.failure || 'SoulX bridge is no longer available.');
    }

    if (!session.bridge.audioEndPromise) {
      session.bridge.audioEndPromise = new Promise<void>((resolve, reject) => {
        session.bridge!.audioEndResolve = resolve;
        session.bridge!.audioEndReject = reject;
      });

      const payload = `${JSON.stringify({ type: 'audio_end' })}\n`;
      await new Promise<void>((resolve, reject) => {
        session.bridge!.process.stdin.write(payload, (error) => {
          if (error) {
            session.bridge!.alive = false;
            session.bridge!.failure = error.message;
            this.markSessionFailed(session, error.message);
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    await session.bridge.audioEndPromise;
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.closing = true;

    if (session.framePump) {
      try {
        await session.framePump;
      } catch {}
    }

    await session.publisher.close();
    this.sessions.delete(sessionId);
    if (session.bridge) {
      await this.releaseBridge(session.bridge);
    }
    try {
      fs.rmSync(session.mediaDir, { recursive: true, force: true });
    } catch {}
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getMediaFilePath(sessionId: string, fileName: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const safeFileName = path.basename(fileName);
    const filePath = path.join(session.mediaDir, safeFileName);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return filePath;
  }
}
