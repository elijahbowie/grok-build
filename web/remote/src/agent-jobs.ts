import { id, now } from "./db";
import type { ControlEnv, Task } from "./types";
import { resolveModelProfile } from "./model-profiles";
import { nativeToolRule } from "./runtime-security";
import Ajv from "ajv";

export type AgentJobContractInput = {
  modelProfileId?:string|null; outputSchema?:unknown; maxTurns?:number|null; allowedTools?:unknown; deniedTools?:unknown;
  webSearch?:"off"|"allow"|"require"; attachmentIds?:unknown;
};

function exactNames(value: unknown, label: string, maximum = 100, tools = false) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_.:/() *-]{1,160}$/.test(item))) throw new Error(`${label} must contain at most ${maximum} valid tool names`);
  if (tools && value.some((item)=>!nativeToolRule(item as string))) throw new Error(`${label} contains an unknown or overbroad native tool rule`);
  return [...new Set(value as string[])];
}

export function validateAgentJobContract(input: AgentJobContractInput) {
  let outputSchema:Record<string, unknown>|null = null;
  if (input.outputSchema !== undefined && input.outputSchema !== null) {
    if (!input.outputSchema || typeof input.outputSchema !== "object" || Array.isArray(input.outputSchema)) throw new Error("Output schema must be a JSON Schema object");
    const serialized = JSON.stringify(input.outputSchema);
    if (serialized.length > 32_000) throw new Error("Output schema exceeds 32,000 characters");
    try { new Ajv({strict:true,allErrors:true}).compile(input.outputSchema); }
    catch (error) { throw new Error(`Output schema is invalid: ${error instanceof Error ? error.message : "schema compilation failed"}`); }
    outputSchema = input.outputSchema as Record<string, unknown>;
  }
  const maxTurns = input.maxTurns ?? null;
  if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)) throw new Error("maxTurns must be between 1 and 1000");
  const allowedTools = exactNames(input.allowedTools, "allowedTools",100,true);
  const deniedTools = exactNames(input.deniedTools, "deniedTools",100,true);
  if (allowedTools.some((tool) => deniedTools.includes(tool))) throw new Error("A tool cannot be both allowed and denied");
  const webSearch = input.webSearch ?? "allow";
  if (!["off", "allow", "require"].includes(webSearch)) throw new Error("webSearch must be off, allow, or require");
  const attachmentIds = exactNames(input.attachmentIds, "attachmentIds", 20);
  return { modelProfileId:input.modelProfileId?.trim() || null, outputSchema, maxTurns, allowedTools, deniedTools, webSearch, attachmentIds };
}

export async function validateModelProfileSelection(env: ControlEnv, ownerSub: string, projectId: string, profileId?:string|null) {
  return profileId ? resolveModelProfile(env, ownerSub, projectId, profileId) : null;
}

export async function attachAgentJobInputs(db: D1Database, ownerSub: string, taskId: string, attachmentIds:string[]) {
  if (!attachmentIds.length) return;
  const timestamp = now(); const retainedUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
  for (const attachmentId of attachmentIds) {
    const result = await db.prepare("UPDATE agent_input_attachments SET task_id=?, expires_at=? WHERE id=? AND owner_sub=? AND task_id IS NULL AND expires_at>?").bind(taskId, retainedUntil, attachmentId, ownerSub, timestamp).run();
    if (!result.meta.changes) throw new Error(`Input attachment ${attachmentId} is unavailable or already used`);
  }
}

function cleanName(value: string) {
  const name = value.trim().replace(/[\\/\0]/g, "-").slice(0, 180);
  if (!name) throw new Error("Attachment name is required");
  return name;
}

