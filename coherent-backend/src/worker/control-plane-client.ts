import type { WorkerConfig } from '../shared/config.js';
import type { RegisterWorkerRequest, SessionStatus, WorkerStatus } from '../shared/types.js';

export class ControlPlaneClient {
  constructor(private readonly config: WorkerConfig) {}

  private buildUrl(path: string): string {
    return `${this.config.CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`;
  }

  private internalHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.INTERNAL_API_KEY) {
      headers['x-internal-api-key'] = this.config.INTERNAL_API_KEY;
    }
    return headers;
  }

  async registerWorker(input: RegisterWorkerRequest): Promise<void> {
    const response = await fetch(this.buildUrl('/internal/workers/register'), {
      method: 'POST',
      headers: this.internalHeaders(),
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Failed to register worker: HTTP ${response.status}`);
    }
  }

  async heartbeat(input: {
    status: WorkerStatus;
    activeSessions: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const response = await fetch(this.buildUrl('/internal/workers/heartbeat'), {
      method: 'POST',
      headers: this.internalHeaders(),
      body: JSON.stringify({
        workerKey: this.config.WORKER_KEY,
        status: input.status,
        activeSessions: input.activeSessions,
        metadata: input.metadata ?? {},
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to heartbeat worker: HTTP ${response.status}`);
    }
  }

  async touchSession(sessionId: string, status?: SessionStatus): Promise<void> {
    const response = await fetch(this.buildUrl(`/internal/sessions/${sessionId}/activity`), {
      method: 'POST',
      headers: this.internalHeaders(),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      throw new Error(`Failed to touch session: HTTP ${response.status}`);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const response = await fetch(this.buildUrl(`/sessions/${sessionId}/end`), {
      method: 'POST',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to end session: HTTP ${response.status}`);
    }
  }
}
