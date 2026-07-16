import { id, now } from "./db";

export type AutomationStatus = "enabled" | "paused" | "disabled";
export type AutomationTriggerType = "manual" | "cron" | "github" | "webhook";
export type AutomationRunStatus = "queued" | "running" | "review" | "completed" | "failed" | "cancelled" | "skipped" | "rate_limited";
export type SafeSchedule =
  | { kind: "interval"; minutes: number; anchor: string }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number };

export type ManualTriggerConfig = { type: "manual" };
export type CronTriggerConfig = { type: "cron"; schedule: SafeSchedule };
export type GithubTriggerConfig = {
  type: "github";
  events: Array<"push" | "pull_request">;
  actions: string[];
  branches: string[];
  pathPrefixes: string[];
};
export type WebhookTriggerConfig = {
  type: "webhook";
  filters: Array<{ path: string; value: string | number | boolean | null }>;
};
export type AutomationTriggerConfig = ManualTriggerConfig | CronTriggerConfig | GithubTriggerConfig | WebhookTriggerConfig;

export type AutomationDefinition = {
  id: string;
  projectId: string;
  ownerSub: string;
  name: string;
  prompt: string;
  model: string;
  status: AutomationStatus;
  revision: number;
  environmentVersionId: string;
  targetRepositoryId: string;
  securityPolicyRevisionId: string;
  ruleRevisionIds: string[];
  concurrencyPolicy: "skip" | "queue";
  concurrencyLimit: number;
  rateLimitCount: number;
  rateLimitWindowSeconds: number;
  createdBySub: string;
  createdAt: string;
  updatedAt: string;
};

export type AutomationTrigger = {
  id: string;
  automationId: string;
  type: AutomationTriggerType;
  config: AutomationTriggerConfig;
  secretRef: string | null;
  enabled: boolean;
  nextDueAt: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  projectId: string;
  ownerSub: string;
  triggerId: string | null;
  triggerType: AutomationTriggerType;
  idempotencyKey: string;
  status: AutomationRunStatus;
  reason: string | null;
  sourceProvenance: Record<string, unknown>;
  definitionRevision: number;
  environmentVersionId: string;
  targetRepositoryId: string;
  securityPolicyRevisionId: string;
  ruleRevisionIds: string[];
  taskId: string | null;
  autoPromote: false;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

type DefinitionRow = {
  id:string; project_id:string; owner_sub:string; name:string; prompt:string; model:string; status:AutomationStatus;
  revision:number; environment_version_id:string; target_repository_id:string; security_policy_revision_id:string;
  concurrency_policy:"skip"|"queue"; concurrency_limit:number; rate_limit_count:number; rate_limit_window_seconds:number;
  created_by_sub:string; created_at:string; updated_at:string;
};
type TriggerRow = {
  id:string; automation_id:string; type:AutomationTriggerType; config_json:string; secret_ref:string|null; enabled:number;
  next_due_at:string|null; last_fired_at:string|null; created_at:string; updated_at:string;
};
type RunRow = {
  id:string; automation_id:string; project_id:string; owner_sub:string; trigger_id:string|null; trigger_type:AutomationTriggerType;
  idempotency_key:string; status:AutomationRunStatus; reason:string|null; source_provenance_json:string; definition_revision:number;
  environment_version_id:string; target_repository_id:string; security_policy_revision_id:string; rule_revision_ids_json:string;
  task_id:string|null; auto_promote:0; error:string|null; created_at:string; started_at:string|null; completed_at:string|null; updated_at:string;
};

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const BRANCH = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\\))[a-zA-Z0-9._/-]{1,200}(?<![./])$/;
const RULE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export class AutomationValidationError extends Error {
  constructor(message: string) { super(message); this.name = "AutomationValidationError"; }
}

