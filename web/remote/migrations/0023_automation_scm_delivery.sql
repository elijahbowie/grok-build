PRAGMA foreign_keys = ON;

ALTER TABLE cloud_automation_runs ADD COLUMN scm_provider TEXT CHECK (scm_provider IN ('artifacts', 'github'));
ALTER TABLE cloud_automation_runs ADD COLUMN scm_event_id TEXT REFERENCES scm_events(id) ON DELETE SET NULL;

CREATE TABLE automation_scm_triggers (
  trigger_id TEXT PRIMARY KEY REFERENCES cloud_automation_triggers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('artifacts', 'github')),
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  repositories_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(repositories_json)),
  refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refs_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE automation_delivery_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES cloud_automation_runs(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES cloud_automation_destinations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(run_id, destination_id, event_type)
);

CREATE INDEX automation_delivery_pending ON automation_delivery_attempts(status, updated_at);
