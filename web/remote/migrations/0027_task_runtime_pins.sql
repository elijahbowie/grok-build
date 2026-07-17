PRAGMA foreign_keys = ON;

CREATE TABLE task_runtime_pins (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  policy_layers_json TEXT NOT NULL CHECK (json_valid(policy_layers_json)),
  marketplace_items_json TEXT NOT NULL CHECK (json_valid(marketplace_items_json)),
  digest TEXT NOT NULL,
  pinned_at TEXT NOT NULL
);
