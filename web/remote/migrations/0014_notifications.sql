PRAGMA foreign_keys = ON;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  subscription_ciphertext TEXT NOT NULL CHECK (json_valid(subscription_ciphertext)),
  platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android', 'desktop')),
  user_agent TEXT NOT NULL DEFAULT '' CHECK (length(user_agent) <= 500),
  expiration_time TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE(owner_sub, endpoint_hash)
);

CREATE INDEX push_subscriptions_owner_status
  ON push_subscriptions(owner_sub, status, updated_at DESC);

CREATE TABLE notification_preferences (
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  task_completed INTEGER NOT NULL DEFAULT 1 CHECK (task_completed IN (0, 1)),
  task_failed INTEGER NOT NULL DEFAULT 1 CHECK (task_failed IN (0, 1)),
  approval_needed INTEGER NOT NULL DEFAULT 1 CHECK (approval_needed IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_sub, project_key),
  CHECK (project_key = COALESCE(project_id, '*'))
);

CREATE TABLE task_attention_events (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task-completed', 'task-failed', 'approval-needed')),
  dedup_key TEXT NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 240),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  read_state TEXT NOT NULL DEFAULT 'unread' CHECK (read_state IN ('unread', 'read', 'dismissed')),
  created_at TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  UNIQUE(owner_sub, dedup_key)
);

CREATE INDEX task_attention_events_owner_state
  ON task_attention_events(owner_sub, read_state, created_at DESC);
CREATE INDEX task_attention_events_task
  ON task_attention_events(task_id, created_at DESC);
