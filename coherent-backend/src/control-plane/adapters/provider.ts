export interface WorkerProvisionResult {
  requested: boolean;
  providerInstanceId: string;
  raw?: unknown;
}

export interface WorkerProvisioner {
  isConfigured(): boolean;
  requestProvision(metadata: Record<string, unknown>): Promise<WorkerProvisionResult | null>;
}
