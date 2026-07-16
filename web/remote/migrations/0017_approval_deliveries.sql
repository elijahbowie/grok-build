PRAGMA foreign_keys = ON;

CREATE TABLE high_impact_approval_deliveries (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES high_impact_approvals(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  expected_head_sha TEXT NOT NULL CHECK (length(expected_head_sha) IN (40, 64)),
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'promote'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'failed', 'delivered')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX high_impact_approval_deliveries_status
  ON high_impact_approval_deliveries(status, lease_expires_at, created_at);
