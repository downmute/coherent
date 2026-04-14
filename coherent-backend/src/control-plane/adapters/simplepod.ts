import { randomUUID } from 'node:crypto';
import type { WorkerProvisionResult, WorkerProvisioner } from './provider.js';

interface SimplePodAdapterConfig {
  baseUrl: string;
  apiKey: string;
  templateId: string;
  gpuModel: string;
  region: string;
  provisionPath: string;
  allowedCudaVersions?: string[];
}

export class SimplePodAdapter implements WorkerProvisioner {
  constructor(private readonly config: SimplePodAdapterConfig) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.baseUrl &&
        this.config.apiKey &&
        this.config.templateId &&
        this.config.provisionPath,
    );
  }

  async requestProvision(metadata: Record<string, unknown>): Promise<WorkerProvisionResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, '')}${this.config.provisionPath}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          templateId: this.config.templateId,
          gpuModel: this.config.gpuModel,
          region: this.config.region || undefined,
          allowedCudaVersions:
            this.config.allowedCudaVersions && this.config.allowedCudaVersions.length > 0
              ? this.config.allowedCudaVersions
              : undefined,
          metadata,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`SimplePod provisioning failed with HTTP ${response.status}.`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const providerInstanceId =
      (typeof json.instanceId === 'string' && json.instanceId) ||
      (typeof json.id === 'string' && json.id) ||
      randomUUID();

    return {
      requested: true,
      providerInstanceId,
      raw: json,
    };
  }
}
