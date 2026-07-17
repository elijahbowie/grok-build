PRAGMA foreign_keys = ON;

CREATE TABLE security_policy_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  policy_digest TEXT NOT NULL,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision),
  UNIQUE(project_id, policy_digest)
);

CREATE TABLE project_security_policy_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES security_policy_revisions(id) ON DELETE RESTRICT,
  activated_by_sub TEXT NOT NULL,
  activated_at TEXT NOT NULL
);

CREATE TABLE task_security_policy_pins (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES security_policy_revisions(id) ON DELETE RESTRICT,
  policy_digest TEXT NOT NULL,
  pinned_at TEXT NOT NULL
);

CREATE TABLE mcp_tool_grants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  policy_revision_id TEXT NOT NULL REFERENCES security_policy_revisions(id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 160),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE brokered_secret_metadata (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  storage_ref TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '/',
  methods_json TEXT NOT NULL DEFAULT '["GET"]' CHECK (json_valid(methods_json)),
  header_name TEXT NOT NULL DEFAULT 'authorization',
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  rotated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE security_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  policy_revision_id TEXT REFERENCES security_policy_revisions(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('network', 'filesystem', 'tool', 'secret', 'mcp', 'policy')),
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'observed', 'error')),
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX security_policy_revisions_project ON security_policy_revisions(project_id, revision DESC);
CREATE INDEX task_security_policy_pins_revision ON task_security_policy_pins(revision_id);
CREATE INDEX mcp_tool_grants_task ON mcp_tool_grants(task_id, connector_id, expires_at);
CREATE UNIQUE INDEX mcp_tool_grants_active_exact ON mcp_tool_grants(task_id, connector_id, tool_name) WHERE revoked_at IS NULL;
CREATE INDEX brokered_secret_metadata_project ON brokered_secret_metadata(project_id, revoked_at);
CREATE INDEX security_audit_task_created ON security_audit_events(task_id, created_at DESC);
CREATE INDEX security_audit_project_created ON security_audit_events(project_id, created_at DESC);

CREATE TRIGGER security_policy_revisions_immutable_update
BEFORE UPDATE ON security_policy_revisions
BEGIN
  SELECT RAISE(ABORT, 'security policy revisions are immutable');
END;

CREATE TRIGGER security_policy_revisions_immutable_delete
BEFORE DELETE ON security_policy_revisions
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'security policy revisions are immutable');
END;
