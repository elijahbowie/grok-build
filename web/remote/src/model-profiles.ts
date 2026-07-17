import { decryptSecret, encryptSecret } from "./connectors";
import { id, now } from "./db";
import type { ControlEnv } from "./types";

export const modelBackends = ["grok-subscription", "openai-compatible", "openai-responses", "anthropic"] as const;
export type ModelBackend = typeof modelBackends[number];
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

type ModelProfileRow = {
  id:string; owner_sub:string; organization_id:string|null; project_id:string|null; name:string; backend:ModelBackend;
  model_id:string; base_url:string|null; credential_ciphertext:string|null; reasoning_effort:ReasoningEffort|null;
  context_window:number|null; input_cost_micros_per_million:number; output_cost_micros_per_million:number;
  allowed:number; metadata_json:string; created_at:string; updated_at:string;
};

export type ModelProfileInput = {
  organizationId?:string|null; projectId?:string|null; name?:string; backend?:string; modelId?:string; baseUrl?:string|null;
  credential?:string|null; reasoningEffort?:string|null; contextWindow?:number|null; inputCostMicrosPerMillion?:number;
  outputCostMicrosPerMillion?:number; allowed?:boolean; metadata?:Record<string, unknown>;
};

function bounded(value: unknown, label: string, max: number) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new Error(`${label} is required and must be at most ${max} characters`);
  return result;
}

function optionalPublicHttps(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const url = new URL(String(value));
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.hostname.endsWith(".local")) throw new Error("Model base URL must be a public HTTPS URL");
  url.username = ""; url.password = "";
  return url.toString().replace(/\/$/, "");
}

function nonnegativeInteger(value: unknown, label: string, fallback = 0) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

export function validateModelProfileInput(input: ModelProfileInput) {
  const backend = input.backend as ModelBackend;
  if (!modelBackends.includes(backend)) throw new Error("Unsupported model backend");
  const reasoningEffort = input.reasoningEffort ?? null;
  if (reasoningEffort !== null && !["none", "low", "medium", "high", "xhigh"].includes(reasoningEffort)) throw new Error("Unsupported reasoning effort");
  const contextWindow = input.contextWindow ?? null;
  if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 10_000_000)) throw new Error("Context window must be between 1 and 10,000,000 tokens");
  const baseUrl = optionalPublicHttps(input.baseUrl);
  if (backend !== "grok-subscription" && !baseUrl) throw new Error("This model backend requires a base URL");
  const metadata = input.metadata ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || JSON.stringify(metadata).length > 8_000) throw new Error("Model metadata must be a small JSON object");
  return {
    name:bounded(input.name, "Model profile name", 120), backend, modelId:bounded(input.modelId, "Model ID", 200), baseUrl,
    reasoningEffort:reasoningEffort as ReasoningEffort|null, contextWindow,
    inputCostMicrosPerMillion:nonnegativeInteger(input.inputCostMicrosPerMillion, "Input cost"),
    outputCostMicrosPerMillion:nonnegativeInteger(input.outputCostMicrosPerMillion, "Output cost"),
    allowed:input.allowed !== false, metadata,
  };
}

function present(row: ModelProfileRow) {
  return {
    id:row.id, organizationId:row.organization_id, projectId:row.project_id, name:row.name, backend:row.backend,
    modelId:row.model_id, baseUrl:row.base_url, reasoningEffort:row.reasoning_effort, contextWindow:row.context_window,
    inputCostMicrosPerMillion:row.input_cost_micros_per_million, outputCostMicrosPerMillion:row.output_cost_micros_per_million,
    allowed:Boolean(row.allowed), metadata:JSON.parse(row.metadata_json) as Record<string, unknown>, hasCredential:Boolean(row.credential_ciphertext),
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

export async function createModelProfile(env: ControlEnv, ownerSub: string, input: ModelProfileInput) {
  const value = validateModelProfileInput(input); const profileId = id("mdl"); const timestamp = now();
  const credential = typeof input.credential === "string" && input.credential.trim() ? await encryptSecret(env, input.credential.trim()) : null;
  await env.CONTROL_DB.prepare(`INSERT INTO model_profiles
    (id, owner_sub, organization_id, project_id, name, backend, model_id, base_url, credential_ciphertext, reasoning_effort, context_window, input_cost_micros_per_million, output_cost_micros_per_million, allowed, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(profileId, ownerSub, input.organizationId ?? null, input.projectId ?? null, value.name, value.backend, value.modelId, value.baseUrl, credential, value.reasoningEffort, value.contextWindow, value.inputCostMicrosPerMillion, value.outputCostMicrosPerMillion, value.allowed ? 1 : 0, JSON.stringify(value.metadata), timestamp, timestamp).run();
  return present((await env.CONTROL_DB.prepare("SELECT * FROM model_profiles WHERE id=?").bind(profileId).first<ModelProfileRow>())!);
}

export async function listModelProfiles(db: D1Database, ownerSub: string, projectId?:string|null) {
  const rows = projectId
    ? await db.prepare(`SELECT mp.* FROM model_profiles mp JOIN projects p ON p.id=? WHERE
        mp.project_id=p.id OR (mp.project_id IS NULL AND ((mp.organization_id IS NOT NULL AND mp.organization_id=p.organization_id) OR (mp.organization_id IS NULL AND mp.owner_sub=p.owner_sub)))
        ORDER BY mp.project_id DESC, mp.name`).bind(projectId).all<ModelProfileRow>()
    : await db.prepare("SELECT * FROM model_profiles WHERE owner_sub=? ORDER BY project_id, name").bind(ownerSub).all<ModelProfileRow>();
  return rows.results.map(present);
}

export async function setModelProfileAllowed(db: D1Database, ownerSub: string, profileId: string, allowed: boolean) {
  const result = await db.prepare("UPDATE model_profiles SET allowed=?, updated_at=? WHERE id=? AND owner_sub=?").bind(allowed ? 1 : 0, now(), profileId, ownerSub).run();
  if (!result.meta.changes) throw new Error("Model profile not found");
}

export async function resolveModelProfile(env: ControlEnv, ownerSub: string, projectId: string, profileId: string) {
  const row = await env.CONTROL_DB.prepare(`SELECT mp.* FROM model_profiles mp JOIN projects p ON p.id=? WHERE mp.id=? AND mp.allowed=1 AND
    (mp.project_id=p.id OR (mp.project_id IS NULL AND ((mp.organization_id IS NOT NULL AND mp.organization_id=p.organization_id) OR (mp.organization_id IS NULL AND mp.owner_sub=?))))`)
    .bind(projectId, profileId, ownerSub).first<ModelProfileRow>();
  if (!row) throw new Error("The selected model profile is unavailable or disallowed");
  return { ...present(row), credential:row.credential_ciphertext ? await decryptSecret(env, row.credential_ciphertext) : null };
}
