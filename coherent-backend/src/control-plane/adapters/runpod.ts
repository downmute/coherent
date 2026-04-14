import { randomUUID } from 'node:crypto';
import type { WorkerProvisionResult, WorkerProvisioner } from './provider.js';

interface RunpodAdapterConfig {
  baseUrl: string;
  apiKey: string;
  templateId: string;
  gpuTypeIds: string[];
  cloudType: 'SECURE' | 'COMMUNITY';
  allowedCudaVersions?: string[];
  dataCenterIds?: string[];
  countryCodes?: string[];
  namePrefix: string;
}

export class RunpodAdapter implements WorkerProvisioner {
  constructor(private readonly config: RunpodAdapterConfig) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.baseUrl &&
        this.config.apiKey &&
        this.config.templateId &&
        this.config.gpuTypeIds.length > 0,
    );
  }

  async requestProvision(metadata: Record<string, unknown>): Promise<WorkerProvisionResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const name = `${this.config.namePrefix}-${randomUUID().slice(0, 8)}`;
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/pods`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        name,
        templateId: this.config.templateId,
        cloudType: this.config.cloudType,
        computeType: 'GPU',
        gpuCount: 1,
        gpuTypeIds: this.config.gpuTypeIds,
        allowedCudaVersions:
          this.config.allowedCudaVersions && this.config.allowedCudaVersions.length > 0
            ? this.config.allowedCudaVersions
            : undefined,
        dataCenterIds:
          this.config.dataCenterIds && this.config.dataCenterIds.length > 0
            ? this.config.dataCenterIds
            : undefined,
        countryCodes:
          this.config.countryCodes && this.config.countryCodes.length > 0
            ? this.config.countryCodes
            : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Runpod provisioning failed with HTTP ${response.status}.`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const providerInstanceId =
      (typeof json.id === 'string' && json.id) ||
      (typeof json.podId === 'string' && json.podId) ||
      (typeof json.instanceId === 'string' && json.instanceId) ||
      randomUUID();

    return {
      requested: true,
      providerInstanceId,
      raw: {
        ...json,
        requestedName: name,
        metadata,
      },
    };
  }
}
