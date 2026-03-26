import type { AvatarConfig, CreateSessionResponse, RegisterWorkerRequest, RtcCredentials, SessionRecord, SessionStatus, WorkerRecord, WorkerStatus, WorkerTokenPayload } from '../shared/types.js';
import type { D1Database } from './cloudflare-types.js';

interface Env {
  DB: D1Database;
  WORKER_TOKEN_SECRET: string;
  RTC_PROVIDER: 'mock' | 'cloudflare';
  RTC_ENDPOINT: string;
  RTC_TOKEN_SECRET?: string;
  CLOUDFLARE_API_BASE_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_REALTIME_APP_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_SUBSCRIBER_PRESET: string;
  CLOUDFLARE_PUBLISHER_PRESET: string;
  SIMPLEPOD_API_BASE_URL?: string;
  SIMPLEPOD_API_KEY?: string;
  SIMPLEPOD_TEMPLATE_ID?: string;
  SIMPLEPOD_GPU_MODEL?: string;
  SIMPLEPOD_REGION?: string;
  SIMPLEPOD_PROVISION_PATH?: string;
  SESSION_PROVISION_TIMEOUT_MS?: string;
  SESSION_PROVISION_POLL_MS?: string;
}

interface SessionCreateRequest {
  userId?: string;
  appVersion?: string;
  avatarConfig?: AvatarConfig;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function json(data: JsonValue, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

function randomId(): string {
  return crypto.randomUUID();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signToken(payload: object, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeBase64Url(encoder.encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const body = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const signature = encodeBase64Url(new Uint8Array(signatureBuffer));
  return `${body}.${signature}`;
}

function parseJsonText(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapWorker(row: Record<string, unknown>): WorkerRecord {
  return {
    id: String(row.id),
    workerKey: String(row.worker_key),
    provider: String(row.provider),
    providerInstanceId: row.provider_instance_id ? String(row.provider_instance_id) : null,
    region: String(row.region),
    gpuModel: String(row.gpu_model),
    status: String(row.status) as WorkerStatus,
    maxSessions: Number(row.max_sessions),
    activeSessions: Number(row.active_sessions),
    publicWsUrl: String(row.public_ws_url),
    metadata: parseJsonText(row.metadata ? String(row.metadata) : '{}'),
    lastHeartbeatAt: String(row.last_heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    workerId: String(row.worker_id),
    status: String(row.status) as SessionStatus,
    avatarConfig: parseJsonText(row.avatar_config ? String(row.avatar_config) : '{}'),
    appMetadata: parseJsonText(row.app_metadata ? String(row.app_metadata) : '{}'),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    lastActivityAt: String(row.last_activity_at),
  };
}

function extractPath(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

async function issueMockRtcPair(env: Env, sessionId: string): Promise<{ subscriber: RtcCredentials; publisher: RtcCredentials }> {
  const issue = async (role: 'publisher' | 'subscriber'): Promise<RtcCredentials> => ({
    provider: 'mock',
    roomId: sessionId,
    role,
    token: await signToken(
      {
        sessionId,
        role,
        provider: 'mock',
        exp: Math.floor(Date.now() / 1000) + 60 * 15,
      },
      env.RTC_TOKEN_SECRET || 'rtc-secret',
    ),
    endpoint: env.RTC_ENDPOINT,
  });

  return {
    subscriber: await issue('subscriber'),
    publisher: await issue('publisher'),
  };
}

async function createCloudflareMeeting(env: Env): Promise<string> {
  const response = await fetch(
    `${env.CLOUDFLARE_API_BASE_URL}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.CLOUDFLARE_REALTIME_APP_ID}/meetings`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: `Coherent Session ${randomId().slice(0, 8)}`,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloudflare meeting creation failed with HTTP ${response.status}: ${body}`);
  }

  const json = (await response.json()) as { data?: { id?: string } };
  const meetingId = json.data?.id;
  if (!meetingId) {
    throw new Error('Cloudflare meeting creation did not return a meeting ID.');
  }

  return meetingId;
}

async function addCloudflareParticipant(
  env: Env,
  meetingId: string,
  role: 'publisher' | 'subscriber',
  presetName: string,
  name: string,
): Promise<RtcCredentials> {
  const response = await fetch(
    `${env.CLOUDFLARE_API_BASE_URL}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.CLOUDFLARE_REALTIME_APP_ID}/meetings/${meetingId}/participants`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        custom_participant_id: randomId(),
        preset_name: presetName,
        name,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloudflare addParticipant failed with HTTP ${response.status}: ${body}`);
  }

  const json = (await response.json()) as { data?: { id?: string; token?: string } };
  if (!json.data?.id || !json.data.token) {
    throw new Error('Cloudflare participant response was missing participant ID or token.');
  }

  return {
    provider: 'cloudflare',
    roomId: meetingId,
    role,
    token: json.data.token,
    endpoint: env.RTC_ENDPOINT,
    appId: env.CLOUDFLARE_REALTIME_APP_ID,
    meetingId,
    participantId: json.data.id,
    presetName,
  };
}

async function issueRtcPair(env: Env, sessionId: string): Promise<{ subscriber: RtcCredentials; publisher: RtcCredentials }> {
  if (env.RTC_PROVIDER !== 'cloudflare') {
    return issueMockRtcPair(env, sessionId);
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_REALTIME_APP_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Cloudflare RTC is enabled but account/app/token env vars are missing.');
  }

  const meetingId = await createCloudflareMeeting(env);
  const subscriber = await addCloudflareParticipant(
    env,
    meetingId,
    'subscriber',
    env.CLOUDFLARE_SUBSCRIBER_PRESET || 'group_call_participant',
    `app-${sessionId}`,
  );
  const publisher = await addCloudflareParticipant(
    env,
    meetingId,
    'publisher',
    env.CLOUDFLARE_PUBLISHER_PRESET || 'group_call_host',
    `worker-${sessionId}`,
  );

  return { subscriber, publisher };
}

async function insertEvent(env: Env, sessionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session_events (id, session_id, type, payload, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(randomId(), sessionId, type, JSON.stringify(payload))
    .run();
}

async function reserveWarmWorker(env: Env, request: SessionCreateRequest, providerInstanceId?: string): Promise<{ worker: WorkerRecord; session: SessionRecord } | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const query = providerInstanceId
      ? `
        SELECT * FROM gpu_workers
        WHERE status IN ('warm', 'busy')
          AND active_sessions < max_sessions
          AND provider_instance_id = ?
        ORDER BY active_sessions ASC, updated_at ASC
        LIMIT 1
      `
      : `
        SELECT * FROM gpu_workers
        WHERE status IN ('warm', 'busy')
          AND active_sessions < max_sessions
        ORDER BY active_sessions ASC, updated_at ASC
        LIMIT 1
      `;

    const row = providerInstanceId
      ? await env.DB.prepare(query).bind(providerInstanceId).first<Record<string, unknown>>()
      : await env.DB.prepare(query).first<Record<string, unknown>>();

    if (!row) {
      return null;
    }

    const worker = mapWorker(row);
    const nextStatus = worker.activeSessions + 1 >= worker.maxSessions ? 'busy' : 'warm';
    const updateResult = await env.DB.prepare(
      `
      UPDATE gpu_workers
      SET
        active_sessions = active_sessions + 1,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status IN ('warm', 'busy')
        AND active_sessions < max_sessions
      `,
    )
      .bind(nextStatus, worker.id)
      .run();

    if ((updateResult.meta.changes ?? 0) < 1) {
      continue;
    }

    const sessionId = randomId();
    await env.DB.prepare(
      `
      INSERT INTO sessions (
        id, user_id, worker_id, status, avatar_config, app_metadata, started_at, last_activity_at
      ) VALUES (?, ?, ?, 'assigned', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    )
      .bind(
        sessionId,
        request.userId ?? null,
        worker.id,
        JSON.stringify(request.avatarConfig ?? {}),
        JSON.stringify({ appVersion: request.appVersion ?? null }),
      )
      .run();
    await insertEvent(env, sessionId, 'session.assigned', { workerId: worker.id, workerKey: worker.workerKey });

    const sessionRow = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(sessionId).first<Record<string, unknown>>();
    const updatedWorkerRow = await env.DB.prepare(`SELECT * FROM gpu_workers WHERE id = ?`).bind(worker.id).first<Record<string, unknown>>();
    if (!sessionRow || !updatedWorkerRow) {
      throw new Error('Failed to fetch newly created session or worker.');
    }

    return {
      session: mapSession(sessionRow),
      worker: mapWorker(updatedWorkerRow),
    };
  }

  return null;
}

async function requestSimplePodProvision(env: Env, metadata: Record<string, unknown>): Promise<string | null> {
  if (!env.SIMPLEPOD_API_BASE_URL || !env.SIMPLEPOD_API_KEY || !env.SIMPLEPOD_TEMPLATE_ID) {
    return null;
  }

  const response = await fetch(
    `${env.SIMPLEPOD_API_BASE_URL.replace(/\/$/, '')}${env.SIMPLEPOD_PROVISION_PATH || '/instances'}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SIMPLEPOD_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        templateId: env.SIMPLEPOD_TEMPLATE_ID,
        gpuModel: env.SIMPLEPOD_GPU_MODEL || 'RTX4090',
        region: env.SIMPLEPOD_REGION || undefined,
        metadata,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`SimplePod provisioning failed with HTTP ${response.status}.`);
  }

  const json = (await response.json()) as { instanceId?: string; id?: string };
  return json.instanceId || json.id || null;
}

async function createSession(env: Env, request: SessionCreateRequest): Promise<CreateSessionResponse> {
  let allocation = await reserveWarmWorker(env, request);

  if (!allocation) {
    const providerInstanceId = await requestSimplePodProvision(env, {
      requestedAt: new Date().toISOString(),
      avatarConfig: request.avatarConfig ?? {},
    });

    if (!providerInstanceId) {
      throw new Error('No warm worker is available and SimplePod provisioning is not configured.');
    }

    const timeoutMs = Number(env.SESSION_PROVISION_TIMEOUT_MS || '30000');
    const pollMs = Number(env.SESSION_PROVISION_POLL_MS || '2000');
    const deadline = Date.now() + timeoutMs;

    while (!allocation && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      allocation = await reserveWarmWorker(env, request, providerInstanceId);
    }

    if (!allocation) {
      throw new Error('Provisioning started but no warm worker became ready in time.');
    }
  }

  const rtcPair = await issueRtcPair(env, allocation.session.id);
  const workerPayload: WorkerTokenPayload = {
    sessionId: allocation.session.id,
    workerKey: allocation.worker.workerKey,
    avatarConfig: allocation.session.avatarConfig,
    publisherRtc: rtcPair.publisher,
    exp: Math.floor(Date.now() / 1000) + 60 * 15,
  };

  return {
    sessionId: allocation.session.id,
    workerWsUrl: allocation.worker.publicWsUrl,
    workerToken: await signToken(workerPayload, env.WORKER_TOKEN_SECRET),
    rtcCredentials: rtcPair.subscriber,
    status: 'assigned',
  };
}

async function getSession(env: Env, sessionId: string): Promise<SessionRecord | null> {
  const row = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(sessionId).first<Record<string, unknown>>();
  return row ? mapSession(row) : null;
}

async function endSession(env: Env, sessionId: string, reason = 'ended'): Promise<SessionRecord | null> {
  const session = await getSession(env, sessionId);
  if (!session) return null;
  if (session.status !== 'ended') {
    const workerRow = await env.DB.prepare(`SELECT * FROM gpu_workers WHERE id = ?`).bind(session.workerId).first<Record<string, unknown>>();
    if (workerRow) {
      const worker = mapWorker(workerRow);
      const nextActive = Math.max(0, worker.activeSessions - 1);
      const nextStatus =
        worker.status === 'unhealthy' || worker.status === 'terminated'
          ? worker.status
          : nextActive >= worker.maxSessions
            ? 'busy'
            : 'warm';

      await env.DB.prepare(
        `UPDATE gpu_workers SET active_sessions = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
        .bind(nextActive, nextStatus, worker.id)
        .run();
    }

    await env.DB.prepare(
      `UPDATE sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(sessionId)
      .run();
    await insertEvent(env, sessionId, 'session.ended', { reason });
  }

  return getSession(env, sessionId);
}

async function registerWorker(env: Env, request: RegisterWorkerRequest): Promise<WorkerRecord> {
  const id = randomId();
  await env.DB.prepare(
    `
    INSERT INTO gpu_workers (
      id, worker_key, provider, provider_instance_id, region, gpu_model, status, max_sessions, active_sessions, public_ws_url, metadata, last_heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(worker_key) DO UPDATE SET
      provider = excluded.provider,
      provider_instance_id = excluded.provider_instance_id,
      region = excluded.region,
      gpu_model = excluded.gpu_model,
      status = excluded.status,
      max_sessions = excluded.max_sessions,
      public_ws_url = excluded.public_ws_url,
      metadata = excluded.metadata,
      last_heartbeat_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    `,
  )
    .bind(
      id,
      request.workerKey,
      request.provider,
      request.providerInstanceId ?? null,
      request.region,
      request.gpuModel,
      request.status,
      request.maxSessions,
      request.publicWsUrl,
      JSON.stringify(request.metadata ?? {}),
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM gpu_workers WHERE worker_key = ?`).bind(request.workerKey).first<Record<string, unknown>>();
  if (!row) {
    throw new Error('Failed to register worker.');
  }
  return mapWorker(row);
}

async function heartbeatWorker(env: Env, body: { workerKey: string; status?: WorkerStatus; activeSessions?: number; metadata?: Record<string, unknown> }): Promise<void> {
  const existing = await env.DB.prepare(`SELECT * FROM gpu_workers WHERE worker_key = ?`).bind(body.workerKey).first<Record<string, unknown>>();
  if (!existing) return;
  const worker = mapWorker(existing);
  await env.DB.prepare(
    `
    UPDATE gpu_workers
    SET
      status = ?,
      active_sessions = ?,
      metadata = ?,
      last_heartbeat_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE worker_key = ?
    `,
  )
    .bind(
      body.status ?? worker.status,
      body.activeSessions ?? worker.activeSessions,
      JSON.stringify(body.metadata ?? worker.metadata),
      body.workerKey,
    )
    .run();
}

async function markWorkerUnhealthy(env: Env, workerKey: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE gpu_workers SET status = 'unhealthy', updated_at = CURRENT_TIMESTAMP WHERE worker_key = ?`,
  )
    .bind(workerKey)
    .run();
}

async function touchSession(env: Env, sessionId: string, status?: SessionStatus): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET status = COALESCE(?, status), last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(status ?? null, sessionId)
    .run();
}

async function parseBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-fA-F-]{8,}$/.test(value);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = extractPath(url);

    if (request.method === 'OPTIONS') {
      return noContent();
    }

    try {
      if (request.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        return json({ ok: true, service: 'control-plane-cloudflare' });
      }

      if (request.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') {
        const body = await parseBody<SessionCreateRequest>(request);
        const response = await createSession(env, body);
        return json(response as unknown as JsonValue, { status: 201 });
      }

      if (parts.length === 2 && parts[0] === 'sessions' && isUuidLike(parts[1])) {
        if (request.method === 'GET') {
          const session = await getSession(env, parts[1]);
          return session
            ? json(session as unknown as JsonValue)
            : json({ error: 'not_found', message: 'Session not found.' }, { status: 404 });
        }
      }

      if (parts.length === 3 && parts[0] === 'sessions' && isUuidLike(parts[1]) && parts[2] === 'end' && request.method === 'POST') {
        const session = await endSession(env, parts[1], 'api.end');
        return session
          ? json(session as unknown as JsonValue)
          : json({ error: 'not_found', message: 'Session not found.' }, { status: 404 });
      }

      if (parts.length === 3 && parts[0] === 'internal' && parts[1] === 'workers' && parts[2] === 'register' && request.method === 'POST') {
        const body = await parseBody<RegisterWorkerRequest>(request);
        const worker = await registerWorker(env, body);
        return json(worker as unknown as JsonValue, { status: 201 });
      }

      if (parts.length === 3 && parts[0] === 'internal' && parts[1] === 'workers' && parts[2] === 'heartbeat' && request.method === 'POST') {
        const body = await parseBody<{ workerKey: string; status?: WorkerStatus; activeSessions?: number; metadata?: Record<string, unknown> }>(request);
        await heartbeatWorker(env, body);
        return noContent();
      }

      if (parts.length === 4 && parts[0] === 'internal' && parts[1] === 'workers' && parts[3] === 'unhealthy' && request.method === 'POST') {
        await markWorkerUnhealthy(env, parts[2]);
        return noContent();
      }

      if (parts.length === 4 && parts[0] === 'internal' && parts[1] === 'sessions' && parts[3] === 'activity' && request.method === 'POST') {
        const body = await parseBody<{ status?: SessionStatus }>(request);
        await touchSession(env, parts[2], body.status);
        return noContent();
      }

      return json({ error: 'not_found', message: 'Route not found.' }, { status: 404 });
    } catch (error) {
      return json(
        {
          error: 'internal_error',
          message: error instanceof Error ? error.message : 'Unknown error.',
        },
        { status: 500 },
      );
    }
  },
};
