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
