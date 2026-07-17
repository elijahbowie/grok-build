PRAGMA foreign_keys = ON;

CREATE TABLE customization_rules (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  mode TEXT NOT NULL CHECK (mode IN ('always', 'agent-requested', 'manual')),
  path_glob TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'user' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);

CREATE TABLE customization_rule_revisions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES customization_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 32768),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(rule_id, version)
);

CREATE UNIQUE INDEX customization_rules_user_name
  ON customization_rules(owner_sub, name) WHERE scope = 'user';
CREATE UNIQUE INDEX customization_rules_project_name
  ON customization_rules(project_id, name) WHERE scope = 'project';
CREATE INDEX customization_rules_owner_project
  ON customization_rules(owner_sub, project_id, enabled, updated_at DESC);

CREATE TABLE memory_privacy_settings (
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  privacy_mode INTEGER NOT NULL DEFAULT 0 CHECK (privacy_mode IN (0, 1)),
  updated_by_sub TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_sub, project_key),
  CHECK (project_key = COALESCE(project_id, '*'))
);

CREATE TABLE transparent_memories (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8192),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  source_type TEXT NOT NULL CHECK (source_type IN ('user-stated', 'task-observation', 'repository', 'import')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 1000),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((scope = 'user' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);

CREATE INDEX transparent_memories_owner_project
  ON transparent_memories(owner_sub, project_id, status, updated_at DESC);

CREATE TABLE rules_memory_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_sub TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('rule', 'memory', 'privacy', 'context')),
  entity_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX rules_memory_audit_owner_created
  ON rules_memory_audit_events(owner_sub, created_at DESC);
CREATE INDEX rules_memory_audit_project_created
  ON rules_memory_audit_events(project_id, created_at DESC);

CREATE TRIGGER customization_rule_revision_immutable_update
BEFORE UPDATE ON customization_rule_revisions
BEGIN
  SELECT RAISE(ABORT, 'customization rule revisions are immutable');
END;

CREATE TRIGGER customization_rule_revision_immutable_delete
BEFORE DELETE ON customization_rule_revisions
WHEN EXISTS (SELECT 1 FROM customization_rules WHERE id = OLD.rule_id)
BEGIN
  SELECT RAISE(ABORT, 'customization rule revisions are immutable');
END;
