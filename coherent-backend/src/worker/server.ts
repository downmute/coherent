import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import { z } from 'zod';
import { getWorkerConfig } from '../shared/config.js';
import { verifyToken } from '../shared/token.js';
import type {
  ClientToWorkerMessage,
  WorkerToClientMessage,
  WorkerTokenPayload,
} from '../shared/types.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { resolveWorkerIdentity, resolveWorkerPublicWsUrl } from './public-url.js';
import { SoulxRuntime } from './soulx-runtime.js';

const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.start'),
    sessionId: z.string().uuid(),
    workerToken: z.string().optional(),
  }),
  z.object({
    type: z.literal('audio.append'),
    sequence: z.number().int().nonnegative(),
    pcmBase64: z.string(),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
    format: z.enum(['f32le', 's16le']).optional(),
  }),
  z.object({
    type: z.literal('audio.end'),
  }),
  z.object({
    type: z.literal('session.stop'),
  }),
  z.object({
    type: z.literal('heartbeat'),
  }),
]);

function send(socket: { send: (payload: string) => void }, message: WorkerToClientMessage) {
  socket.send(JSON.stringify(message));
}

function getPublicHttpBaseUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function buildWorkerServer() {
  const rawConfig = getWorkerConfig();
  const workerIdentity = resolveWorkerIdentity(rawConfig);
  const config = {
    ...rawConfig,
    WORKER_KEY: workerIdentity.workerKey,
    WORKER_PROVIDER_INSTANCE_ID: workerIdentity.providerInstanceId,
  };
  const controlPlaneClient = new ControlPlaneClient(config);
  const runtime = new SoulxRuntime(config);
  const app = Fastify({ logger: true });
  await app.register(websocket);
  const publicWs = resolveWorkerPublicWsUrl(config);
  app.log.info(
    {
      source: publicWs.source,
      workerKeySource: workerIdentity.workerKeySource,
      providerInstanceIdSource: workerIdentity.providerInstanceIdSource,
      workerKey: config.WORKER_KEY,
      providerInstanceId: config.WORKER_PROVIDER_INSTANCE_ID || null,
      publicWsUrl: publicWs.url,
    },
    'Resolved worker public websocket URL.',
  );

  const registerPayload = {
    workerKey: config.WORKER_KEY,
    provider: config.WORKER_PROVIDER,
    providerInstanceId: config.WORKER_PROVIDER_INSTANCE_ID || null,
    region: config.WORKER_REGION,
    gpuModel: config.WORKER_GPU_MODEL,
    maxSessions: config.WORKER_MAX_SESSIONS,
    publicWsUrl: publicWs.url,
    status: 'warm' as const,
    metadata: {},
  };

  app.get('/health', async () => ({
    ok: true,
    service: 'worker',
    workerKey: config.WORKER_KEY,
    activeSessions: runtime.getActiveSessionCount(),
  }));

  app.get('/media/:sessionId/:fileName', async (request, reply) => {
    const params = z
      .object({
        sessionId: z.string().uuid(),
        fileName: z.string().min(1),
      })
      .parse(request.params);

    const filePath = runtime.getMediaFilePath(params.sessionId, params.fileName);
    if (!filePath) {
      return reply.code(404).send({ error: 'media_not_found' });
    }

    reply.type('video/mp4');
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const query = z
      .object({
        token: z.string().optional(),
      })
      .parse(request.query);

    let sessionPayload: WorkerTokenPayload | null = null;
    if (query.token) {
      try {
        sessionPayload = verifyToken<WorkerTokenPayload>(query.token, config.WORKER_TOKEN_SECRET);
      } catch (error) {
        send(socket, {
          type: 'error',
          code: 'invalid_token',
          message: error instanceof Error ? error.message : 'Invalid worker token.',
        });
        socket.close();
        return;
      }
    }

    const handleSegment = (event: import('./soulx-runtime.js').SegmentReadyEvent) => {
      if (!sessionPayload || event.sessionId !== sessionPayload.sessionId) {
        return;
      }

      send(socket, {
        type: 'video.segment',
        sessionId: event.sessionId,
        segmentIndex: event.segmentIndex,
        url: `${getPublicHttpBaseUrl(publicWs.url)}/media/${event.sessionId}/${encodeURIComponent(event.fileName)}`,
        final: event.final,
        durationSeconds: event.durationSeconds,
      });
    };

    runtime.on('segment', handleSegment);

    socket.on('message', async (raw: Buffer) => {
      try {
        const parsed = messageSchema.parse(
          JSON.parse(raw.toString()),
        ) as ClientToWorkerMessage;

        if (parsed.type === 'session.start') {
          const token = parsed.workerToken ?? query.token;
          if (!token) {
            send(socket, {
              type: 'error',
              code: 'missing_token',
              message: 'A worker token is required to start a session.',
            });
            return;
          }

          const payload = verifyToken<WorkerTokenPayload>(token, config.WORKER_TOKEN_SECRET);
          if (payload.workerKey !== config.WORKER_KEY || payload.sessionId !== parsed.sessionId) {
            send(socket, {
              type: 'error',
              code: 'session_mismatch',
              message: 'Token/session mismatch for this worker.',
            });
            return;
          }

          sessionPayload = payload;
          await runtime.startSession({
            sessionId: payload.sessionId,
            avatarConfig: payload.avatarConfig,
            publisherRtc: payload.publisherRtc,
            publisherOptions: {
              mode:
                config.SOULX_DELIVERY_MODE === 'segment_mp4' ? 'mock' : config.WORKER_RTC_PUBLISHER,
              browserExecutablePath: config.WORKER_BROWSER_EXECUTABLE_PATH,
              headless: config.WORKER_RTC_HEADLESS,
              width: config.WORKER_RTC_VIEWPORT_WIDTH,
              height: config.WORKER_RTC_VIEWPORT_HEIGHT,
              fps: config.WORKER_RTC_FPS,
            },
          });
          await controlPlaneClient.touchSession(payload.sessionId, 'streaming');
          send(socket, {
            type: 'session.ready',
            sessionId: payload.sessionId,
            provider: payload.publisherRtc.provider,
          });
          return;
        }

        if (!sessionPayload) {
          send(socket, {
            type: 'error',
            code: 'session_not_started',
            message: 'Send session.start before any audio messages.',
          });
          return;
        }

        if (parsed.type === 'audio.append') {
          const bytes = Buffer.from(parsed.pcmBase64, 'base64');
          const metrics = await runtime.appendAudio(sessionPayload.sessionId, bytes, {
            sampleRate: parsed.sampleRate,
            channels: parsed.channels,
            format: parsed.format ?? 'f32le',
          });
          await controlPlaneClient.touchSession(sessionPayload.sessionId, 'streaming');
          send(socket, {
            type: 'audio.ack',
            sessionId: sessionPayload.sessionId,
            sequence: parsed.sequence,
            totalAudioBytes: metrics.totalAudioBytes,
            estimatedFrames: metrics.estimatedFrames,
          });
          return;
        }

        if (parsed.type === 'audio.end') {
          await runtime.signalAudioEnd(sessionPayload.sessionId);
          await controlPlaneClient.touchSession(sessionPayload.sessionId, 'streaming');
          send(socket, {
            type: 'heartbeat.ack',
            sessionId: sessionPayload.sessionId,
            active: true,
          });
          return;
        }

        if (parsed.type === 'heartbeat') {
          send(socket, {
            type: 'heartbeat.ack',
            sessionId: sessionPayload.sessionId,
            active: true,
          });
          return;
        }

        if (parsed.type === 'session.stop') {
          await runtime.stopSession(sessionPayload.sessionId);
          await controlPlaneClient.endSession(sessionPayload.sessionId);
          send(socket, {
            type: 'session.stopped',
            sessionId: sessionPayload.sessionId,
          });
          socket.close();
        }
      } catch (error) {
        if (sessionPayload) {
          send(socket, {
            type: 'session.error',
            sessionId: sessionPayload.sessionId,
            code: 'worker_error',
            message: error instanceof Error ? error.message : 'Worker failed to process session message.',
            recoverable: false,
          });
          return;
        }

        send(socket, {
          type: 'error',
          code: 'worker_error',
          message: error instanceof Error ? error.message : 'Worker failed to process message.',
        });
      }
    });

    socket.on('close', () => {
      runtime.off('segment', handleSegment);
      if (!sessionPayload) {
        return;
      }

      void runtime
        .stopSession(sessionPayload.sessionId)
        .then(() => controlPlaneClient.endSession(sessionPayload!.sessionId))
        .catch((error) => {
          request.log.error(error, 'Failed to clean up closed worker session.');
        });
    });
  });

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let registerRetryTimer: NodeJS.Timeout | null = null;
  let registeredWithControlPlane = false;

  app.addHook('onReady', async () => {
    await runtime.prewarmCommonBridges();
  });

  app.addHook('onListen', async () => {
    const registerWorker = async () => {
      try {
        await controlPlaneClient.registerWorker(registerPayload);
        registeredWithControlPlane = true;
        app.log.info(
          {
            workerKey: config.WORKER_KEY,
            providerInstanceId: config.WORKER_PROVIDER_INSTANCE_ID || null,
          },
          'Worker registered with control plane.',
        );
      } catch (error) {
        registeredWithControlPlane = false;
        app.log.warn(error, 'Worker registration failed; retrying.');
        registerRetryTimer = setTimeout(() => {
          void registerWorker();
        }, Math.max(5000, config.WORKER_HEARTBEAT_MS));
      }
    };

    await registerWorker();

    heartbeatTimer = setInterval(() => {
      if (!registeredWithControlPlane) {
        return;
      }

      void controlPlaneClient
        .heartbeat({
          status: runtime.getActiveSessionCount() >= config.WORKER_MAX_SESSIONS ? 'busy' : 'warm',
          activeSessions: runtime.getActiveSessionCount(),
        })
        .catch((error) => {
          registeredWithControlPlane = false;
          app.log.warn(error, 'Worker heartbeat failed; re-registering.');
          if (!registerRetryTimer) {
            registerRetryTimer = setTimeout(() => {
              registerRetryTimer = null;
              void registerWorker();
            }, Math.max(5000, config.WORKER_HEARTBEAT_MS));
          }
        });
    }, config.WORKER_HEARTBEAT_MS);
  });

  app.addHook('onClose', async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (registerRetryTimer) {
      clearTimeout(registerRetryTimer);
    }
  });

  return { app, config };
}
