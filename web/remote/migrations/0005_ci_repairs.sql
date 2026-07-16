CREATE TABLE ci_repairs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  github_run_id TEXT NOT NULL UNIQUE,
  workflow_name TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  run_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ci_repairs_project_created ON ci_repairs(project_id, created_at DESC);
