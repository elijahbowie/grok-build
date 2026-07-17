PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  artifact_repo TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  source_type TEXT NOT NULL DEFAULT 'empty' CHECK (source_type IN ('empty', 'github', 'artifacts', 'local')),
  source_url TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  github_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_sub, slug)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL UNIQUE,
  task_repo TEXT UNIQUE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'repairing', 'review', 'completed', 'failed', 'cancelled')),
  model TEXT NOT NULL DEFAULT 'grok-4.5',
  permission_mode TEXT NOT NULL DEFAULT 'isolated-write' CHECK (permission_mode IN ('isolated-write', 'review-only')),
  session_id TEXT,
  base_sha TEXT,
  head_sha TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  endpoint TEXT,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'oauth', 'secret-proxy')),
  secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_connectors (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  read_allowed INTEGER NOT NULL DEFAULT 1,
  write_allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, connector_id)
);

CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  installation_id TEXT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  github_connection_id TEXT REFERENCES github_connections(id) ON DELETE SET NULL,
  repository_full_name TEXT,
  artifact_sha TEXT,
  github_sha TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'in_sync', 'ahead', 'behind', 'diverged', 'error')),
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE companion_pairs (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX tasks_owner_created ON tasks(owner_sub, created_at DESC);
CREATE INDEX tasks_project_created ON tasks(project_id, created_at DESC);
CREATE INDEX task_events_task_seq ON task_events(task_id, seq);
CREATE INDEX evidence_task_created ON evidence(task_id, created_at DESC);
CREATE INDEX evidence_expiry ON evidence(expires_at);