function fail(message: string): never { throw new AutomationValidationError(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${label} contains unknown field: ${unknown}`);
}
function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) fail(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value.trim();
}
function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  return Number(value);
}
function exactStrings(value: unknown, label: string, maximum: number, pattern = IDENTIFIER) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must contain at most ${maximum} values`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 200));
  if (result.some((item) => !pattern.test(item))) fail(`${label} contains an invalid value`);
  if (new Set(result).size !== result.length) fail(`${label} cannot contain duplicates`);
  return result.sort();
}
function iso(value: unknown, label: string) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO date`);
  return new Date(value).toISOString();
}

export function validateSafeSchedule(value: unknown): SafeSchedule {
  const input = object(value, "schedule");
  if (input.kind === "interval") {
    exactKeys(input, ["kind", "minutes", "anchor"], "schedule");
    const minutes = integer(input.minutes, "schedule.minutes", 5, 1_440);
    return { kind: "interval", minutes, anchor: iso(input.anchor, "schedule.anchor") };
  }
  if (input.kind !== "daily" && input.kind !== "weekly") fail("schedule.kind must be interval, daily, or weekly");
  exactKeys(input, input.kind === "daily" ? ["kind", "hour", "minute"] : ["kind", "weekdays", "hour", "minute"], "schedule");
  const hour = integer(input.hour, "schedule.hour", 0, 23);
  const minute = integer(input.minute, "schedule.minute", 0, 59);
  if (input.kind === "daily") return { kind: "daily", hour, minute };
  if (input.kind === "weekly") {
    if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7) fail("schedule.weekdays must contain 1 to 7 days");
    const weekdays = [...new Set(input.weekdays.map((day, index) => integer(day, `schedule.weekdays[${index}]`, 0, 6)))].sort();
    if (weekdays.length !== input.weekdays.length) fail("schedule.weekdays cannot contain duplicates");
    return { kind: "weekly", weekdays, hour, minute };
  }
  return fail("schedule.kind must be interval, daily, or weekly");
}

export function nextScheduledTime(scheduleValue: unknown, afterValue: string | Date): string {
  const schedule = validateSafeSchedule(scheduleValue);
  const after = new Date(afterValue);
  if (!Number.isFinite(after.getTime())) fail("after must be a valid date");
  if (schedule.kind === "interval") {
    const anchor = Date.parse(schedule.anchor);
    const period = schedule.minutes * 60_000;
    const next = anchor > after.getTime() ? anchor : anchor + (Math.floor((after.getTime() - anchor) / period) + 1) * period;
    return new Date(next).toISOString();
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + offset, schedule.hour, schedule.minute));
    if (candidate <= after) continue;
    if (schedule.kind === "daily" || schedule.weekdays.includes(candidate.getUTCDay())) return candidate.toISOString();
  }
  return fail("Unable to calculate the next schedule time");
}

export function validateTriggerConfig(type: AutomationTriggerType, value: unknown): AutomationTriggerConfig {
  const input = object(value, "trigger config");
  if (type === "manual") { exactKeys(input, ["type"], "manual trigger config"); return { type }; }
  if (type === "cron") { exactKeys(input, ["type", "schedule"], "cron trigger config"); return { type, schedule: validateSafeSchedule(input.schedule) }; }
  if (type === "github") {
    exactKeys(input, ["type", "events", "actions", "branches", "pathPrefixes"], "GitHub trigger config");
    const events = exactStrings(input.events, "events", 2) as Array<"push"|"pull_request">;
    if (!events.length || events.some((event) => event !== "push" && event !== "pull_request")) fail("events must contain push or pull_request");
    const actions = exactStrings(input.actions ?? [], "actions", 20);
    const branches = exactStrings(input.branches ?? [], "branches", 100, BRANCH);
    const pathPrefixes = exactStrings(input.pathPrefixes ?? [], "pathPrefixes", 100, /^[a-zA-Z0-9._/-]{1,200}$/);
    if (pathPrefixes.some((path) => path.startsWith("/") || path.endsWith("/") || path.includes("..") || path.includes("//"))) fail("pathPrefixes must be safe relative paths");
    return { type, events, actions, branches, pathPrefixes };
  }
  exactKeys(input, ["type", "filters"], "webhook trigger config");
  if (!Array.isArray(input.filters) || input.filters.length > 32) fail("filters must contain at most 32 exact matches");
  const filters = input.filters.map((raw, index) => {
    const filter = object(raw, `filters[${index}]`);
    const path = text(filter.path, `filters[${index}].path`, 200);
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){0,9}$/.test(path)) fail(`filters[${index}].path is invalid`);
    if (path.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) fail(`filters[${index}].path is unsafe`);
    if (!(filter.value === null || ["string", "number", "boolean"].includes(typeof filter.value))) fail(`filters[${index}].value must be a scalar`);
    if (typeof filter.value === "number" && !Number.isFinite(filter.value)) fail(`filters[${index}].value must be finite`);
    return { path, value: filter.value as string|number|boolean|null };
  });
  if (new Set(filters.map((filter) => filter.path)).size !== filters.length) fail("filters cannot repeat a path");
  return { type, filters };
}

function atPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function matchesWebhookTrigger(configValue: unknown, payload: unknown) {
  const config = validateTriggerConfig("webhook", configValue) as WebhookTriggerConfig;
  return config.filters.every((filter) => Object.is(atPath(payload, filter.path), filter.value));
}

export function matchesGithubTrigger(configValue: unknown, event: { event:string; action?:string|null; branch?:string|null; changedPaths?:string[] }) {
  const config = validateTriggerConfig("github", configValue) as GithubTriggerConfig;
  if (!config.events.includes(event.event as "push"|"pull_request")) return false;
  if (config.actions.length && (!event.action || !config.actions.includes(event.action))) return false;
  if (config.branches.length && (!event.branch || !config.branches.includes(event.branch))) return false;
  if (config.pathPrefixes.length && !(event.changedPaths ?? []).some((path) => config.pathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))) return false;
  return true;
}

function bytesToHex(value: ArrayBuffer) { return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function signWebhookBody(input: { secret:string; body:string; timestamp:string }) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${input.timestamp}.${input.body}`)))}`;
}

export async function verifyWebhookHmac(input: { secret:string; body:string; timestamp:string; signature:string; now?:Date; maxSkewSeconds?:number }) {
  if (!input.secret || input.secret.length < 16 || input.secret.length > 4096) return false;
  if (!/^\d{10,13}$/.test(input.timestamp) || !/^sha256=[a-f0-9]{64}$/i.test(input.signature)) return false;
  const raw = Number(input.timestamp);
  const time = input.timestamp.length === 10 ? raw * 1_000 : raw;
  const at = (input.now ?? new Date()).getTime();
  const skew = (input.maxSkewSeconds ?? 300) * 1_000;
  if (!Number.isFinite(time) || Math.abs(at - time) > skew) return false;
  return constantTimeEqual((await signWebhookBody(input)).toLowerCase(), input.signature.toLowerCase());
}

export function decideAutomationAdmission(input: { recentRuns:number; activeRuns:number; rateLimitCount:number; concurrencyLimit:number; concurrencyPolicy:"skip"|"queue" }) {
  if (input.recentRuns >= input.rateLimitCount) return { status:"rate_limited" as const, admitted:false, reason:"rate-limit-exceeded" };
  if (input.concurrencyPolicy === "skip" && input.activeRuns >= input.concurrencyLimit) return { status:"skipped" as const, admitted:false, reason:"concurrency-limit-reached" };
  return { status:"queued" as const, admitted:true, reason:null };
}

function safeJsonRecord(value: unknown, label: string, maximum = 16_000): Record<string, unknown> {
  const result = object(value, label);
  const serialized = JSON.stringify(result);
  if (serialized.length > maximum) fail(`${label} is too large`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function definitionFromRow(row: DefinitionRow, ruleRevisionIds: string[]): AutomationDefinition {
  return { id:row.id, projectId:row.project_id, ownerSub:row.owner_sub, name:row.name, prompt:row.prompt, model:row.model, status:row.status, revision:row.revision, environmentVersionId:row.environment_version_id, targetRepositoryId:row.target_repository_id, securityPolicyRevisionId:row.security_policy_revision_id, ruleRevisionIds, concurrencyPolicy:row.concurrency_policy, concurrencyLimit:row.concurrency_limit, rateLimitCount:row.rate_limit_count, rateLimitWindowSeconds:row.rate_limit_window_seconds, createdBySub:row.created_by_sub, createdAt:row.created_at, updatedAt:row.updated_at };
}
function triggerFromRow(row: TriggerRow): AutomationTrigger {
  return { id:row.id, automationId:row.automation_id, type:row.type, config:validateTriggerConfig(row.type, JSON.parse(row.config_json)), secretRef:row.secret_ref, enabled:Boolean(row.enabled), nextDueAt:row.next_due_at, lastFiredAt:row.last_fired_at, createdAt:row.created_at, updatedAt:row.updated_at };
}
function runFromRow(row: RunRow): AutomationRun {
  return { id:row.id, automationId:row.automation_id, projectId:row.project_id, ownerSub:row.owner_sub, triggerId:row.trigger_id, triggerType:row.trigger_type, idempotencyKey:row.idempotency_key, status:row.status, reason:row.reason, sourceProvenance:JSON.parse(row.source_provenance_json), definitionRevision:row.definition_revision, environmentVersionId:row.environment_version_id, targetRepositoryId:row.target_repository_id, securityPolicyRevisionId:row.security_policy_revision_id, ruleRevisionIds:JSON.parse(row.rule_revision_ids_json), taskId:row.task_id, autoPromote:false, error:row.error, createdAt:row.created_at, startedAt:row.started_at, completedAt:row.completed_at, updatedAt:row.updated_at };
}

async function ruleIds(db: D1Database, automationId: string) {
  return (await db.prepare("SELECT rule_revision_id FROM cloud_automation_rules WHERE automation_id = ? ORDER BY position").bind(automationId).all<{rule_revision_id:string}>()).results.map((row) => row.rule_revision_id);
}

export async function getAutomation(db: D1Database, ownerSub: string, automationId: string) {
  const row = await db.prepare("SELECT * FROM cloud_automations WHERE id = ? AND owner_sub = ?").bind(automationId, ownerSub).first<DefinitionRow>();
  return row ? definitionFromRow(row, await ruleIds(db, row.id)) : null;
}

export async function listAutomations(db: D1Database, ownerSub: string, projectId: string) {
  const rows = (await db.prepare("SELECT * FROM cloud_automations WHERE owner_sub = ? AND project_id = ? ORDER BY updated_at DESC").bind(ownerSub, projectId).all<DefinitionRow>()).results;
  return Promise.all(rows.map(async (row) => definitionFromRow(row, await ruleIds(db, row.id))));
}

export async function createAutomation(db: D1Database, input: { ownerSub:string; actorSub:string; projectId:string; name:string; prompt:string; model:string; environmentVersionId:string; targetRepositoryId:string; securityPolicyRevisionId:string; ruleRevisionIds?:string[]; concurrencyPolicy?:"skip"|"queue"; concurrencyLimit?:number; rateLimitCount?:number; rateLimitWindowSeconds?:number }) {
  const name = text(input.name, "name", 120);
  const prompt = text(input.prompt, "prompt", 32_000);
  const model = text(input.model, "model", 160);
  const rules = exactStrings(input.ruleRevisionIds ?? [], "ruleRevisionIds", 100, RULE_ID);
  const policy = input.concurrencyPolicy ?? "skip";
  if (policy !== "skip" && policy !== "queue") fail("concurrencyPolicy must be skip or queue");
  const concurrencyLimit = integer(input.concurrencyLimit ?? 1, "concurrencyLimit", 1, 8);
  const rateLimitCount = integer(input.rateLimitCount ?? 20, "rateLimitCount", 1, 1_000);
  const rateLimitWindowSeconds = integer(input.rateLimitWindowSeconds ?? 3_600, "rateLimitWindowSeconds", 60, 86_400);
  const identifier = id("auto"); const timestamp = now();
  const bindings = await db.prepare(`SELECT p.id AS project_id FROM projects p
    JOIN environment_versions ev ON ev.id = ? AND ev.project_id = p.id AND ev.owner_sub = p.owner_sub
    JOIN environment_repositories er ON er.id = ? AND er.environment_version_id = ev.id AND er.writable = 1
    JOIN security_policy_revisions sp ON sp.id = ? AND sp.project_id = p.id
    WHERE p.id = ? AND p.owner_sub = ?`).bind(input.environmentVersionId, input.targetRepositoryId, input.securityPolicyRevisionId, input.projectId, input.ownerSub).first<{project_id:string}>();
  if (!bindings) fail("Project or exact environment, writable repository, and security policy binding was not found");
  if (rules.length) {
    const placeholders = rules.map(() => "?").join(",");
    const found = await db.prepare(`SELECT COUNT(*) AS count FROM customization_rule_revisions rr JOIN customization_rules r ON r.id = rr.rule_id WHERE rr.id IN (${placeholders}) AND r.owner_sub = ? AND (r.project_id IS NULL OR r.project_id = ?)`).bind(...rules, input.ownerSub, input.projectId).first<{count:number}>();
    if (found?.count !== rules.length) fail("One or more rule revisions are not owned by this user or project");
  }
  await db.batch([
    db.prepare("INSERT INTO cloud_automations (id, project_id, owner_sub, name, prompt, model, status, environment_version_id, target_repository_id, security_policy_revision_id, concurrency_policy, concurrency_limit, rate_limit_count, rate_limit_window_seconds, created_by_sub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(identifier, input.projectId, input.ownerSub, name, prompt, model, input.environmentVersionId, input.targetRepositoryId, input.securityPolicyRevisionId, policy, concurrencyLimit, rateLimitCount, rateLimitWindowSeconds, input.actorSub, timestamp, timestamp),
    ...rules.map((ruleId, position) => db.prepare("INSERT INTO cloud_automation_rules (automation_id, rule_revision_id, position) VALUES (?, ?, ?)").bind(identifier, ruleId, position)),
  ]);
  return getAutomation(db, input.ownerSub, identifier);
}

export async function setAutomationStatus(db: D1Database, input: { ownerSub:string; actorSub:string; automationId:string; status:AutomationStatus; confirmation?:string }) {
  if (!["enabled", "paused", "disabled"].includes(input.status)) fail("Invalid automation status");
  const current = await getAutomation(db, input.ownerSub, input.automationId);
  if (!current) fail("Automation not found");
  const confirmation = input.confirmation?.trim() || "status changed by owner";
  if (input.status === "enabled" && confirmation !== "Enable scheduled isolated task execution; pause or disable to stop future runs.") fail("Enabling requires the exact consequence and recovery confirmation");
  const timestamp = now();
  const [result] = await db.batch([
    db.prepare("UPDATE cloud_automations SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_sub = ? AND status=?").bind(input.status, timestamp, input.automationId, input.ownerSub, current.status),
    db.prepare("INSERT INTO cloud_automation_status_audit (id, automation_id, owner_sub, actor_sub, from_status, to_status, confirmation, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cloud_automations WHERE id=? AND owner_sub=? AND status=?)")
      .bind(id("aaudit"), input.automationId, input.ownerSub, input.actorSub, current.status, input.status, confirmation.slice(0, 2_000), timestamp, input.automationId, input.ownerSub, input.status),
  ]);
  if (!result.meta.changes) fail("Automation changed concurrently");
  return getAutomation(db, input.ownerSub, input.automationId);
}

export async function createAutomationTrigger(db: D1Database, input: { ownerSub:string; automationId:string; type:AutomationTriggerType; config:unknown; secretRef?:string|null; enabled?:boolean }) {
  const automation = await getAutomation(db, input.ownerSub, input.automationId);
  if (!automation) fail("Automation not found");
  const config = validateTriggerConfig(input.type, input.config);
  const secretRef = input.type === "webhook" ? text(input.secretRef, "secretRef", 120) : null;
  if (secretRef && !/^[A-Z][A-Z0-9_]*$/.test(secretRef)) fail("secretRef must name a Worker secret binding");
  if (input.type !== "webhook" && input.secretRef) fail("Only webhook triggers may have a secret reference");
  const timestamp = now(); const identifier = id("atrg");
  const nextDueAt = input.type === "cron" ? nextScheduledTime((config as CronTriggerConfig).schedule, timestamp) : null;
  await db.prepare("INSERT INTO cloud_automation_triggers (id, automation_id, type, config_json, secret_ref, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(identifier, automation.id, input.type, JSON.stringify(config), secretRef, input.enabled === false ? 0 : 1, nextDueAt, timestamp, timestamp).run();
  return getAutomationTrigger(db, input.ownerSub, identifier);
}

export async function getAutomationTrigger(db: D1Database, ownerSub: string, triggerId: string) {
  const row = await db.prepare("SELECT t.* FROM cloud_automation_triggers t JOIN cloud_automations a ON a.id=t.automation_id WHERE t.id=? AND a.owner_sub=?").bind(triggerId, ownerSub).first<TriggerRow>();
  return row ? triggerFromRow(row) : null;
}

export async function listAutomationTriggers(db: D1Database, ownerSub: string, automationId: string) {
  const rows = await db.prepare("SELECT t.* FROM cloud_automation_triggers t JOIN cloud_automations a ON a.id=t.automation_id WHERE t.automation_id=? AND a.owner_sub=? ORDER BY t.created_at").bind(automationId, ownerSub).all<TriggerRow>();
  return rows.results.map(triggerFromRow);
}

export async function setAutomationTriggerEnabled(db: D1Database, input: { ownerSub:string; triggerId:string; enabled:boolean }) {
  const timestamp = now();
  const result = await db.prepare("UPDATE cloud_automation_triggers SET enabled=?, updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM cloud_automations a WHERE a.id=automation_id AND a.owner_sub=?)").bind(input.enabled ? 1 : 0, timestamp, input.triggerId, input.ownerSub).run();
  if (!result.meta.changes) fail("Automation trigger not found");
  return getAutomationTrigger(db, input.ownerSub, input.triggerId);
}

function idempotencyKey(value: unknown) {
  const key = text(value, "idempotencyKey", 200);
  if (!IDENTIFIER.test(key)) fail("idempotencyKey contains unsupported characters");
  return key;
}

export async function admitAutomationRun(db: D1Database, input: { ownerSub:string; automationId:string; triggerId?:string|null; triggerType:AutomationTriggerType; idempotencyKey:string; provenance:unknown; triggerPayload?:unknown; webhookVerified?:boolean; at?:string }) {
  const automation = await getAutomation(db, input.ownerSub, input.automationId);
  if (!automation) fail("Automation not found");
  const key = idempotencyKey(input.idempotencyKey);
  const provenance = safeJsonRecord(input.provenance, "source provenance");
  const timestamp = input.at ? iso(input.at, "at") : now();
  if (automation.status !== "enabled") return { admitted:false as const, reason:`automation-${automation.status}`, run:null };
  let trigger: AutomationTrigger | null = null;
  if (input.triggerId) {
    trigger = await getAutomationTrigger(db, input.ownerSub, input.triggerId);
    if (!trigger || trigger.automationId !== automation.id || trigger.type !== input.triggerType) fail("Trigger does not belong to this automation and type");
    if (!trigger.enabled) return { admitted:false as const, reason:"trigger-disabled", run:null };
  } else if (input.triggerType !== "manual") fail("Non-manual runs require an exact trigger");

  if (trigger?.type === "cron" && trigger.nextDueAt && timestamp < trigger.nextDueAt) return { admitted:false as const, reason:"trigger-not-due", run:null };
  if (trigger?.type === "github") {
    const event = object(input.triggerPayload, "GitHub trigger payload");
    const changedPaths = event.changedPaths == null ? [] : exactStrings(event.changedPaths, "changedPaths", 2_000, /^[a-zA-Z0-9._/-]{1,200}$/);
    if (!matchesGithubTrigger(trigger.config, { event:String(event.event ?? ""), action:typeof event.action === "string" ? event.action : null, branch:typeof event.branch === "string" ? event.branch : null, changedPaths })) return { admitted:false as const, reason:"trigger-filter-mismatch", run:null };
  }
  if (trigger?.type === "webhook") {
    if (!input.webhookVerified) return { admitted:false as const, reason:"webhook-signature-not-verified", run:null };
    if (!matchesWebhookTrigger(trigger.config, input.triggerPayload)) return { admitted:false as const, reason:"trigger-filter-mismatch", run:null };
  }

  const windowStart = new Date(Date.parse(timestamp) - automation.rateLimitWindowSeconds * 1_000).toISOString();
  const runId = id("arun");
  const admitted = await db.prepare(`INSERT INTO cloud_automation_runs
    (id, automation_id, project_id, owner_sub, trigger_id, trigger_type, idempotency_key, status, reason, source_provenance_json, definition_revision, environment_version_id, target_repository_id, security_policy_revision_id, rule_revision_ids_json, auto_promote, created_at, completed_at, updated_at)
    SELECT ?, a.id, a.project_id, a.owner_sub, ?, ?, ?, 'queued', NULL, ?, a.revision, a.environment_version_id, a.target_repository_id, a.security_policy_revision_id, ?, 0, ?, NULL, ?
    FROM cloud_automations a WHERE a.id=? AND a.owner_sub=? AND a.status='enabled'
      AND NOT EXISTS (SELECT 1 FROM cloud_automation_runs d WHERE d.automation_id=a.id AND d.idempotency_key=?)
      AND (SELECT COUNT(*) FROM cloud_automation_runs r WHERE r.automation_id=a.id AND r.created_at>=? AND r.status IN ('queued','running','review','completed','failed','cancelled')) < a.rate_limit_count
      AND (a.concurrency_policy='queue' OR (SELECT COUNT(*) FROM cloud_automation_runs r WHERE r.automation_id=a.id AND r.status IN ('queued','running','review')) < a.concurrency_limit)`)
    .bind(runId, trigger?.id ?? null, input.triggerType, key, JSON.stringify(provenance), JSON.stringify(automation.ruleRevisionIds), timestamp, timestamp, automation.id, input.ownerSub, key, windowStart).run();
  if (admitted.meta.changes) return { admitted:true as const, reason:null, run:await getAutomationRun(db, input.ownerSub, runId) };

  const duplicate = await db.prepare("SELECT * FROM cloud_automation_runs WHERE automation_id=? AND idempotency_key=? AND owner_sub=?").bind(automation.id, key, input.ownerSub).first<RunRow>();
  if (duplicate) return { admitted:false as const, reason:"duplicate", run:runFromRow(duplicate) };
  const counts = await db.prepare(`SELECT
    SUM(CASE WHEN status IN ('queued','running','review') THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN created_at >= ? AND status IN ('queued','running','review','completed','failed','cancelled') THEN 1 ELSE 0 END) AS recent
    FROM cloud_automation_runs WHERE automation_id=?`).bind(windowStart, automation.id).first<{active:number|null;recent:number|null}>();
  const decision = decideAutomationAdmission({ recentRuns:counts?.recent ?? 0, activeRuns:counts?.active ?? 0, rateLimitCount:automation.rateLimitCount, concurrencyLimit:automation.concurrencyLimit, concurrencyPolicy:automation.concurrencyPolicy });
  if (decision.admitted) return { admitted:false as const, reason:"admission-raced", run:null };
  const rejectedRunId = id("arun");
  await db.prepare("INSERT OR IGNORE INTO cloud_automation_runs (id, automation_id, project_id, owner_sub, trigger_id, trigger_type, idempotency_key, status, reason, source_provenance_json, definition_revision, environment_version_id, target_repository_id, security_policy_revision_id, rule_revision_ids_json, auto_promote, created_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(rejectedRunId, automation.id, automation.projectId, input.ownerSub, trigger?.id ?? null, input.triggerType, key, decision.status, decision.reason, JSON.stringify(provenance), automation.revision, automation.environmentVersionId, automation.targetRepositoryId, automation.securityPolicyRevisionId, JSON.stringify(automation.ruleRevisionIds), timestamp, timestamp, timestamp).run();
  const run = await db.prepare("SELECT * FROM cloud_automation_runs WHERE automation_id=? AND idempotency_key=? AND owner_sub=?").bind(automation.id, key, input.ownerSub).first<RunRow>();
  return { admitted:false as const, reason:decision.reason, run:run ? runFromRow(run) : null };
}

export async function getAutomationRun(db: D1Database, ownerSub: string, runId: string) {
  const row = await db.prepare("SELECT * FROM cloud_automation_runs WHERE id=? AND owner_sub=?").bind(runId, ownerSub).first<RunRow>();
  return row ? runFromRow(row) : null;
}

export async function claimAutomationRunForLaunch(db: D1Database, input: {ownerSub:string;runId:string}) {
  const claimToken = id("automation_claim"); const timestamp = now();
  const result = await db.prepare(`UPDATE cloud_automation_runs SET launch_claim_token=?, launch_claimed_at=?, updated_at=?
    WHERE id=? AND owner_sub=? AND status='queued' AND task_id IS NULL AND launch_claim_token IS NULL
      AND (SELECT COUNT(*) FROM cloud_automation_runs active WHERE active.automation_id=cloud_automation_runs.automation_id AND active.owner_sub=cloud_automation_runs.owner_sub AND active.status IN ('running','review'))
        < (SELECT concurrency_limit FROM cloud_automations definition WHERE definition.id=cloud_automation_runs.automation_id AND definition.owner_sub=cloud_automation_runs.owner_sub AND definition.status='enabled')`)
    .bind(claimToken, timestamp, timestamp, input.runId, input.ownerSub).run();
  return result.meta.changes ? claimToken : null;
}

export async function releaseAutomationLaunchClaim(db: D1Database, input: {ownerSub:string;runId:string;claimToken:string}) {
  await db.prepare("UPDATE cloud_automation_runs SET launch_claim_token=NULL, launch_claimed_at=NULL, updated_at=? WHERE id=? AND owner_sub=? AND status='queued' AND task_id IS NULL AND launch_claim_token=?")
    .bind(now(), input.runId, input.ownerSub, input.claimToken).run();
}

export async function listAutomationRuns(db: D1Database, input: { ownerSub:string; automationId:string; limit?:number }) {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = await db.prepare("SELECT r.* FROM cloud_automation_runs r JOIN cloud_automations a ON a.id=r.automation_id WHERE r.automation_id=? AND r.owner_sub=? AND a.owner_sub=? ORDER BY r.created_at DESC LIMIT ?").bind(input.automationId, input.ownerSub, input.ownerSub, limit).all<RunRow>();
  return rows.results.map(runFromRow);
}

export async function attachAutomationTask(db: D1Database, input: { ownerSub:string; runId:string; taskId:string }) {
  const timestamp = now();
  const result = await db.prepare(`UPDATE cloud_automation_runs SET task_id=?, status='running', started_at=?, updated_at=?
    WHERE id=? AND owner_sub=? AND status='queued' AND auto_promote=0
    AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=? AND t.owner_sub=? AND t.project_id=cloud_automation_runs.project_id AND t.permission_mode='isolated-write')`)
    .bind(input.taskId, timestamp, timestamp, input.runId, input.ownerSub, input.taskId, input.ownerSub).run();
  if (!result.meta.changes) fail("Queued automation run or isolated task not found");
  return getAutomationRun(db, input.ownerSub, input.runId);
}

export type AutomationTaskLaunch = {
  taskId: string;
  workflowId: string;
  projectId: string;
  title: string;
  prompt: string;
  model: string;
  permissionMode: "isolated-write";
  environmentVersionId: string;
  targetRepositoryId: string;
  securityPolicyRevisionId: string;
  ruleRevisionIds: string[];
  autoPromote: false;
};

export async function createAutomationTaskForRun(db: D1Database, input: { ownerSub:string; runId:string; workflowId:string; claimToken:string }) : Promise<AutomationTaskLaunch> {
  const run = await getAutomationRun(db, input.ownerSub, input.runId);
  if (!run || run.status !== "queued" || run.taskId) fail("Queued automation run not found");
  const claim = await db.prepare("SELECT launch_claim_token FROM cloud_automation_runs WHERE id=? AND owner_sub=?").bind(input.runId, input.ownerSub).first<{launch_claim_token:string|null}>();
  if (!claim?.launch_claim_token || claim.launch_claim_token !== input.claimToken) fail("Automation launch claim is missing or stale");
  const automation = await getAutomation(db, input.ownerSub, run.automationId);
  if (!automation || automation.revision < run.definitionRevision) fail("Automation definition not found");
  const workflowId = text(input.workflowId, "workflowId", 200);
  const taskId = id("task"); const timestamp = now();
  const title = `[Automation] ${automation.name}`;
  let effectivePrompt = automation.prompt;
  if (run.ruleRevisionIds.length) {
    const placeholders = run.ruleRevisionIds.map(() => "?").join(",");
    const revisions = await db.prepare(`SELECT rr.id, rr.content, r.name FROM customization_rule_revisions rr JOIN customization_rules r ON r.id=rr.rule_id WHERE rr.id IN (${placeholders}) AND r.owner_sub=?`).bind(...run.ruleRevisionIds, input.ownerSub).all<{id:string;content:string;name:string}>();
    const byId = new Map(revisions.results.map((revision) => [revision.id, revision]));
    if (byId.size !== run.ruleRevisionIds.length) fail("One or more frozen automation rule revisions are unavailable");
    effectivePrompt += `\n\nApply these exact automation rule revisions:\n\n${run.ruleRevisionIds.map((revisionId) => { const revision = byId.get(revisionId)!; return `## ${revision.name} (${revision.id})\n${revision.content}`; }).join("\n\n")}`;
  }
  await db.batch([
    db.prepare(`INSERT INTO tasks (id, owner_sub, project_id, workflow_id, title, prompt, status, model, permission_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 'isolated-write', ?, ?)`)
      .bind(taskId, input.ownerSub, run.projectId, workflowId, title, effectivePrompt, automation.model, timestamp, timestamp),
    db.prepare(`INSERT INTO task_environments (task_id, environment_version_id, snapshot_id, target_repository_id, manifest_hash, resolved_at)
      SELECT ?, ev.id, (SELECT es.id FROM environment_snapshots es WHERE es.environment_version_id=ev.id AND es.invalidated_at IS NULL ORDER BY es.created_at DESC LIMIT 1), ?, ev.manifest_hash, ?
      FROM environment_versions ev JOIN environment_repositories er ON er.id=? AND er.environment_version_id=ev.id AND er.writable=1
      WHERE ev.id=? AND ev.project_id=? AND ev.owner_sub=?`)
      .bind(taskId, run.targetRepositoryId, timestamp, run.targetRepositoryId, run.environmentVersionId, run.projectId, input.ownerSub),
    db.prepare(`INSERT INTO task_security_policy_pins (task_id, revision_id, policy_digest, pinned_at)
      SELECT ?, sp.id, sp.policy_digest, ? FROM security_policy_revisions sp
      WHERE sp.id=? AND sp.project_id=?`)
      .bind(taskId, timestamp, run.securityPolicyRevisionId, run.projectId),
    db.prepare(`UPDATE cloud_automation_runs SET task_id=?, status='running', started_at=?, launch_claim_token=NULL, launch_claimed_at=NULL, updated_at=?
      WHERE id=? AND owner_sub=? AND status='queued' AND task_id IS NULL AND auto_promote=0 AND launch_claim_token=?`)
      .bind(taskId, timestamp, timestamp, run.id, input.ownerSub, input.claimToken),
  ]);
  const attached = await getAutomationRun(db, input.ownerSub, run.id);
  if (!attached || attached.taskId !== taskId || attached.status !== "running") fail("Automation task could not be attached");
  return { taskId, workflowId, projectId:run.projectId, title, prompt:effectivePrompt, model:automation.model, permissionMode:"isolated-write", environmentVersionId:run.environmentVersionId, targetRepositoryId:run.targetRepositoryId, securityPolicyRevisionId:run.securityPolicyRevisionId, ruleRevisionIds:run.ruleRevisionIds, autoPromote:false };
}

const terminalStatuses: AutomationRunStatus[] = ["completed", "failed", "cancelled"];
export async function updateAutomationRun(db: D1Database, input: { ownerSub:string; runId:string; status:"running"|"review"|"completed"|"failed"|"cancelled"; reason?:string|null; error?:string|null }) {
  const timestamp = now();
  const result = await db.prepare("UPDATE cloud_automation_runs SET status=?, reason=?, error=?, completed_at=?, updated_at=? WHERE id=? AND owner_sub=? AND status IN ('queued','running','review') AND auto_promote=0")
    .bind(input.status, input.reason?.trim().slice(0, 2_000) || null, input.error?.trim().slice(0, 8_000) || null, terminalStatuses.includes(input.status) ? timestamp : null, timestamp, input.runId, input.ownerSub).run();
  if (!result.meta.changes) fail("Active automation run not found or transition is no longer possible");
  return getAutomationRun(db, input.ownerSub, input.runId);
}

export async function recordAutomationOutput(db: D1Database, input: { ownerSub:string; runId:string; kind:"evidence"|"artifact"|"preview"|"pull_request"|"log"; label:string; storageRef:string; contentType?:string|null; sizeBytes?:number|null; metadata?:unknown }) {
  if (!['evidence','artifact','preview','pull_request','log'].includes(input.kind)) fail("Invalid output kind");
  const label = text(input.label, "label", 160); const storageRef = text(input.storageRef, "storageRef", 1_000);
  const metadata = safeJsonRecord(input.metadata ?? {}, "output metadata");
  if (input.sizeBytes != null && (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0)) fail("sizeBytes must be a non-negative integer");
  const timestamp = now(); const outputId = id("aout");
  const result = await db.prepare("INSERT INTO cloud_automation_outputs (id, run_id, kind, label, storage_ref, content_type, size_bytes, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cloud_automation_runs WHERE id=? AND owner_sub=?)")
    .bind(outputId, input.runId, input.kind, label, storageRef, input.contentType?.slice(0, 200) || null, input.sizeBytes ?? null, JSON.stringify(metadata), timestamp, input.runId, input.ownerSub).run();
  if (!result.meta.changes) fail("Automation run not found");
  return { id:outputId, runId:input.runId, kind:input.kind, label, storageRef, contentType:input.contentType ?? null, sizeBytes:input.sizeBytes ?? null, metadata, createdAt:timestamp };
}

export async function createAutomationDestination(db: D1Database, input: { ownerSub:string; automationId:string; kind:"in_app"|"webhook"|"email"|"slack"; label:string; destinationRef:string; eventTypes:string[]; enabled?:boolean }) {
  const automation = await getAutomation(db, input.ownerSub, input.automationId);
  if (!automation) fail("Automation not found");
  if (!["in_app", "webhook", "email", "slack"].includes(input.kind)) fail("Invalid destination kind");
  const label = text(input.label, "label", 120);
  const destinationRef = text(input.destinationRef, "destinationRef", 500);
  const eventTypes = exactStrings(input.eventTypes, "eventTypes", 20);
  if (!eventTypes.length) fail("eventTypes cannot be empty");
  const destinationId = id("adst"); const timestamp = now();
  await db.prepare("INSERT INTO cloud_automation_destinations (id, automation_id, kind, label, destination_ref, event_types_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(destinationId, automation.id, input.kind, label, destinationRef, JSON.stringify(eventTypes), input.enabled === false ? 0 : 1, timestamp, timestamp).run();
  return { id:destinationId, automationId:automation.id, kind:input.kind, label, destinationRef, eventTypes, enabled:input.enabled !== false, createdAt:timestamp, updatedAt:timestamp };
}

export async function listAutomationDestinations(db: D1Database, ownerSub: string, automationId: string) {
  const rows = await db.prepare(`SELECT d.* FROM cloud_automation_destinations d JOIN cloud_automations a ON a.id=d.automation_id
    WHERE d.automation_id=? AND a.owner_sub=? ORDER BY d.created_at`).bind(automationId, ownerSub).all<{id:string;automation_id:string;kind:"in_app"|"webhook"|"email"|"slack";label:string;destination_ref:string;event_types_json:string;enabled:number;created_at:string;updated_at:string}>();
  return rows.results.map((row) => ({ id:row.id, automationId:row.automation_id, kind:row.kind, label:row.label, destinationRef:row.destination_ref, eventTypes:JSON.parse(row.event_types_json) as string[], enabled:Boolean(row.enabled), createdAt:row.created_at, updatedAt:row.updated_at }));
}

export async function recordCronTriggerFired(db: D1Database, input: { ownerSub:string; triggerId:string; firedAt:string }) {
  const trigger = await getAutomationTrigger(db, input.ownerSub, input.triggerId);
  if (!trigger || trigger.type !== "cron") fail("Cron trigger not found");
  const firedAt = iso(input.firedAt, "firedAt");
  if (trigger.nextDueAt && firedAt < trigger.nextDueAt) fail("Cron trigger is not due");
  const nextDueAt = nextScheduledTime((trigger.config as CronTriggerConfig).schedule, firedAt);
  await db.prepare("UPDATE cloud_automation_triggers SET last_fired_at=?, next_due_at=?, updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM cloud_automations WHERE id=automation_id AND owner_sub=?)").bind(firedAt, nextDueAt, firedAt, trigger.id, input.ownerSub).run();
  return { ...trigger, lastFiredAt:firedAt, nextDueAt, updatedAt:firedAt };
}

export async function listDueCronTriggers(db: D1Database, input: { ownerSub:string; at?:string; limit?:number }) {
  const at = input.at ? iso(input.at, "at") : now(); const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = await db.prepare(`SELECT t.* FROM cloud_automation_triggers t JOIN cloud_automations a ON a.id=t.automation_id
    WHERE a.owner_sub=? AND a.status='enabled' AND t.type='cron' AND t.enabled=1 AND t.next_due_at IS NOT NULL AND t.next_due_at<=?
    ORDER BY t.next_due_at LIMIT ?`).bind(input.ownerSub, at, limit).all<TriggerRow>();
  return rows.results.map(triggerFromRow);
}
