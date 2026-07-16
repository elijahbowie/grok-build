CREATE TABLE github_apps (
  owner_sub TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  client_id TEXT,
  encrypted_config_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_manifest_states (
  state TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('github-to-artifacts', 'artifacts-to-github')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'diverged', 'failed')),
  source_sha TEXT,
  target_sha TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX sync_runs_project_created ON sync_runs(project_id, created_at DESC);
