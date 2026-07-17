PRAGMA foreign_keys = ON;

CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('grok-subscription', 'openai-compatible', 'openai-responses', 'anthropic')),
  model_id TEXT NOT NULL,
  base_url TEXT,
  credential_ciphertext TEXT CHECK (credential_ciphertext IS NULL OR json_valid(credential_ciphertext)),
  reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh')),
  context_window INTEGER CHECK (context_window IS NULL OR context_window > 0),
  input_cost_micros_per_million INTEGER NOT NULL DEFAULT 0 CHECK (input_cost_micros_per_million >= 0),
  output_cost_micros_per_million INTEGER NOT NULL DEFAULT 0 CHECK (output_cost_micros_per_million >= 0),
  allowed INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_sub, project_id, name)
);

ALTER TABLE tasks ADD COLUMN model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN output_schema_json TEXT CHECK (output_schema_json IS NULL OR json_valid(output_schema_json));
ALTER TABLE tasks ADD COLUMN max_turns INTEGER CHECK (max_turns IS NULL OR max_turns BETWEEN 1 AND 1000);
ALTER TABLE tasks ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_tools_json));
ALTER TABLE tasks ADD COLUMN denied_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(denied_tools_json));
ALTER TABLE tasks ADD COLUMN web_search_mode TEXT NOT NULL DEFAULT 'allow' CHECK (web_search_mode IN ('off', 'allow', 'require'));

CREATE TABLE agent_input_attachments (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX model_profiles_owner_scope ON model_profiles(owner_sub, project_id, allowed);
CREATE INDEX agent_input_attachments_owner_task ON agent_input_attachments(owner_sub, task_id, created_at);
