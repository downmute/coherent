import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SchedulerService } from '../src/control-plane/services/scheduler-service.js';
import { RtcCredentialService } from '../src/control-plane/adapters/rtc.js';
import { NoCapacityError } from '../src/shared/errors.js';
import type {
  ControlPlaneConfig,
} from '../src/shared/config.js';
import type {
  RegisterWorkerRequest,
  SessionAllocation,
  SessionCreateRequest,
  SessionRecord,
  WorkerHeartbeatRequest,
  WorkerRecord,
} from '../src/shared/types.js';

class MemoryStore {
  workers: WorkerRecord[] = [];
  sessions: SessionRecord[] = [];

  async registerWorker(input: RegisterWorkerRequest): Promise<WorkerRecord> {
    const existing = this.workers.find((worker) => worker.workerKey === input.workerKey);
    const now = new Date().toISOString();
    const record: WorkerRecord = existing ?? {
      id: randomUUID(),
      workerKey: input.workerKey,
      provider: input.provider,
      providerInstanceId: input.providerInstanceId ?? null,
      region: input.region,
      gpuModel: input.gpuModel,
      status: input.status,
      maxSessions: input.maxSessions,
      activeSessions: 0,
      publicWsUrl: input.publicWsUrl,
      metadata: input.metadata ?? {},
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    };
    record.provider = input.provider;
    record.providerInstanceId = input.providerInstanceId ?? null;
    record.region = input.region;
    record.gpuModel = input.gpuModel;
    record.status = input.status;
    record.maxSessions = input.maxSessions;
    record.publicWsUrl = input.publicWsUrl;
    record.metadata = input.metadata ?? {};
    record.lastHeartbeatAt = now;
    record.updatedAt = now;
    if (!existing) {
      this.workers.push(record);
    }
    return record;
  }

  async heartbeatWorker(input: WorkerHeartbeatRequest): Promise<void> {
    const worker = this.workers.find((candidate) => candidate.workerKey === input.workerKey);
    if (!worker) return;
    worker.status = input.status ?? worker.status;
    worker.activeSessions = input.activeSessions ?? worker.activeSessions;
    worker.lastHeartbeatAt = new Date().toISOString();
  }

