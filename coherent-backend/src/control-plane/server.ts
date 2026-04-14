import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { getControlPlaneConfig } from '../shared/config.js';
import { ServiceError } from '../shared/errors.js';
import { PostgresStore } from './db/postgres-store.js';
import { SchedulerService } from './services/scheduler-service.js';
import { SimplePodAdapter } from './adapters/simplepod.js';
import { RunpodAdapter } from './adapters/runpod.js';
import type { WorkerProvisioner } from './adapters/provider.js';
import { RtcCredentialService } from './adapters/rtc.js';

function parseAllowedCudaVersions(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const sessionCreateSchema = z.object({
  userId: z.string().optional(),
  appVersion: z.string().optional(),
  avatarConfig: z.record(z.string(), z.unknown()).optional(),
});

const registerWorkerSchema = z.object({
  workerKey: z.string(),
  provider: z.string(),
  providerInstanceId: z.string().nullable().optional(),
  region: z.string(),
  gpuModel: z.string(),
  maxSessions: z.number().int().positive(),
  publicWsUrl: z.string(),
  status: z.enum(['provisioning', 'warm', 'busy', 'draining', 'unhealthy', 'terminated']),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const heartbeatSchema = z.object({
  workerKey: z.string(),
  status: z
    .enum(['provisioning', 'warm', 'busy', 'draining', 'unhealthy', 'terminated'])
    .optional(),
  activeSessions: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const sessionTouchSchema = z.object({
  status: z.enum(['assigned', 'streaming', 'ended', 'failed']).optional(),
});

export async function buildControlPlaneServer() {
  const config = getControlPlaneConfig();
  const store = new PostgresStore(config.DATABASE_URL);
  if (config.AUTO_MIGRATE) {
    await store.initializeSchema();
  }

  const runpodProvider = new RunpodAdapter({
    baseUrl: config.RUNPOD_API_BASE_URL,
    apiKey: config.RUNPOD_API_KEY,
    templateId: config.RUNPOD_TEMPLATE_ID,
    gpuTypeIds: parseCsv(config.RUNPOD_GPU_TYPE_IDS),
    cloudType: config.RUNPOD_CLOUD_TYPE,
    allowedCudaVersions: parseCsv(config.RUNPOD_ALLOWED_CUDA_VERSIONS),
    dataCenterIds: parseCsv(config.RUNPOD_DATA_CENTER_IDS),
    countryCodes: parseCsv(config.RUNPOD_COUNTRY_CODES),
    namePrefix: config.RUNPOD_NAME_PREFIX,
  });
  const simplepodProvider = new SimplePodAdapter({
    baseUrl: config.SIMPLEPOD_API_BASE_URL,
    apiKey: config.SIMPLEPOD_API_KEY,
    templateId: config.SIMPLEPOD_TEMPLATE_ID,
    gpuModel: config.SIMPLEPOD_GPU_MODEL,
    region: config.SIMPLEPOD_REGION,
    provisionPath: config.SIMPLEPOD_PROVISION_PATH,
    allowedCudaVersions: parseAllowedCudaVersions(config.SIMPLEPOD_ALLOWED_CUDA_VERSIONS),
  });
  const provider: WorkerProvisioner = runpodProvider.isConfigured()
    ? runpodProvider
    : simplepodProvider;
  const rtc = new RtcCredentialService({
    provider: config.RTC_PROVIDER,
    endpoint: config.RTC_ENDPOINT,
    secret: config.RTC_TOKEN_SECRET,
    cloudflareApiBaseUrl: config.CLOUDFLARE_API_BASE_URL,
    cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID,
    cloudflareAppId: config.CLOUDFLARE_REALTIME_APP_ID,
    cloudflareApiToken: config.CLOUDFLARE_API_TOKEN,
    subscriberPreset: config.CLOUDFLARE_SUBSCRIBER_PRESET,
    publisherPreset: config.CLOUDFLARE_PUBLISHER_PRESET,
  });
  const scheduler = new SchedulerService(store, rtc, provider, config);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      });
      return;
    }

    app.log.error(error);
    const message = error instanceof Error ? error.message : 'Unknown server error.';
    reply.status(500).send({
      error: 'internal_error',
      message,
    });
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'control-plane',
  }));

  app.post('/sessions', async (request, reply) => {
    const body = sessionCreateSchema.parse(request.body);
    const session = await scheduler.createSession(body);
    reply.status(201).send(session);
  });

  app.get('/sessions/:sessionId', async (request, reply) => {
    const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const session = await scheduler.getSession(params.sessionId);
    if (!session) {
      reply.status(404).send({ error: 'not_found', message: 'Session not found.' });
      return;
    }
    reply.send(session);
  });

  app.post('/sessions/:sessionId/end', async (request, reply) => {
    const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const session = await scheduler.endSession(params.sessionId);
    if (!session) {
      reply.status(404).send({ error: 'not_found', message: 'Session not found.' });
      return;
    }
    reply.send(session);
  });

  app.post('/internal/workers/register', async (request, reply) => {
    const body = registerWorkerSchema.parse(request.body);
    const worker = await store.registerWorker(body);
    reply.status(201).send(worker);
  });

  app.post('/internal/workers/heartbeat', async (request, reply) => {
    const body = heartbeatSchema.parse(request.body);
    await store.heartbeatWorker(body);
    reply.status(204).send();
  });

  app.post('/internal/workers/:workerKey/unhealthy', async (request, reply) => {
    const params = z.object({ workerKey: z.string() }).parse(request.params);
    await store.markWorkerUnhealthy(params.workerKey);
    reply.status(204).send();
  });

  app.post('/internal/sessions/:sessionId/activity', async (request, reply) => {
    const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const body = sessionTouchSchema.parse(request.body);
    await store.touchSession(params.sessionId, body.status);
    reply.status(204).send();
  });

  app.addHook('onClose', async () => {
    await store.close();
  });

  return { app, config };
}
