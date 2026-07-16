PRAGMA foreign_keys = ON;

CREATE TABLE cloud_automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 32000),
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'paused', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE RESTRICT,
  target_repository_id TEXT NOT NULL REFERENCES environment_repositories(id) ON DELETE RESTRICT,
  security_policy_revision_id TEXT NOT NULL REFERENCES security_policy_revisions(id) ON DELETE RESTRICT,
  concurrency_policy TEXT NOT NULL CHECK (concurrency_policy IN ('skip', 'queue')),
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 8),
  rate_limit_count INTEGER NOT NULL CHECK (rate_limit_count BETWEEN 1 AND 1000),
  rate_limit_window_seconds INTEGER NOT NULL CHECK (rate_limit_window_seconds BETWEEN 60 AND 86400),
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE cloud_automation_rules (
  automation_id TEXT NOT NULL REFERENCES cloud_automations(id) ON DELETE CASCADE,
  rule_revision_id TEXT NOT NULL REFERENCES customization_rule_revisions(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (automation_id, rule_revision_id),
  UNIQUE (automation_id, position)
);

CREATE TABLE cloud_automation_triggers (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES cloud_automations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('manual', 'cron', 'github', 'webhook')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_due_at TEXT,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((type = 'webhook' AND secret_ref IS NOT NULL) OR (type != 'webhook' AND secret_ref IS NULL))
);

CREATE TABLE cloud_automation_destinations (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES cloud_automations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('in_app', 'webhook', 'email', 'slack')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  destination_ref TEXT NOT NULL CHECK (length(destination_ref) BETWEEN 1 AND 500),
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cloud_automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES cloud_automations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  trigger_id TEXT REFERENCES cloud_automation_triggers(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'cron', 'github', 'webhook')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'review', 'completed', 'failed', 'cancelled', 'skipped', 'rate_limited')),
  reason TEXT,
  source_provenance_json TEXT NOT NULL CHECK (json_valid(source_provenance_json)),
  definition_revision INTEGER NOT NULL,
  environment_version_id TEXT NOT NULL REFERENCES environment_versions(id) ON DELETE RESTRICT,
  target_repository_id TEXT NOT NULL REFERENCES environment_repositories(id) ON DELETE RESTRICT,
  security_policy_revision_id TEXT NOT NULL REFERENCES security_policy_revisions(id) ON DELETE RESTRICT,
  rule_revision_ids_json TEXT NOT NULL CHECK (json_valid(rule_revision_ids_json)),
  task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  auto_promote INTEGER NOT NULL DEFAULT 0 CHECK (auto_promote = 0),
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_id, idempotency_key)
);

CREATE TABLE cloud_automation_outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES cloud_automation_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('evidence', 'artifact', 'preview', 'pull_request', 'log')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  storage_ref TEXT NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 1000),
  content_type TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX cloud_automations_owner_project ON cloud_automations(owner_sub, project_id, updated_at DESC);
CREATE INDEX cloud_automation_triggers_due ON cloud_automation_triggers(enabled, type, next_due_at);
CREATE INDEX cloud_automation_runs_history ON cloud_automation_runs(owner_sub, automation_id, created_at DESC);
CREATE INDEX cloud_automation_runs_active ON cloud_automation_runs(automation_id, status, created_at);
CREATE INDEX cloud_automation_outputs_run ON cloud_automation_outputs(run_id, created_at);

CREATE TRIGGER cloud_automation_runs_no_auto_promote
BEFORE UPDATE OF auto_promote ON cloud_automation_runs
WHEN NEW.auto_promote != 0
BEGIN
  SELECT RAISE(ABORT, 'automation runs can never auto-promote');
END;
