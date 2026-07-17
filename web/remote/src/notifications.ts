const encoder = new TextEncoder();

export const attentionKinds = ["task-completed", "task-failed", "approval-needed"] as const;
export type AttentionKind = typeof attentionKinds[number];
export type AttentionReadState = "unread" | "read" | "dismissed";

export type NotificationPreferences = {
  taskCompleted: boolean;
  taskFailed: boolean;
  approvalNeeded: boolean;
};

export type PrivateNotificationPayload = {
  version: 1;
  eventId: string;
  taskId: string;
  kind: AttentionKind;
  createdAt: string;
};

export type PushSubscriptionCapability = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime: string | null;
};

export type LiveTaskActivity = {
  taskId: string;
  state: "queued" | "active" | "attention" | "complete" | "failed" | "cancelled";
  phase: string;
  updatedAt: string;
  attention: AttentionKind | null;
  terminal: boolean;
};

const defaultPreferences: NotificationPreferences = {
  taskCompleted: true,
  taskFailed: true,
  approvalNeeded: true,
};

function timestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function opaqueOwner(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0")) throw new Error("Owner is invalid");
  return value;
}

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value.trim();
}

function attentionKind(value: unknown): AttentionKind {
  if (!attentionKinds.includes(value as AttentionKind)) throw new Error("Attention kind is invalid");
  return value as AttentionKind;
}

function booleanSetting(value: unknown, fallback: boolean, label: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function validateNotificationPreferences(input: unknown): NotificationPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Notification preferences must be an object");
  const value = input as Record<string, unknown>;
  return {
    taskCompleted: booleanSetting(value.taskCompleted, defaultPreferences.taskCompleted, "taskCompleted"),
    taskFailed: booleanSetting(value.taskFailed, defaultPreferences.taskFailed, "taskFailed"),
    approvalNeeded: booleanSetting(value.approvalNeeded, defaultPreferences.approvalNeeded, "approvalNeeded"),
  };
}

export function createPrivateNotificationPayload(input: { eventId: unknown; taskId: unknown; kind: unknown; createdAt: unknown }): PrivateNotificationPayload {
  return {
    version: 1,
    eventId: identifier(input.eventId, "Event ID"),
    taskId: identifier(input.taskId, "Task ID"),
    kind: attentionKind(input.kind),
    createdAt: timestamp(input.createdAt, "Created at"),
  };
}

export function validatePrivateNotificationPayload(input: unknown): PrivateNotificationPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Notification payload must be an object");
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,eventId,kind,taskId,version") throw new Error("Notification payload contains unsupported or sensitive fields");
  if (value.version !== 1) throw new Error("Notification payload version is invalid");
  return createPrivateNotificationPayload(value as Parameters<typeof createPrivateNotificationPayload>[0]);
}

export function notificationText(kind: AttentionKind) {
  if (kind === "approval-needed") return { title: "Grok Build needs your approval", body: "Open Grok Build to review the requested action." };
  if (kind === "task-failed") return { title: "A Grok Build task needs attention", body: "Open Grok Build to inspect the failure and recovery options." };
  return { title: "A Grok Build task completed", body: "Open Grok Build to review the result and evidence." };
}

function b64url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function subscriptionKey(encodedKey: string, usage: Array<"encrypt" | "decrypt">) {
  const bytes = fromB64url(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("Push subscription encryption key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage);
}

function validatePushSubscription(input: unknown): PushSubscriptionCapability {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Push subscription must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.endpoint !== "string" || value.endpoint.length > 2_048) throw new Error("Push endpoint is invalid");
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(endpoint.hostname) || endpoint.hostname.includes(":")) throw new Error("Push endpoint must use a public HTTPS origin");
  if (!value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) throw new Error("Push subscription keys are required");
  const keys = value.keys as Record<string, unknown>;
  for (const field of ["p256dh", "auth"] as const) if (typeof keys[field] !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(keys[field])) throw new Error(`Push ${field} key is invalid`);
  let expirationTime: string | null = null;
  if (value.expirationTime !== null && value.expirationTime !== undefined) {
    if (typeof value.expirationTime !== "number" || !Number.isFinite(value.expirationTime) || value.expirationTime <= Date.now()) throw new Error("Push expiration time is invalid");
    expirationTime = new Date(value.expirationTime).toISOString();
  }
  return { endpoint: endpoint.toString(), keys: { p256dh: keys.p256dh as string, auth: keys.auth as string }, expirationTime };
}

