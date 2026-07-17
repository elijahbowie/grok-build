PRAGMA foreign_keys = ON;

ALTER TABLE tasks ADD COLUMN final_response TEXT;
ALTER TABLE tasks ADD COLUMN structured_output_json TEXT CHECK (structured_output_json IS NULL OR json_valid(structured_output_json));
ALTER TABLE tasks ADD COLUMN final_stop_reason TEXT;

ALTER TABLE task_session_revisions ADD COLUMN acp_session_id TEXT;
ALTER TABLE task_session_revisions ADD COLUMN execution_context TEXT NOT NULL DEFAULT '';

CREATE TABLE task_message_checkpoints (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  acp_session_id TEXT,
  execution_prompt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX task_message_checkpoints_task_created
ON task_message_checkpoints(task_id, created_at DESC, message_id DESC);
