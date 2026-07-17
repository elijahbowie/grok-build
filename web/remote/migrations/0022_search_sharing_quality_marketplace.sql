PRAGMA foreign_keys = ON;

CREATE VIRTUAL TABLE task_search USING fts5(
  task_id UNINDEXED,
  owner_sub UNINDEXED,
  project_id UNINDEXED,
  title,
  prompt,
  transcript,
  paths,
  tokenize='porter unicode61'
);

CREATE TABLE task_shares (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'review')),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE task_share_comments (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES task_shares(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_label TEXT NOT NULL,
  body TEXT NOT NULL,
  file_path TEXT,
  line INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE review_rule_candidates (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  source_fingerprints_json TEXT NOT NULL CHECK (json_valid(source_fingerprints_json)),
  positive_signals INTEGER NOT NULL DEFAULT 0,
  negative_signals INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'rejected', 'disabled')),
  approved_rule_id TEXT REFERENCES customization_rules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE marketplace_items (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mcp', 'plugin', 'skill', 'rule', 'command', 'hook', 'subagent')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  trust_status TEXT NOT NULL DEFAULT 'pending' CHECK (trust_status IN ('pending', 'approved', 'rejected', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, kind, name, version)
);

CREATE TABLE marketplace_grants (
  item_id TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('organization', 'group', 'project', 'member')),
  subject_id TEXT NOT NULL,
  installed_by_sub TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (item_id, subject_type, subject_id)
);

CREATE INDEX task_shares_task ON task_shares(task_id, revoked_at, expires_at);
CREATE INDEX review_rule_candidates_project ON review_rule_candidates(project_id, status, updated_at DESC);
CREATE INDEX marketplace_items_org ON marketplace_items(organization_id, trust_status, kind);

INSERT INTO task_search (task_id, owner_sub, project_id, title, prompt, transcript, paths)
SELECT t.id, t.owner_sub, t.project_id, t.title, t.prompt,
       COALESCE((SELECT group_concat(m.body, char(10)) FROM messages m WHERE m.task_id=t.id), ''),
       ''
FROM tasks t;
