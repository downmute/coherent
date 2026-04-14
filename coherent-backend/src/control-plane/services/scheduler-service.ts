import { signToken } from '../../shared/token.js';
import { NoCapacityError, ProvisioningTimeoutError } from '../../shared/errors.js';
import type { ControlPlaneConfig } from '../../shared/config.js';
import type {
  CreateSessionResponse,
  SessionCreateRequest,
  SessionRecord,
  WorkerTokenPayload,
} from '../../shared/types.js';
import { PostgresStore } from '../db/postgres-store.js';
import type { WorkerProvisioner } from '../adapters/provider.js';
import { RtcCredentialService } from '../adapters/rtc.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SchedulerService {
  constructor(
    private readonly store: PostgresStore,
    private readonly rtc: RtcCredentialService,
    private readonly provider: WorkerProvisioner,
    private readonly config: ControlPlaneConfig,
  ) {}

  async createSession(request: SessionCreateRequest): Promise<CreateSessionResponse> {
    let allocation = await this.store.reserveWarmWorker(request);

    if (!allocation) {
      const provision = await this.provider.requestProvision({
        requestedAt: new Date().toISOString(),
        avatarConfig: request.avatarConfig ?? {},
      });

      if (!provision) {
        throw new NoCapacityError(
          'No warm worker is available and on-demand worker provisioning is not configured.',
        );
      }

      const deadline = Date.now() + this.config.SESSION_PROVISION_TIMEOUT_MS;
      while (!allocation && Date.now() < deadline) {
        await sleep(this.config.SESSION_PROVISION_POLL_MS);
        allocation = await this.store.reserveWarmWorker(request, provision.providerInstanceId);
      }

      if (!allocation) {
        throw new ProvisioningTimeoutError();
      }
    }

    const rtcPair = await this.rtc.issuePair(allocation.session.id);
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
      workerToken: signToken(workerPayload, this.config.WORKER_TOKEN_SECRET),
      rtcCredentials: rtcPair.subscriber,
      status: 'assigned',
    };
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.store.getSession(sessionId);
  }

  async endSession(sessionId: string): Promise<SessionRecord | null> {
    return this.store.endSession(sessionId, 'api.end');
  }
}
