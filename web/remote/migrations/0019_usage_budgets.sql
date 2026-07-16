PRAGMA foreign_keys = ON;

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  automation_run_id TEXT REFERENCES cloud_automation_runs(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('model', 'container', 'storage', 'network', 'workflow')),
  meter TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  model TEXT,
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_sub, idempotency_key)
);

CREATE TABLE container_sessions (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  sandbox_id TEXT NOT NULL,
  instance_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'sleeping', 'stopped', 'failed')),
  wake_reason TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  slept_at TEXT,
  stopped_at TEXT,
  active_milliseconds INTEGER NOT NULL DEFAULT 0 CHECK (active_milliseconds >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('task', 'day', 'month')),
  limit_micros INTEGER NOT NULL CHECK (limit_micros > 0),
  warning_percent INTEGER NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 100),
  enforcement TEXT NOT NULL DEFAULT 'warn' CHECK (enforcement IN ('warn', 'block_new', 'stop_active')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_sub, scope_key, period)
);

CREATE TABLE budget_alerts (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL,
  spent_micros INTEGER NOT NULL,
  limit_micros INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(budget_id, threshold_percent, period_start)
);

CREATE INDEX usage_events_owner_time ON usage_events(owner_sub, occurred_at DESC);
CREATE INDEX usage_events_project_time ON usage_events(project_id, occurred_at DESC);
CREATE INDEX usage_events_task_time ON usage_events(task_id, occurred_at DESC);
CREATE INDEX container_sessions_task ON container_sessions(task_id, updated_at DESC);
