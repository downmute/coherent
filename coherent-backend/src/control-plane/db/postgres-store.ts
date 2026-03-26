import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  AvatarConfig,
  RegisterWorkerRequest,
  SessionAllocation,
  SessionCreateRequest,
  SessionRecord,
  SessionStatus,
  WorkerHeartbeatRequest,
  WorkerRecord,
  WorkerStatus,
} from '../../shared/types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gpu_workers (
  id UUID PRIMARY KEY,
  worker_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_instance_id TEXT UNIQUE,
  region TEXT NOT NULL,
  gpu_model TEXT NOT NULL,
  status TEXT NOT NULL,
  max_sessions INTEGER NOT NULL,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  public_ws_url TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id TEXT,
  worker_id UUID NOT NULL REFERENCES gpu_workers(id),
  status TEXT NOT NULL,
  avatar_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  app_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function mapWorker(row: Record<string, unknown>): WorkerRecord {
  return {
    id: String(row.id),
    workerKey: String(row.worker_key),
    provider: String(row.provider),
    providerInstanceId:
      row.provider_instance_id === null ? null : String(row.provider_instance_id),
    region: String(row.region),
    gpuModel: String(row.gpu_model),
    status: row.status as WorkerStatus,
    maxSessions: Number(row.max_sessions),
    activeSessions: Number(row.active_sessions),
    publicWsUrl: String(row.public_ws_url),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    lastHeartbeatAt: new Date(String(row.last_heartbeat_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: row.user_id === null ? null : String(row.user_id),
    workerId: String(row.worker_id),
    status: row.status as SessionStatus,
    avatarConfig: (row.avatar_config as AvatarConfig) ?? {},
    appMetadata: (row.app_metadata as Record<string, unknown>) ?? {},
    startedAt: new Date(String(row.started_at)).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(String(row.ended_at)).toISOString(),
    lastActivityAt: new Date(String(row.last_activity_at)).toISOString(),
  };
}

export class PostgresStore {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async initializeSchema(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async registerWorker(input: RegisterWorkerRequest): Promise<WorkerRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO gpu_workers (
        id, worker_key, provider, provider_instance_id, region, gpu_model, status, max_sessions, public_ws_url, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (worker_key) DO UPDATE SET
        provider = EXCLUDED.provider,
        provider_instance_id = EXCLUDED.provider_instance_id,
        region = EXCLUDED.region,
        gpu_model = EXCLUDED.gpu_model,
        status = EXCLUDED.status,
        max_sessions = EXCLUDED.max_sessions,
        public_ws_url = EXCLUDED.public_ws_url,
        metadata = EXCLUDED.metadata,
        last_heartbeat_at = NOW(),
        updated_at = NOW()
      RETURNING *;
      `,
      [
        randomUUID(),
        input.workerKey,
        input.provider,
        input.providerInstanceId ?? null,
        input.region,
        input.gpuModel,
        input.status,
        input.maxSessions,
        input.publicWsUrl,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return mapWorker(result.rows[0]);
  }

  async heartbeatWorker(input: WorkerHeartbeatRequest): Promise<void> {
    await this.pool.query(
      `
      UPDATE gpu_workers
      SET
        status = COALESCE($2, status),
        active_sessions = COALESCE($3, active_sessions),
        metadata = CASE WHEN $4::jsonb IS NULL THEN metadata ELSE $4::jsonb END,
        last_heartbeat_at = NOW(),
        updated_at = NOW()
      WHERE worker_key = $1;
      `,
      [
        input.workerKey,
        input.status ?? null,
        input.activeSessions ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(`SELECT * FROM sessions WHERE id = $1;`, [sessionId]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async touchSession(sessionId: string, status?: SessionStatus): Promise<void> {
    await this.pool.query(
      `
      UPDATE sessions
      SET
        status = COALESCE($2, status),
        last_activity_at = NOW()
      WHERE id = $1;
      `,
      [sessionId, status ?? null],
    );
  }

  async markWorkerUnhealthy(workerKey: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE gpu_workers
      SET status = 'unhealthy', updated_at = NOW()
      WHERE worker_key = $1;
      `,
      [workerKey],
    );
  }

  async endSession(sessionId: string, reason = 'ended'): Promise<SessionRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sessionRes = await client.query(
        `SELECT * FROM sessions WHERE id = $1 FOR UPDATE;`,
        [sessionId],
      );

      if (sessionRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const session = mapSession(sessionRes.rows[0]);
      if (session.status === 'ended') {
        await client.query('ROLLBACK');
        return session;
      }

      const workerRes = await client.query(
        `SELECT * FROM gpu_workers WHERE id = $1 FOR UPDATE;`,
        [session.workerId],
      );

      if ((workerRes.rowCount ?? 0) > 0) {
        const worker = mapWorker(workerRes.rows[0]);
        const nextActive = Math.max(0, worker.activeSessions - 1);
        const nextStatus: WorkerStatus =
          worker.status === 'terminated' || worker.status === 'unhealthy'
            ? worker.status
            : nextActive >= worker.maxSessions
              ? 'busy'
              : 'warm';

        await client.query(
          `
          UPDATE gpu_workers
          SET active_sessions = $2, status = $3, updated_at = NOW()
          WHERE id = $1;
          `,
          [worker.id, nextActive, nextStatus],
        );
      }

      const endedRes = await client.query(
        `
        UPDATE sessions
        SET status = 'ended', ended_at = NOW(), last_activity_at = NOW()
        WHERE id = $1
        RETURNING *;
        `,
        [sessionId],
      );

      await this.insertSessionEventClient(client, sessionId, 'session.ended', { reason });
      await client.query('COMMIT');
      return mapSession(endedRes.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveWarmWorker(
    request: SessionCreateRequest,
    providerInstanceId?: string,
  ): Promise<SessionAllocation | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const worker = await this.lockAvailableWorker(client, providerInstanceId);
      if (!worker) {
        await client.query('ROLLBACK');
        return null;
      }

      const nextActive = worker.activeSessions + 1;
      const nextStatus: WorkerStatus = nextActive >= worker.maxSessions ? 'busy' : 'warm';
      const workerUpdateRes = await client.query(
        `
        UPDATE gpu_workers
        SET active_sessions = $2, status = $3, updated_at = NOW()
        WHERE id = $1
        RETURNING *;
        `,
        [worker.id, nextActive, nextStatus],
      );
      const updatedWorker = mapWorker(workerUpdateRes.rows[0]);

      const sessionId = randomUUID();
      const sessionRes = await client.query(
        `
        INSERT INTO sessions (
          id, user_id, worker_id, status, avatar_config, app_metadata
        ) VALUES ($1, $2, $3, 'assigned', $4::jsonb, $5::jsonb)
        RETURNING *;
        `,
        [
          sessionId,
          request.userId ?? null,
          updatedWorker.id,
          JSON.stringify(request.avatarConfig ?? {}),
          JSON.stringify({
            appVersion: request.appVersion ?? null,
          }),
        ],
      );
      await this.insertSessionEventClient(client, sessionId, 'session.assigned', {
        workerId: updatedWorker.id,
        workerKey: updatedWorker.workerKey,
      });

      await client.query('COMMIT');
      return {
        worker: updatedWorker,
        session: mapSession(sessionRes.rows[0]),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAvailableWorker(
    client: PoolClient,
    providerInstanceId?: string,
  ): Promise<WorkerRecord | null> {
    const result = await client.query(
      `
      SELECT *
      FROM gpu_workers
      WHERE
        status IN ('warm', 'busy')
        AND active_sessions < max_sessions
        AND ($1::text IS NULL OR provider_instance_id = $1)
      ORDER BY active_sessions ASC, updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1;
      `,
      [providerInstanceId ?? null],
    );

    return result.rows[0] ? mapWorker(result.rows[0]) : null;
  }

  private async insertSessionEventClient(
    client: PoolClient,
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO session_events (id, session_id, type, payload)
      VALUES ($1, $2, $3, $4::jsonb);
      `,
      [randomUUID(), sessionId, type, JSON.stringify(payload)],
    );
  }
}