export async function storeAgentInputAttachment(env: ControlEnv, ownerSub: string, input: {body:ArrayBuffer;name:string;contentType:string;kind?:string}) {
  if (input.body.byteLength < 1 || input.body.byteLength > 10_485_760) throw new Error("Attachment must be between 1 byte and 10 MB");
  const kind = input.kind ?? (input.contentType.startsWith("image/") ? "image" : "file");
  if (!['image', 'file'].includes(kind)) throw new Error("Attachment kind must be image or file");
  const contentType = input.contentType.trim().toLowerCase().slice(0, 160);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType)) throw new Error("A valid attachment content type is required");
  const attachmentId = id("att"); const timestamp = now(); const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const digest = await crypto.subtle.digest("SHA-256", input.body);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const r2Key = `agent-inputs/${ownerSub.replace(/[^A-Za-z0-9_-]/g, "_")}/${attachmentId}`;
  await env.EVIDENCE_BUCKET.put(r2Key, input.body, { httpMetadata:{ contentType }, customMetadata:{ attachmentId, sha256 } });
  try {
    await env.CONTROL_DB.prepare("INSERT INTO agent_input_attachments (id, owner_sub, kind, name, content_type, size_bytes, sha256, r2_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(attachmentId, ownerSub, kind, cleanName(input.name), contentType, input.body.byteLength, sha256, r2Key, timestamp, expiresAt).run();
  } catch (error) { await env.EVIDENCE_BUCKET.delete(r2Key); throw error; }
  return { id:attachmentId, kind, name:cleanName(input.name), contentType, sizeBytes:input.body.byteLength, sha256, expiresAt };
}

export async function listTaskInputAttachments(db: D1Database, ownerSub: string, taskId: string) {
  const rows = await db.prepare("SELECT id, kind, name, content_type, size_bytes, sha256, created_at FROM agent_input_attachments WHERE owner_sub=? AND task_id=? ORDER BY created_at").bind(ownerSub, taskId).all<{id:string;kind:string;name:string;content_type:string;size_bytes:number;sha256:string;created_at:string}>();
  return rows.results.map((row) => ({ id:row.id, kind:row.kind, name:row.name, contentType:row.content_type, sizeBytes:row.size_bytes, sha256:row.sha256, createdAt:row.created_at }));
}

// Runtime-only view. Do not pass this result to an HTTP response because it contains private object keys.
export async function resolveTaskInputAttachments(db: D1Database, ownerSub: string, taskId: string) {
  const rows = await db.prepare("SELECT id, kind, name, content_type, size_bytes, sha256, r2_key FROM agent_input_attachments WHERE owner_sub=? AND task_id=? ORDER BY created_at").bind(ownerSub, taskId).all<{id:string;kind:"image"|"file";name:string;content_type:string;size_bytes:number;sha256:string;r2_key:string}>();
  return rows.results.map((row) => ({ id:row.id, kind:row.kind, name:row.name, contentType:row.content_type, sizeBytes:row.size_bytes, sha256:row.sha256, r2Key:row.r2_key }));
}

export async function cleanupExpiredAgentInputAttachments(env: ControlEnv, limit = 100) {
  const rows=await env.CONTROL_DB.prepare("SELECT id, r2_key FROM agent_input_attachments WHERE expires_at<=? ORDER BY expires_at LIMIT ?").bind(now(),Math.max(1,Math.min(limit,500))).all<{id:string;r2_key:string}>();
  for (const row of rows.results) {
    await env.EVIDENCE_BUCKET.delete(row.r2_key);
    await env.CONTROL_DB.prepare("DELETE FROM agent_input_attachments WHERE id=? AND expires_at<=?").bind(row.id,now()).run();
  }
  return rows.results.length;
}

export function presentAgentJobContract(task: Task) {
  return {
    modelProfileId:task.model_profile_id ?? null,
    outputSchema:task.output_schema_json ? JSON.parse(task.output_schema_json) as Record<string, unknown> : null,
    maxTurns:task.max_turns ?? null,
    allowedTools:JSON.parse(task.allowed_tools_json || "[]") as string[],
    deniedTools:JSON.parse(task.denied_tools_json || "[]") as string[],
    webSearch:task.web_search_mode || "allow",
  };
}
