import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AvatarConfig, RtcCredentials } from '../shared/types.js';
import { createRtcPublisher, type RtcPublisher } from './rtc-publisher.js';
import type { WorkerConfig } from '../shared/config.js';

interface RuntimeSession {
  sessionId: string;
  avatarConfig: AvatarConfig;
  publisher: RtcPublisher;
  bridge?: ChildProcessWithoutNullStreams;
  bridgeReady?: Promise<void>;
  bridgeResolve?: () => void;
  bridgeReject?: (error: Error) => void;
  bridgeAlive?: boolean;
  bridgeFailure?: string | null;
  runtimeFailure?: string | null;
  bridgeAudioEndPromise?: Promise<void> | null;
  bridgeAudioEndResolve?: () => void;
  bridgeAudioEndReject?: (error: Error) => void;
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

export class SoulxRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly maxQueuedFrameBatches = 6;

  constructor(private readonly config: WorkerConfig) {}

  private markSessionFailed(session: RuntimeSession, message: string): void {
    if (session.runtimeFailure) {
      return;
    }

    session.runtimeFailure = message;
    session.bridgeFailure = session.bridgeFailure ?? message;
    session.bridgeAlive = false;
    session.bridgeAudioEndReject?.(new Error(message));
    session.bridgeAudioEndPromise = null;
    session.bridgeAudioEndReject = undefined;
    session.bridgeAudioEndResolve = undefined;
    session.bridgeReject?.(new Error(message));
    session.bridgeReject = undefined;
    session.bridgeResolve = undefined;
    console.error(`[soulx-runtime:${session.sessionId}] ${message}`);
  }

  private ensureSessionHealthy(session: RuntimeSession): void {
    if (session.runtimeFailure) {
      throw new Error(session.runtimeFailure);
    }
    if (session.bridgeFailure && !session.bridgeAlive) {
      throw new Error(session.bridgeFailure);
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

  async startSession(input: RuntimeStartInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) {
      return;
    }

    const startTime = Date.now();
    const publisher = createRtcPublisher(input.publisherRtc, input.publisherOptions);
    await publisher.join();
    const publisherJoinedAt = Date.now();

    const session: RuntimeSession = {
      sessionId: input.sessionId,
      avatarConfig: input.avatarConfig,
      publisher,
      bridgeAlive: this.config.SOULX_RUNTIME_MODE !== 'python_bridge',
      bridgeFailure: null,
      runtimeFailure: null,
      bridgeAudioEndPromise: null,
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
        this.resolveConditionImage(input.avatarConfig),
        '--base_seed',
        String(this.config.SOULX_BASE_SEED),
        '--use_face_crop',
        this.config.SOULX_USE_FACE_CROP ? 'true' : 'false',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.env.SOULX_DIR || '/opt/SoulX-FlashHead',
      },
    );

    const readyPromise = new Promise<void>((resolve, reject) => {
      session.bridgeResolve = resolve;
      session.bridgeReject = reject;
    });

    session.bridge = bridge;
    session.bridgeReady = readyPromise;
    session.bridgeAlive = true;

    const stdout = createInterface({ input: bridge.stdout });
    stdout.on('line', (line) => {
      void this.handleBridgeMessage(session.sessionId, line);
    });

    bridge.stdin.on('error', (error) => {
      session.bridgeAlive = false;
      session.bridgeFailure = error instanceof Error ? error.message : 'SoulX bridge stdin failed.';
      if (!session.closing) {
        this.markSessionFailed(session, session.bridgeFailure);
      } else {
        console.error(`[soulx-bridge:${session.sessionId}] stdin error: ${session.bridgeFailure}`);
      }
    });

    bridge.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        console.error(`[soulx-bridge:${session.sessionId}] ${message}`);
      }
    });

    bridge.on('exit', (code, signal) => {
      session.bridgeAlive = false;
      const message =
        session.bridgeFailure ??
        `SoulX bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      session.bridgeFailure = message;
      if (this.sessions.has(session.sessionId) && !session.closing) {
        this.markSessionFailed(session, message);
        console.warn(
          `[soulx-bridge:${session.sessionId}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        );
      }
    });

    await readyPromise;
  }

  private async handleBridgeMessage(sessionId: string, line: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.warn(`[soulx-bridge:${sessionId}] non-json stdout: ${line}`);
      return;
    }

    if (payload.type === 'ready') {
      session.bridgeResolve?.();
      session.bridgeResolve = undefined;
      session.bridgeReject = undefined;
      session.bridgeAlive = true;
      session.bridgeFailure = null;
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

    if (payload.type === 'audio_end_ack') {
      session.bridgeAudioEndResolve?.();
      session.bridgeAudioEndPromise = null;
      session.bridgeAudioEndResolve = undefined;
      session.bridgeAudioEndReject = undefined;
      return;
    }

    if (payload.type === 'error') {
      const message = typeof payload.message === 'string' ? payload.message : 'Unknown SoulX bridge error.';
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
    options: { sampleRate: number; channels: number; format: 'f32le' | 's16le' },
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
      if (!session.bridge || !session.bridgeReady) {
        throw new Error('SoulX bridge is not ready.');
      }

      await session.bridgeReady;
      this.ensureSessionHealthy(session);
      if (!session.bridgeAlive || session.bridge.stdin.destroyed || !session.bridge.stdin.writable) {
        throw new Error(session.bridgeFailure || 'SoulX bridge is no longer available.');
      }

      const payload = `${JSON.stringify({
        type: 'audio_chunk',
        pcmBase64: chunk.toString('base64'),
        sampleRate: options.sampleRate,
        channels: options.channels,
        format: options.format,
      })}\n`;

      await new Promise<void>((resolve, reject) => {
        session.bridge!.stdin.write(payload, (error) => {
          if (error) {
            session.bridgeAlive = false;
            session.bridgeFailure = error.message;
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

    if (!session.bridge || !session.bridgeReady) {
      throw new Error('SoulX bridge is not ready.');
    }

    await session.bridgeReady;
    this.ensureSessionHealthy(session);
    if (!session.bridgeAlive || session.bridge.stdin.destroyed || !session.bridge.stdin.writable) {
      throw new Error(session.bridgeFailure || 'SoulX bridge is no longer available.');
    }

    if (!session.bridgeAudioEndPromise) {
      session.bridgeAudioEndPromise = new Promise<void>((resolve, reject) => {
        session.bridgeAudioEndResolve = resolve;
        session.bridgeAudioEndReject = reject;
      });

      const payload = `${JSON.stringify({ type: 'audio_end' })}\n`;
      await new Promise<void>((resolve, reject) => {
        session.bridge!.stdin.write(payload, (error) => {
          if (error) {
            session.bridgeAlive = false;
            session.bridgeFailure = error.message;
            this.markSessionFailed(session, error.message);
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    await session.bridgeAudioEndPromise;
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.closing = true;

    if (session.bridge) {
      if (!session.bridge.stdin.destroyed && session.bridge.stdin.writable) {
        try {
          session.bridge.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
        } catch {}
      }
      session.bridge.kill('SIGTERM');
    }

    if (session.framePump) {
      try {
        await session.framePump;
      } catch {}
    }

    await session.publisher.close();
    this.sessions.delete(sessionId);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }
}
