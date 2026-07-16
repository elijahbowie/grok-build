CREATE TABLE subagent_groups (
  parent_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 32),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subagent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL UNIQUE,
  runtime_identity TEXT NOT NULL UNIQUE,
  workflow_identity TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(parent_task_id, id)
);

CREATE TABLE subagent_dependencies (
  subagent_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
  depends_on_subagent_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subagent_id, depends_on_subagent_id),
  CHECK (subagent_id <> depends_on_subagent_id)
);

CREATE TABLE subagent_steers (
  id TEXT PRIMARY KEY,
  subagent_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  instruction TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE subagent_handoffs (
  id TEXT PRIMARY KEY,
  subagent_id TEXT NOT NULL UNIQUE REFERENCES subagent_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER subagent_handoffs_immutable
BEFORE UPDATE ON subagent_handoffs
BEGIN
  SELECT RAISE(ABORT, 'subagent handoffs are immutable');
END;

CREATE TABLE subagent_collection_decisions (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('merge', 'collect')),
  expected_parent_head_sha TEXT NOT NULL,
  handoff_ids_json TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  decided_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER subagent_collection_decisions_immutable
BEFORE UPDATE ON subagent_collection_decisions
BEGIN
  SELECT RAISE(ABORT, 'subagent collection decisions are immutable');
END;

CREATE TABLE subagent_pr_babysit (
  subagent_id TEXT PRIMARY KEY REFERENCES subagent_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'monitor', 'repair')),
  status TEXT NOT NULL CHECK (status IN ('idle', 'watching', 'waiting', 'repairing', 'passing', 'failed', 'cancelled')),
  last_head_sha TEXT,
  last_check_at TEXT,
  next_check_at TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK (repair_attempts >= 0),
  max_repair_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_repair_attempts BETWEEN 0 AND 20),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX subagent_runs_parent_state ON subagent_runs(parent_task_id, state, created_at);
CREATE INDEX subagent_runs_project_created ON subagent_runs(project_id, created_at DESC);
CREATE INDEX subagent_dependencies_parent ON subagent_dependencies(parent_task_id, subagent_id);
CREATE INDEX subagent_steers_run_created ON subagent_steers(subagent_id, created_at);
CREATE INDEX subagent_handoffs_parent_created ON subagent_handoffs(parent_task_id, created_at);
CREATE INDEX subagent_collection_parent_created ON subagent_collection_decisions(parent_task_id, created_at DESC);
