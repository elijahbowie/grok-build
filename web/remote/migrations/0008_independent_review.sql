CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  workflow_id TEXT UNIQUE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('task', 'manual', 'github', 'fix')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stale', 'cancelled')),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  patch_digest TEXT,
  rules_digest TEXT,
  risk_level TEXT NOT NULL DEFAULT 'none' CHECK (risk_level IN ('none', 'low', 'medium', 'high', 'critical')),
  findings_count INTEGER NOT NULL DEFAULT 0,
  blocking_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  output_key TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  category TEXT NOT NULL CHECK (category IN ('correctness', 'security', 'reliability', 'performance', 'maintainability', 'testing', 'accessibility')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  remediation TEXT,
  blocking INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'fixed', 'stale')),
  dismissal_reason TEXT,
  dismissed_by TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(review_run_id, fingerprint)
);

CREATE TABLE review_hunks (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hunk_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  old_start INTEGER NOT NULL,
  old_lines INTEGER NOT NULL,
  new_start INTEGER NOT NULL,
  new_lines INTEGER NOT NULL,
  patch_text TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'accepted', 'rejected')),
  expected_head_sha TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(review_run_id, hunk_key)
);

CREATE TABLE review_fix_runs (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stale', 'cancelled')),
  expected_head_sha TEXT NOT NULL,
  result_head_sha TEXT,
  selected_findings_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX review_runs_task_created ON review_runs(task_id, created_at DESC);
CREATE INDEX review_runs_task_head ON review_runs(task_id, head_sha, status);
CREATE INDEX review_findings_run_status ON review_findings(review_run_id, status, blocking);
CREATE INDEX review_findings_task_fingerprint ON review_findings(task_id, fingerprint);
CREATE INDEX review_hunks_run_decision ON review_hunks(review_run_id, decision);
CREATE INDEX review_fix_runs_task_created ON review_fix_runs(task_id, created_at DESC);