export async function pushEndpointHash(endpoint: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(endpoint))));
}

export async function sealPushSubscription(input: unknown, encodedKey: string, context: { ownerSub: string; subscriptionId: string }) {
  const subscription = validatePushSubscription(input);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(JSON.stringify({ ownerSub: opaqueOwner(context.ownerSub), subscriptionId: identifier(context.subscriptionId, "Subscription ID"), version: 1 }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await subscriptionKey(encodedKey, ["encrypt"]), encoder.encode(JSON.stringify(subscription)));
  return {
    endpointHash: await pushEndpointHash(subscription.endpoint),
    expirationTime: subscription.expirationTime,
    envelope: JSON.stringify({ version: 1, algorithm: "A256GCM", iv: b64url(iv), aad: b64url(aad), ciphertext: b64url(new Uint8Array(ciphertext)) }),
  };
}

export async function withUnsealedPushSubscription<T>(envelopeValue: string, encodedKey: string, context: { ownerSub: string; subscriptionId: string }, use: (subscription: PushSubscriptionCapability) => T | Promise<T>) {
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(envelopeValue) as Record<string, unknown>; } catch { throw new Error("Push subscription envelope is invalid"); }
  const aad = encoder.encode(JSON.stringify({ ownerSub: opaqueOwner(context.ownerSub), subscriptionId: identifier(context.subscriptionId, "Subscription ID"), version: 1 }));
  if (envelope.version !== 1 || envelope.algorithm !== "A256GCM" || envelope.aad !== b64url(aad) || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") throw new Error("Push subscription envelope context mismatch");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(envelope.iv), additionalData: aad }, await subscriptionKey(encodedKey, ["decrypt"]), fromB64url(envelope.ciphertext)));
  try {
    return await use(validatePushSubscription(JSON.parse(new TextDecoder().decode(plaintext))));
  } finally {
    plaintext.fill(0);
  }
}

export async function savePushSubscription(db: D1Database, input: { ownerSub: string; subscription: unknown; encryptionKey: string; platform?: unknown; userAgent?: unknown }) {
  const ownerSub = opaqueOwner(input.ownerSub);
  const platform = input.platform ?? "web";
  if (!(platform === "web" || platform === "ios" || platform === "android" || platform === "desktop")) throw new Error("Push platform is invalid");
  const userAgent = input.userAgent ?? "";
  if (typeof userAgent !== "string" || userAgent.length > 500) throw new Error("Push user agent is invalid");
  const subscriptionId = `push_${crypto.randomUUID().replaceAll("-", "")}`;
  const sealed = await sealPushSubscription(input.subscription, input.encryptionKey, { ownerSub, subscriptionId });
  const existing = await db.prepare("SELECT id FROM push_subscriptions WHERE owner_sub = ? AND endpoint_hash = ?").bind(ownerSub, sealed.endpointHash).first<{ id: string }>();
  const id = existing?.id ?? subscriptionId;
  const encrypted = existing ? await sealPushSubscription(input.subscription, input.encryptionKey, { ownerSub, subscriptionId: id }) : sealed;
  const time = new Date().toISOString();
  await db.prepare("INSERT INTO push_subscriptions (id, owner_sub, endpoint_hash, subscription_ciphertext, platform, user_agent, expiration_time, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(owner_sub, endpoint_hash) DO UPDATE SET subscription_ciphertext=excluded.subscription_ciphertext, platform=excluded.platform, user_agent=excluded.user_agent, expiration_time=excluded.expiration_time, status='active', updated_at=excluded.updated_at")
    .bind(id, ownerSub, encrypted.endpointHash, encrypted.envelope, platform, userAgent, encrypted.expirationTime, time, time).run();
  return { id, endpointHash: encrypted.endpointHash, platform, expirationTime: encrypted.expirationTime, status: "active", createdAt: time, updatedAt: time };
}

export async function listPushSubscriptionMetadata(db: D1Database, ownerSub: string) {
  const result = await db.prepare("SELECT id, endpoint_hash, platform, user_agent, expiration_time, status, created_at, updated_at, last_used_at FROM push_subscriptions WHERE owner_sub = ? ORDER BY updated_at DESC").bind(opaqueOwner(ownerSub)).all<Record<string, unknown>>();
  return result.results.map((row) => ({ id: row.id, endpointHash: row.endpoint_hash, platform: row.platform, userAgent: row.user_agent, expirationTime: row.expiration_time, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at }));
}

export async function revokePushSubscription(db: D1Database, ownerSub: string, subscriptionId: string) {
  const result = await db.prepare("UPDATE push_subscriptions SET status = 'revoked', subscription_ciphertext = '{}', updated_at = ? WHERE id = ? AND owner_sub = ?").bind(new Date().toISOString(), identifier(subscriptionId, "Subscription ID"), opaqueOwner(ownerSub)).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function upsertNotificationPreferences(db: D1Database, input: { ownerSub: string; projectId?: string | null; preferences: unknown }) {
  const ownerSub = opaqueOwner(input.ownerSub);
  const projectId = input.projectId ? identifier(input.projectId, "Project ID") : null;
  if (projectId) {
    const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND owner_sub = ?").bind(projectId, ownerSub).first<{ id: string }>();
    if (!project) throw new Error("Project not found");
  }
  const preferences = validateNotificationPreferences(input.preferences);
  const time = new Date().toISOString();
  await db.prepare("INSERT INTO notification_preferences (owner_sub, project_id, project_key, task_completed, task_failed, approval_needed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_sub, project_key) DO UPDATE SET task_completed=excluded.task_completed, task_failed=excluded.task_failed, approval_needed=excluded.approval_needed, updated_at=excluded.updated_at")
    .bind(ownerSub, projectId, projectId ?? "*", Number(preferences.taskCompleted), Number(preferences.taskFailed), Number(preferences.approvalNeeded), time).run();
  return { ownerSub, projectId, ...preferences, updatedAt: time };
}

export async function getNotificationPreferences(db: D1Database, ownerSub: string, projectId?: string | null) {
  const owner = opaqueOwner(ownerSub);
  const row = projectId
    ? await db.prepare("SELECT * FROM notification_preferences WHERE owner_sub = ? AND project_key IN (?, '*') ORDER BY CASE WHEN project_key = ? THEN 0 ELSE 1 END LIMIT 1").bind(owner, identifier(projectId, "Project ID"), projectId).first<Record<string, unknown>>()
    : await db.prepare("SELECT * FROM notification_preferences WHERE owner_sub = ? AND project_key = '*'").bind(owner).first<Record<string, unknown>>();
  return row ? { taskCompleted: Boolean(row.task_completed), taskFailed: Boolean(row.task_failed), approvalNeeded: Boolean(row.approval_needed) } : { ...defaultPreferences };
}

function preferenceForKind(preferences: NotificationPreferences, kind: AttentionKind) {
  if (kind === "task-completed") return preferences.taskCompleted;
  if (kind === "task-failed") return preferences.taskFailed;
  return preferences.approvalNeeded;
}

export async function createTaskAttentionEvent(db: D1Database, input: { ownerSub: string; taskId: string; kind: unknown; dedupKey: unknown }) {
  const ownerSub = opaqueOwner(input.ownerSub);
  const taskId = identifier(input.taskId, "Task ID");
  const kind = attentionKind(input.kind);
  const dedupKey = boundedText(input.dedupKey, "Deduplication key", 240);
  const task = await db.prepare("SELECT id, project_id FROM tasks WHERE id = ? AND owner_sub = ?").bind(taskId, ownerSub).first<{ id: string; project_id: string }>();
  if (!task) throw new Error("Task not found");
  const preferences = await getNotificationPreferences(db, ownerSub, task.project_id);
  if (!preferenceForKind(preferences, kind)) return { created: false, reason: "disabled-by-preference" as const };
  const eventId = `attention_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = new Date().toISOString();
  const payload = createPrivateNotificationPayload({ eventId, taskId, kind, createdAt });
  const result = await db.prepare("INSERT OR IGNORE INTO task_attention_events (id, owner_sub, project_id, task_id, kind, dedup_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(eventId, ownerSub, task.project_id, taskId, kind, dedupKey, JSON.stringify(payload), createdAt).run();
  if (!(result.meta.changes ?? 0)) {
    const existing = await db.prepare("SELECT id, payload_json, read_state, created_at FROM task_attention_events WHERE owner_sub = ? AND dedup_key = ?").bind(ownerSub, dedupKey).first<Record<string, unknown>>();
    return { created: false, reason: "duplicate" as const, event: existing ? { id: existing.id, payload: validatePrivateNotificationPayload(JSON.parse(String(existing.payload_json))), readState: existing.read_state, createdAt: existing.created_at } : null };
  }
  return { created: true, event: { id: eventId, payload, readState: "unread" as const, createdAt } };
}

export async function listTaskAttentionEvents(db: D1Database, ownerSub: string, input: { readState?: AttentionReadState; limit?: number } = {}) {
  const owner = opaqueOwner(ownerSub);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Attention event limit must be from 1 to 200");
  if (input.readState && !(input.readState === "unread" || input.readState === "read" || input.readState === "dismissed")) throw new Error("Attention read state is invalid");
  const result = input.readState
    ? await db.prepare("SELECT * FROM task_attention_events WHERE owner_sub = ? AND read_state = ? ORDER BY created_at DESC LIMIT ?").bind(owner, input.readState, limit).all<Record<string, unknown>>()
    : await db.prepare("SELECT * FROM task_attention_events WHERE owner_sub = ? ORDER BY created_at DESC LIMIT ?").bind(owner, limit).all<Record<string, unknown>>();
  return result.results.map((row) => ({ id: row.id, projectId: row.project_id, taskId: row.task_id, kind: row.kind, payload: validatePrivateNotificationPayload(JSON.parse(String(row.payload_json))), readState: row.read_state, createdAt: row.created_at, readAt: row.read_at, dismissedAt: row.dismissed_at }));
}

export async function setAttentionReadState(db: D1Database, ownerSub: string, eventId: string, readState: AttentionReadState) {
  if (!(readState === "unread" || readState === "read" || readState === "dismissed")) throw new Error("Attention read state is invalid");
  const time = new Date().toISOString();
  const result = await db.prepare("UPDATE task_attention_events SET read_state = ?, read_at = CASE WHEN ? = 'read' THEN ? ELSE NULL END, dismissed_at = CASE WHEN ? = 'dismissed' THEN ? ELSE NULL END WHERE id = ? AND owner_sub = ?")
    .bind(readState, readState, time, readState, time, identifier(eventId, "Event ID"), opaqueOwner(ownerSub)).run();
  return (result.meta.changes ?? 0) > 0;
}

export function buildLiveTaskActivity(task: { id: string; status: string; updatedAt?: string; updated_at?: string }, attention: AttentionKind | null = null): LiveTaskActivity {
  const updatedAt = timestamp(task.updatedAt ?? task.updated_at, "Task updated at");
  const phaseByStatus: Record<string, string> = {
    queued: "Waiting to start", preparing: "Preparing workspace", running: "Working", repairing: "Repairing verification", review: "Ready for review", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
  };
  if (!phaseByStatus[task.status]) throw new Error("Task status is invalid");
  const state = attention === "approval-needed" ? "attention" : task.status === "completed" ? "complete" : task.status === "failed" ? "failed" : task.status === "cancelled" ? "cancelled" : task.status === "queued" ? "queued" : "active";
  return { taskId: identifier(task.id, "Task ID"), state, phase: phaseByStatus[task.status], updatedAt, attention, terminal: task.status === "completed" || task.status === "failed" || task.status === "cancelled" };
}

export function backgroundRefreshPolicy(method: string, pathname: string) {
  const normalizedMethod = method.toUpperCase();
  const allowedPath = pathname === "/api/tasks" || pathname === "/api/attention-events" || /^\/api\/tasks\/[a-zA-Z0-9._:-]+$/.test(pathname);
  return { allowed: normalizedMethod === "GET" && allowedPath, reason: normalizedMethod !== "GET" ? "background-sync-is-read-only" : allowedPath ? "read-only-refresh" : "path-not-allowed" };
}
