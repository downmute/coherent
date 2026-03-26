import { randomUUID } from 'node:crypto';

export interface SimplePodProvisionResult {
  requested: boolean;
  providerInstanceId: string;
  raw?: unknown;
}

interface SimplePodAdapterConfig {
  baseUrl: string;
  apiKey: string;
  templateId: string;
  gpuModel: string;
  region: string;
  provisionPath: string;
}

export class SimplePodAdapter {
  constructor(private readonly config: SimplePodAdapterConfig) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.baseUrl &&
        this.config.apiKey &&
        this.config.templateId &&
        this.config.provisionPath,
    );
  }

  async requestProvision(metadata: Record<string, unknown>): Promise<SimplePodProvisionResult | null> {
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
