PRAGMA foreign_keys = ON;

CREATE TABLE task_sessions (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_session_id TEXT REFERENCES task_sessions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_session_revisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES task_session_revisions(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('snapshot', 'fork', 'rewind')),
  prompt_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_status TEXT NOT NULL,
  model TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  base_sha TEXT,
  head_sha TEXT,
  transcript_json TEXT NOT NULL,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX task_sessions_project_updated ON task_sessions(project_id, updated_at DESC);
CREATE INDEX task_sessions_owner_updated ON task_sessions(owner_sub, updated_at DESC);
CREATE UNIQUE INDEX task_sessions_one_root ON task_sessions(root_task_id) WHERE source_session_id IS NULL;
CREATE INDEX task_session_revisions_session_created ON task_session_revisions(session_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX task_session_single_snapshot ON task_session_revisions(session_id) WHERE operation='snapshot';

CREATE TRIGGER task_session_revisions_immutable_update
BEFORE UPDATE ON task_session_revisions BEGIN
  SELECT RAISE(ABORT, 'task session revisions are immutable');
END;

CREATE TRIGGER task_session_revisions_immutable_delete
BEFORE DELETE ON task_session_revisions BEGIN
  SELECT RAISE(ABORT, 'task session revisions are immutable');
END;
