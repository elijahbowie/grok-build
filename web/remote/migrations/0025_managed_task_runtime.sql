PRAGMA foreign_keys = ON;

CREATE TABLE managed_runtime_config_revisions (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'project', 'member')),
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  digest TEXT NOT NULL,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE(scope_type, scope_id, revision)
);

CREATE UNIQUE INDEX managed_runtime_config_active
  ON managed_runtime_config_revisions(scope_type, scope_id)
  WHERE active = 1;

CREATE INDEX managed_runtime_config_scope
  ON managed_runtime_config_revisions(scope_type, scope_id, revision DESC);
