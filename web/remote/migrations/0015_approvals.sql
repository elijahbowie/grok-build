PRAGMA foreign_keys = ON;

CREATE TABLE high_impact_approvals (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('publish', 'promotion', 'external-write', 'connector-write', 'automation-enable')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  consequence TEXT NOT NULL CHECK (length(consequence) BETWEEN 1 AND 4000),
  rollback_json TEXT NOT NULL CHECK (json_valid(rollback_json)),
  expected_head_sha TEXT NOT NULL CHECK (length(expected_head_sha) IN (40, 64)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed', 'cancelled')),
  request_reason TEXT NOT NULL CHECK (length(request_reason) BETWEEN 1 AND 2000),
  requested_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT,
  cancelled_at TEXT,
  CHECK (expires_at > created_at)
);

CREATE INDEX high_impact_approvals_task_status
  ON high_impact_approvals(task_id, status, created_at DESC);
CREATE INDEX high_impact_approvals_owner_status
  ON high_impact_approvals(owner_sub, status, expires_at);

CREATE TABLE high_impact_approval_audit (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES high_impact_approvals(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'approved', 'denied', 'expired', 'consumed', 'cancelled')),
  actor_sub TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  expected_head_sha TEXT NOT NULL CHECK (length(expected_head_sha) IN (40, 64)),
  created_at TEXT NOT NULL,
  UNIQUE(approval_id, event_type)
);

CREATE INDEX high_impact_approval_audit_approval
  ON high_impact_approval_audit(approval_id, created_at);

CREATE TRIGGER high_impact_approval_audit_no_update
BEFORE UPDATE ON high_impact_approval_audit
BEGIN
  SELECT RAISE(ABORT, 'approval audit entries are immutable');
END;

CREATE TRIGGER high_impact_approval_audit_no_delete
BEFORE DELETE ON high_impact_approval_audit
BEGIN
  SELECT RAISE(ABORT, 'approval audit entries are immutable');
END;
