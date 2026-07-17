import { id, now } from "./db";

export const agentApiScopes = ["agents:read", "agents:write", "agents:cancel", "events:read", "webhooks:write"] as const;
export type AgentApiScope = typeof agentApiScopes[number];

export type AgentApiIdentity = {
  keyId:string;
  ownerSub:string;
  organizationId:string|null;
  scopes:AgentApiScope[];
  projectIds:string[];
};

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactScopes(value: unknown): AgentApiScope[] {
  if (!Array.isArray(value) || !value.length || value.some((scope) => typeof scope !== "string" || !agentApiScopes.includes(scope as AgentApiScope))) throw new Error("Agent API scopes are invalid");
  return [...new Set(value as AgentApiScope[])];
}

export async function createAgentApiKey(db: D1Database, input: {ownerSub:string;organizationId?:string|null;label:string;scopes:unknown;projectIds?:unknown;expiresAt?:string|null}) {
  const label = input.label?.trim().slice(0, 120);
  if (!label) throw new Error("API key label is required");
  const scopes = exactScopes(input.scopes);
  const projectIds = Array.isArray(input.projectIds) ? [...new Set(input.projectIds.map(String))] : [];
  if (projectIds.some((value) => !/^[A-Za-z0-9_-]{1,160}$/.test(value))) throw new Error("API key project scope is invalid");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw new Error("API key expiry must be in the future");
  const secret = new Uint8Array(32); crypto.getRandomValues(secret);
  const plaintext = `gbk_${base64url(secret)}`; const keyId = id("akey"); const timestamp = now();
  await db.prepare("INSERT INTO agent_api_keys (id, owner_sub, organization_id, label, key_prefix, key_hash, scopes_json, project_ids_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(keyId, input.ownerSub, input.organizationId ?? null, label, plaintext.slice(0, 12), await hash(plaintext), JSON.stringify(scopes), JSON.stringify(projectIds), expiresAt?.toISOString() ?? null, timestamp).run();
  return { id:keyId, label, prefix:plaintext.slice(0, 12), plaintext, scopes, projectIds, expiresAt:expiresAt?.toISOString() ?? null, createdAt:timestamp };
}

export async function authenticateAgentApiKey(request: Request, db: D1Database): Promise<AgentApiIdentity|null> {
  const plaintext = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!plaintext.startsWith("gbk_") || plaintext.length < 40) return null;
  const row = await db.prepare("SELECT * FROM agent_api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)").bind(await hash(plaintext), now()).first<{id:string;owner_sub:string;organization_id:string|null;scopes_json:string;project_ids_json:string}>();
  if (!row) return null;
  await db.prepare("UPDATE agent_api_keys SET last_used_at=? WHERE id=?").bind(now(), row.id).run();
  return { keyId:row.id, ownerSub:row.owner_sub, organizationId:row.organization_id, scopes:JSON.parse(row.scopes_json), projectIds:JSON.parse(row.project_ids_json) };
}

export function requireAgentApiScope(identity: AgentApiIdentity, scope: AgentApiScope) {
  if (!identity.scopes.includes(scope)) throw new Error(`Agent API scope ${scope} is required`);
}

export function agentApiProjectAllowed(identity: AgentApiIdentity, projectId: string) {
  return identity.projectIds.length === 0 || identity.projectIds.includes(projectId);
}

export async function listAgentApiKeys(db: D1Database, ownerSub: string) {
  const rows = await db.prepare("SELECT id, organization_id, label, key_prefix, scopes_json, project_ids_json, expires_at, last_used_at, revoked_at, created_at FROM agent_api_keys WHERE owner_sub=? ORDER BY created_at DESC").bind(ownerSub).all<{id:string;organization_id:string|null;label:string;key_prefix:string;scopes_json:string;project_ids_json:string;expires_at:string|null;last_used_at:string|null;revoked_at:string|null;created_at:string}>();
  return rows.results.map((row) => ({ id:row.id, organizationId:row.organization_id, label:row.label, prefix:row.key_prefix, scopes:JSON.parse(row.scopes_json) as AgentApiScope[], projectIds:JSON.parse(row.project_ids_json) as string[], expiresAt:row.expires_at, lastUsedAt:row.last_used_at, revokedAt:row.revoked_at, createdAt:row.created_at }));
}

export async function revokeAgentApiKey(db: D1Database, ownerSub: string, keyId: string) {
  const result = await db.prepare("UPDATE agent_api_keys SET revoked_at=? WHERE id=? AND owner_sub=? AND revoked_at IS NULL").bind(now(), keyId, ownerSub).run();
  if (!result.meta.changes) throw new Error("Active API key not found");
}

export async function idempotentResponse(db: D1Database, input: {identity:AgentApiIdentity;key:string;requestDigest:string;execute:()=>Promise<Response>}) {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.key)) throw new Error("Idempotency-Key must be 8-200 safe characters");
  const existing = await db.prepare("SELECT request_digest, response_status, response_json FROM agent_api_idempotency WHERE api_key_id=? AND idempotency_key=? AND expires_at>?").bind(input.identity.keyId, input.key, now()).first<{request_digest:string;response_status:number;response_json:string}>();
  if (existing) {
    if (existing.request_digest !== input.requestDigest) throw new Error("Idempotency-Key was reused with a different request");
    return new Response(existing.response_json, { status:existing.response_status, headers:{ "content-type":"application/json; charset=utf-8", "cache-control":"no-store" } });
  }
  const response = await input.execute(); const body = await response.clone().text();
  await db.prepare("INSERT INTO agent_api_idempotency (owner_sub, api_key_id, idempotency_key, request_digest, response_status, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(input.identity.ownerSub, input.identity.keyId, input.key, input.requestDigest, response.status, body || "{}", now(), new Date(Date.now() + 86_400_000).toISOString()).run();
  return response;
}

export async function requestDigest(request: Request, body: string) {
  return hash(`${request.method}\n${new URL(request.url).pathname}\n${body}`);
}