  async reserveWarmWorker(
    request: SessionCreateRequest,
    providerInstanceId?: string,
  ): Promise<SessionAllocation | null> {
    const worker = this.workers.find(
      (candidate) =>
        ['warm', 'busy'].includes(candidate.status) &&
        candidate.activeSessions < candidate.maxSessions &&
        (!providerInstanceId || candidate.providerInstanceId === providerInstanceId),
    );
    if (!worker) return null;
    worker.activeSessions += 1;
    worker.status = worker.activeSessions >= worker.maxSessions ? 'busy' : 'warm';
    const session: SessionRecord = {
      id: randomUUID(),
      userId: request.userId ?? null,
      workerId: worker.id,
      status: 'assigned',
      avatarConfig: request.avatarConfig ?? {},
      appMetadata: { appVersion: request.appVersion ?? null },
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastActivityAt: new Date().toISOString(),
    };
    this.sessions.push(session);
    return { session, worker: { ...worker } };
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  async endSession(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    const worker = this.workers.find((candidate) => candidate.id === session.workerId);
    if (worker) {
      worker.activeSessions = Math.max(0, worker.activeSessions - 1);
      worker.status = worker.activeSessions >= worker.maxSessions ? 'busy' : 'warm';
    }
    session.status = 'ended';
    session.endedAt = new Date().toISOString();
    return session;
  }
}

class NullProvider {
  async requestProvision(): Promise<null> {
    return null;
  }
}

const config: ControlPlaneConfig = {
  DATABASE_URL: '',
  CONTROL_PLANE_PORT: 8080,
  CONTROL_PLANE_HOST: '127.0.0.1',
  AUTO_MIGRATE: false,
  WORKER_TOKEN_SECRET: 'test-worker-secret',
  RTC_TOKEN_SECRET: 'test-rtc-secret',
  RTC_PROVIDER: 'mock',
  RTC_ENDPOINT: 'https://rtc.example.com',
  CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com/client/v4',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_REALTIME_APP_ID: '',
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_SUBSCRIBER_PRESET: 'group_call_participant',
  CLOUDFLARE_PUBLISHER_PRESET: 'group_call_host',
  SESSION_PROVISION_TIMEOUT_MS: 100,
  SESSION_PROVISION_POLL_MS: 10,
  SIMPLEPOD_API_BASE_URL: '',
  SIMPLEPOD_API_KEY: '',
  SIMPLEPOD_TEMPLATE_ID: '',
  SIMPLEPOD_GPU_MODEL: 'RTX4090',
  SIMPLEPOD_REGION: '',
  SIMPLEPOD_PROVISION_PATH: '/instances',
};

describe('SchedulerService', () => {
  it('allocates a warm worker and returns worker and RTC credentials', async () => {
    const store = new MemoryStore();
    await store.registerWorker({
      workerKey: 'worker-1',
      provider: 'manual',
      providerInstanceId: 'instance-1',
      region: 'local',
      gpuModel: 'RTX4090',
      maxSessions: 2,
      publicWsUrl: 'ws://worker-1/ws',
      status: 'warm',
    });

    const scheduler = new SchedulerService(
      store as never,
      new RtcCredentialService({
        provider: 'mock',
        endpoint: 'https://rtc.example.com',
        secret: config.RTC_TOKEN_SECRET,
        cloudflareApiBaseUrl: config.CLOUDFLARE_API_BASE_URL,
        cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID,
        cloudflareAppId: config.CLOUDFLARE_REALTIME_APP_ID,
        cloudflareApiToken: config.CLOUDFLARE_API_TOKEN,
        subscriberPreset: config.CLOUDFLARE_SUBSCRIBER_PRESET,
        publisherPreset: config.CLOUDFLARE_PUBLISHER_PRESET,
      }),
      new NullProvider() as never,
      config,
    );

    const response = await scheduler.createSession({
      userId: 'user-1',
      avatarConfig: { avatarId: 'default-female' },
    });

    expect(response.status).toBe('assigned');
    expect(response.workerWsUrl).toBe('ws://worker-1/ws');
    expect(response.workerToken.length).toBeGreaterThan(20);
    expect(response.rtcCredentials.role).toBe('subscriber');
  });

  it('releases worker capacity when a session ends', async () => {
    const store = new MemoryStore();
    const worker = await store.registerWorker({
      workerKey: 'worker-1',
      provider: 'manual',
      providerInstanceId: 'instance-1',
      region: 'local',
      gpuModel: 'RTX4090',
      maxSessions: 1,
      publicWsUrl: 'ws://worker-1/ws',
      status: 'warm',
    });

    const scheduler = new SchedulerService(
      store as never,
      new RtcCredentialService({
        provider: 'mock',
        endpoint: 'https://rtc.example.com',
        secret: config.RTC_TOKEN_SECRET,
        cloudflareApiBaseUrl: config.CLOUDFLARE_API_BASE_URL,
        cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID,
        cloudflareAppId: config.CLOUDFLARE_REALTIME_APP_ID,
        cloudflareApiToken: config.CLOUDFLARE_API_TOKEN,
        subscriberPreset: config.CLOUDFLARE_SUBSCRIBER_PRESET,
        publisherPreset: config.CLOUDFLARE_PUBLISHER_PRESET,
      }),
      new NullProvider() as never,
      config,
    );

    const response = await scheduler.createSession({ userId: 'user-1' });
    expect(store.workers[0]?.activeSessions).toBe(1);
    expect(store.workers[0]?.status).toBe('busy');

    await scheduler.endSession(response.sessionId);
    expect(store.workers[0]?.id).toBe(worker.id);
    expect(store.workers[0]?.activeSessions).toBe(0);
    expect(store.workers[0]?.status).toBe('warm');
  });

  it('throws when there is no warm worker and provisioning is unavailable', async () => {
    const store = new MemoryStore();
    const scheduler = new SchedulerService(
      store as never,
      new RtcCredentialService({
        provider: 'mock',
        endpoint: 'https://rtc.example.com',
        secret: config.RTC_TOKEN_SECRET,
        cloudflareApiBaseUrl: config.CLOUDFLARE_API_BASE_URL,
        cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID,
        cloudflareAppId: config.CLOUDFLARE_REALTIME_APP_ID,
        cloudflareApiToken: config.CLOUDFLARE_API_TOKEN,
        subscriberPreset: config.CLOUDFLARE_SUBSCRIBER_PRESET,
        publisherPreset: config.CLOUDFLARE_PUBLISHER_PRESET,
      }),
      new NullProvider() as never,
      config,
    );

    await expect(scheduler.createSession({ userId: 'user-1' })).rejects.toBeInstanceOf(
      NoCapacityError,
    );
  });
});
