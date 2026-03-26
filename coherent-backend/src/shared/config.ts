import { z } from 'zod';

const commonSchema = z.object({
  WORKER_TOKEN_SECRET: z.string().min(1).default('change-me'),
  RTC_TOKEN_SECRET: z.string().min(1).default('change-me-too'),
  RTC_PROVIDER: z.enum(['mock', 'cloudflare']).default('mock'),
  RTC_ENDPOINT: z.string().url().default('https://rtc.example.com'),
  CLOUDFLARE_API_BASE_URL: z.string().url().default('https://api.cloudflare.com/client/v4'),
  CLOUDFLARE_ACCOUNT_ID: z.string().default(''),
  CLOUDFLARE_REALTIME_APP_ID: z.string().default(''),
  CLOUDFLARE_API_TOKEN: z.string().default(''),
  CLOUDFLARE_SUBSCRIBER_PRESET: z.string().default('group_call_participant'),
  CLOUDFLARE_PUBLISHER_PRESET: z.string().default('group_call_host'),
});

const controlPlaneSchema = commonSchema.extend({
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/coherent_backend'),
  CONTROL_PLANE_PORT: z.coerce.number().int().positive().default(8080),
  CONTROL_PLANE_HOST: z.string().default('0.0.0.0'),
  AUTO_MIGRATE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),
  SESSION_PROVISION_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SESSION_PROVISION_POLL_MS: z.coerce.number().int().positive().default(2000),
  SIMPLEPOD_API_BASE_URL: z.string().default(''),
  SIMPLEPOD_API_KEY: z.string().default(''),
  SIMPLEPOD_TEMPLATE_ID: z.string().default(''),
  SIMPLEPOD_GPU_MODEL: z.string().default('RTX4090'),
  SIMPLEPOD_REGION: z.string().default(''),
  SIMPLEPOD_PROVISION_PATH: z.string().default('/instances'),
});

const workerSchema = commonSchema.extend({
  WORKER_PORT: z.coerce.number().int().positive().default(8090),
  WORKER_HOST: z.string().default('0.0.0.0'),
  WORKER_KEY: z.string().min(1).default('worker-local-1'),
  WORKER_PROVIDER: z.string().default('manual'),
  WORKER_PROVIDER_INSTANCE_ID: z.string().default(''),
  WORKER_REGION: z.string().default('local'),
  WORKER_GPU_MODEL: z.string().default('RTX4090'),
  WORKER_MAX_SESSIONS: z.coerce.number().int().positive().default(2),
  WORKER_PUBLIC_WS_URL: z.string().default('ws://127.0.0.1:8090/ws'),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(10000),
  CONTROL_PLANE_URL: z.string().url().default('http://127.0.0.1:8080'),
  WORKER_RTC_PUBLISHER: z.enum(['mock', 'browser']).default('browser'),
  WORKER_BROWSER_EXECUTABLE_PATH: z.string().default('/usr/bin/google-chrome'),
  WORKER_RTC_HEADLESS: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),
  WORKER_RTC_VIEWPORT_WIDTH: z.coerce.number().int().positive().default(768),
  WORKER_RTC_VIEWPORT_HEIGHT: z.coerce.number().int().positive().default(768),
  WORKER_RTC_FPS: z.coerce.number().int().positive().default(24),
  SOULX_RUNTIME_MODE: z.enum(['mock', 'python_bridge']).default('mock'),
  SOULX_CKPT_DIR: z.string().default('/opt/SoulX-FlashHead/models/SoulX-FlashHead-1_3B'),
  SOULX_WAV2VEC_DIR: z.string().default('/opt/SoulX-FlashHead/models/wav2vec2-base-960h'),
  SOULX_MODEL_TYPE: z.enum(['lite', 'pro']).default('lite'),
  SOULX_COND_IMAGE: z.string().default('/opt/SoulX-FlashHead/examples/girl.png'),
  SOULX_FACES_DIR: z.string().default('/app/faces'),
  SOULX_USE_FACE_CROP: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  SOULX_BASE_SEED: z.coerce.number().int().default(9999),
  SOULX_PYTHON_BIN: z.string().default('/opt/soulx-venv/bin/python'),
  SOULX_BRIDGE_SCRIPT: z.string().default('/app/scripts/soulx_stream_bridge.py'),
});

export type ControlPlaneConfig = z.infer<typeof controlPlaneSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export function getControlPlaneConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  return controlPlaneSchema.parse(env);
}

export function getWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerSchema.parse(env);
}
