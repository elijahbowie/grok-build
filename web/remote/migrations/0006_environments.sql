PRAGMA foreign_keys = ON;

CREATE TABLE environment_drafts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{"runtime":"managed","setup":[],"validation":[]}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE environment_draft_repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES environment_drafts(project_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('artifacts', 'github')),
  source_url TEXT,
  ref TEXT NOT NULL DEFAULT 'main',
  pinned_sha TEXT,
  checkout_path TEXT NOT NULL,
  writable INTEGER NOT NULL DEFAULT 0 CHECK (writable IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name),
  UNIQUE(project_id, checkout_path)
);

CREATE UNIQUE INDEX environment_draft_one_writable
  ON environment_draft_repositories(project_id) WHERE writable = 1;

CREATE TABLE environment_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  version INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  source_draft_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version),
  UNIQUE(project_id, manifest_hash)
);

CREATE TRIGGER environment_versions_immutable
BEFORE UPDATE ON environment_versions
BEGIN
  SELECT RAISE(ABORT, 'environment versions are immutable');
END;

CREATE TABLE environment_repositories (
  id TEXT PRIMARY KEY,
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
  source_repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('artifacts', 'github')),
  source_url TEXT,
  ref TEXT NOT NULL,
  pinned_sha TEXT,
  checkout_path TEXT NOT NULL,
  writable INTEGER NOT NULL DEFAULT 0 CHECK (writable IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(environment_version_id, name),
  UNIQUE(environment_version_id, checkout_path)
);

CREATE UNIQUE INDEX environment_version_one_writable
  ON environment_repositories(environment_version_id) WHERE writable = 1;

CREATE TABLE project_active_environments (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE RESTRICT,
  activated_by TEXT NOT NULL,
  activated_at TEXT NOT NULL
);

CREATE TABLE environment_secret_metadata (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('setup', 'runtime')),
  secret_ref TEXT NOT NULL UNIQUE,
  secret_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  deleted_at TEXT,
  UNIQUE(project_id, name, scope)
);

CREATE TABLE environment_version_secrets (
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL REFERENCES environment_secret_metadata(id) ON DELETE RESTRICT,
  PRIMARY KEY(environment_version_id, secret_id)
);

CREATE TABLE environment_builds (
  id TEXT PRIMARY KEY,
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'building', 'ready', 'failed', 'cancelled')),
  fingerprint TEXT NOT NULL,
  runtime_release TEXT NOT NULL,
  workflow_id TEXT,
  log_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE environment_snapshots (
  id TEXT PRIMARY KEY,
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL REFERENCES environment_builds(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  UNIQUE(environment_version_id, fingerprint)
);

CREATE TABLE task_environments (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE RESTRICT,
  snapshot_id TEXT REFERENCES environment_snapshots(id) ON DELETE SET NULL,
  target_repository_id TEXT NOT NULL REFERENCES environment_repositories(id) ON DELETE RESTRICT,
  manifest_hash TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

CREATE INDEX environment_versions_project_created ON environment_versions(project_id, created_at DESC);
CREATE INDEX environment_repositories_version_position ON environment_repositories(environment_version_id, position);
CREATE INDEX environment_secrets_project ON environment_secret_metadata(project_id, deleted_at);
CREATE INDEX environment_builds_version_created ON environment_builds(environment_version_id, created_at DESC);
CREATE INDEX environment_snapshots_fingerprint ON environment_snapshots(fingerprint, invalidated_at);
