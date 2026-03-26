CREATE TABLE IF NOT EXISTS gpu_workers (
  id TEXT PRIMARY KEY,
  worker_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_instance_id TEXT UNIQUE,
  region TEXT NOT NULL,
  gpu_model TEXT NOT NULL,
  status TEXT NOT NULL,
  max_sessions INTEGER NOT NULL,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  public_ws_url TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  last_heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  worker_id TEXT NOT NULL REFERENCES gpu_workers(id),
  status TEXT NOT NULL,
  avatar_config TEXT NOT NULL DEFAULT '{}',
  app_metadata TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gpu_workers_status ON gpu_workers(status);
CREATE INDEX IF NOT EXISTS idx_gpu_workers_provider_instance_id ON gpu_workers(provider_instance_id);
CREATE INDEX IF NOT EXISTS idx_sessions_worker_id ON sessions(worker_id);
