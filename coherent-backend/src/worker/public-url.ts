import type { WorkerConfig } from '../shared/config.js';

function trim(value: string | undefined): string {
  return value?.trim() ?? '';
}

function isRunpodWorker(config: WorkerConfig): boolean {
  return trim(config.WORKER_PROVIDER).toLowerCase() === 'runpod';
}

function normalizeWsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/ws';
  }

  return url.toString();
}

function normalizeBaseUrlToWs(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return normalizeWsUrl(url.toString());
}

function getRunpodTcpMappedPort(workerPort: number, env: NodeJS.ProcessEnv): string {
  const exact = trim(env[`RUNPOD_TCP_PORT_${workerPort}`]);
  if (exact) {
    return exact;
  }

  // Symmetrical mapping values on Runpod are requested with ports above 70000.
  // If a team chooses to mirror 8090 via 78090, this fallback lets the worker
  // discover it without hardcoding the final external port.
  const symmetricHint = trim(env[`RUNPOD_TCP_PORT_${70000 + workerPort}`]);
  return symmetricHint;
}

export function resolveWorkerIdentity(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): {
  workerKey: string;
  providerInstanceId: string;
  workerKeySource: 'explicit' | 'runpod_pod_id' | 'local_default';
  providerInstanceIdSource: 'explicit' | 'runpod_pod_id' | 'empty';
} {
  const explicitWorkerKey = trim(config.WORKER_KEY);
  const explicitProviderInstanceId = trim(config.WORKER_PROVIDER_INSTANCE_ID);
  const runpodPodId = trim(env.RUNPOD_POD_ID);

  let workerKey = explicitWorkerKey;
  let workerKeySource: 'explicit' | 'runpod_pod_id' | 'local_default' = 'explicit';
  if (!workerKey && isRunpodWorker(config) && runpodPodId) {
    workerKey = `runpod-${runpodPodId}`;
    workerKeySource = 'runpod_pod_id';
  } else if (!workerKey) {
    workerKey = 'worker-local-1';
    workerKeySource = 'local_default';
  }

  let providerInstanceId = explicitProviderInstanceId;
  let providerInstanceIdSource: 'explicit' | 'runpod_pod_id' | 'empty' = 'explicit';
  if (!providerInstanceId && isRunpodWorker(config) && runpodPodId) {
    providerInstanceId = runpodPodId;
    providerInstanceIdSource = 'runpod_pod_id';
  } else if (!providerInstanceId) {
    providerInstanceIdSource = 'empty';
  }

  return {
    workerKey,
    providerInstanceId,
    workerKeySource,
    providerInstanceIdSource,
  };
}

export function resolveWorkerPublicWsUrl(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): { url: string; source: 'explicit_ws' | 'explicit_base' | 'runpod_proxy' | 'runpod_tcp' | 'local_default' } {
  const explicitWsUrl = trim(config.WORKER_PUBLIC_WS_URL);
  if (explicitWsUrl) {
    return { url: normalizeWsUrl(explicitWsUrl), source: 'explicit_ws' };
  }

  const explicitBaseUrl = trim(config.WORKER_PUBLIC_BASE_URL);
  if (explicitBaseUrl) {
    return { url: normalizeBaseUrlToWs(explicitBaseUrl), source: 'explicit_base' };
  }

  const runpodPodId = trim(env.RUNPOD_POD_ID);
  if (runpodPodId) {
    return {
      url: `wss://${runpodPodId}-${config.WORKER_PORT}.proxy.runpod.net/ws`,
      source: 'runpod_proxy',
    };
  }

  const runpodPublicIp = trim(env.RUNPOD_PUBLIC_IP);
  const runpodMappedTcpPort = getRunpodTcpMappedPort(config.WORKER_PORT, env);
  if (runpodPublicIp && runpodMappedTcpPort) {
    return {
      url: `ws://${runpodPublicIp}:${runpodMappedTcpPort}/ws`,
      source: 'runpod_tcp',
    };
  }

  return {
    url: `ws://127.0.0.1:${config.WORKER_PORT}/ws`,
    source: 'local_default',
  };
}
