PRAGMA foreign_keys = ON;

ALTER TABLE subagent_steers ADD COLUMN consumed_at TEXT;
ALTER TABLE subagent_steers ADD COLUMN claim_token TEXT;
ALTER TABLE subagent_steers ADD COLUMN claimed_at TEXT;

ALTER TABLE plan_message_queue ADD COLUMN claim_token TEXT;
ALTER TABLE plan_message_queue ADD COLUMN claimed_at TEXT;

ALTER TABLE cloud_automation_runs ADD COLUMN launch_claim_token TEXT;
ALTER TABLE cloud_automation_runs ADD COLUMN launch_claimed_at TEXT;

ALTER TABLE environment_version_secrets ADD COLUMN secret_name TEXT;
ALTER TABLE environment_version_secrets ADD COLUMN secret_scope TEXT;
ALTER TABLE environment_version_secrets ADD COLUMN secret_ref TEXT;
ALTER TABLE environment_version_secrets ADD COLUMN secret_version INTEGER;
UPDATE environment_version_secrets
SET secret_name=(SELECT name FROM environment_secret_metadata WHERE id=secret_id),
    secret_scope=(SELECT scope FROM environment_secret_metadata WHERE id=secret_id),
    secret_ref=(SELECT secret_ref FROM environment_secret_metadata WHERE id=secret_id),
    secret_version=(SELECT secret_version FROM environment_secret_metadata WHERE id=secret_id);

CREATE TABLE subagent_collection_applications (
  decision_id TEXT PRIMARY KEY REFERENCES subagent_collection_decisions(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  prior_head_sha TEXT NOT NULL,
  resulting_head_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'failed', 'recorded')),
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX subagent_collection_applications_parent
  ON subagent_collection_applications(parent_task_id, started_at DESC);

CREATE TABLE cloud_automation_status_audit (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES cloud_automations(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  confirmation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER cloud_automation_status_audit_immutable
BEFORE UPDATE ON cloud_automation_status_audit BEGIN
  SELECT RAISE(ABORT, 'automation status audit entries are immutable');
END;
