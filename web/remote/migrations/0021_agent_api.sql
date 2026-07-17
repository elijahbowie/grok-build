PRAGMA foreign_keys = ON;

CREATE TABLE agent_api_keys (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  project_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(project_ids_json)),
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_api_webhooks (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL CHECK (json_valid(secret_ciphertext)),
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_api_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES agent_api_webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(webhook_id, event_id)
);

CREATE TABLE agent_api_idempotency (
  owner_sub TEXT NOT NULL,
  api_key_id TEXT NOT NULL REFERENCES agent_api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, idempotency_key)
);

CREATE INDEX agent_api_keys_owner ON agent_api_keys(owner_sub, revoked_at, expires_at);
CREATE INDEX agent_api_deliveries_pending ON agent_api_deliveries(status, next_attempt_at);
