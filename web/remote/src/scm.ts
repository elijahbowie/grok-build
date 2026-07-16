import { id, now } from "./db";

export type ScmProvider = "artifacts" | "github";
export type ScmTargetRole = "canonical" | "mirror";

export type NormalizedScmEvent = {
  provider: ScmProvider;
  eventType: string;
  deliveryId: string;
  repository: string;
  ref: string | null;
  beforeSha: string | null;
  afterSha: string | null;
  actor: Record<string, unknown>;
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type ScmTarget = {
  id: string;
  projectId: string;
  ownerSub: string;
  provider: ScmProvider;
  role: ScmTargetRole;
  repository: string;
  defaultBranch: string;
  connectionRef: string | null;
  enabled: boolean;
};

type ScmTargetRow = {
  id:string; project_id:string; owner_sub:string; provider:ScmProvider; role:ScmTargetRole;
  repository:string; default_branch:string; connection_ref:string|null; enabled:number;
};

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const SAFE_EVENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;

export class ScmValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ScmValidationError"; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScmValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = 500, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ScmValidationError(`${label} is invalid`);
  return value.trim();
}

function sha(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const result = string(value, label, 64) as string;
  if (!SHA.test(result)) throw new ScmValidationError(`${label} must be a full Git SHA`);
  return result.toLowerCase();
}

function iso(value: unknown, fallback = now()) {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function targetFromRow(row: ScmTargetRow): ScmTarget {
  return {
    id:row.id, projectId:row.project_id, ownerSub:row.owner_sub, provider:row.provider, role:row.role,
    repository:row.repository, defaultBranch:row.default_branch, connectionRef:row.connection_ref, enabled:Boolean(row.enabled),
  };
}

export function normalizeArtifactsEvent(value: unknown): NormalizedScmEvent {
  const root = object(value, "Artifacts event");
  const source = object(root.source, "Artifacts event source");
  const payload = object(root.payload ?? {}, "Artifacts event payload");
  const metadata = object(root.metadata, "Artifacts event metadata");
  const rawType = string(root.type, "Artifacts event type", 160) as string;
  if (!rawType.startsWith("cf.artifacts.") || !SAFE_EVENT.test(rawType)) throw new ScmValidationError("Unsupported Artifacts event type");
  const namespace = string(source.namespace, "Artifacts namespace", 128) as string;
  const repoName = string(source.repoName, "Artifacts repository", 128) as string;
  const delivery = string(metadata.eventSubscriptionId, "Artifacts subscription id", 160) as string;
  const occurredAt = iso(metadata.eventTimestamp);
  const after = sha(payload.after, "Artifacts after SHA");
  const before = sha(payload.before, "Artifacts before SHA");
  const eventType = rawType.replace(/^cf\.artifacts\./, "");
  const eventIdentity = [delivery, occurredAt, rawType, namespace, repoName, after ?? before ?? "none"].join(":");
  return {
    provider:"artifacts", eventType, deliveryId:eventIdentity.slice(0, 500), repository:repoName,
    ref:string(payload.ref, "Artifacts ref", 500, true), beforeSha:before, afterSha:after,
    actor:{ namespace, commits:Array.isArray(payload.commits) ? payload.commits.slice(0, 100).map((commit) => object(commit, "commit").author ?? null) : [] },
    payload, occurredAt,
  };
}

export function normalizeGithubEvent(input: {event:string;delivery:string;payload:unknown;receivedAt?:string}): NormalizedScmEvent {
  const payload = object(input.payload, "GitHub payload");
  const repository = object(payload.repository, "GitHub repository");
  const fullName = string(repository.full_name, "GitHub repository name", 300) as string;
  const event = string(input.event, "GitHub event", 160) as string;
  const delivery = string(input.delivery, "GitHub delivery", 160) as string;
  if (!SAFE_EVENT.test(event) || !SAFE_EVENT.test(delivery)) throw new ScmValidationError("Invalid GitHub event identity");
  const pullRequest = payload.pull_request && typeof payload.pull_request === "object" ? payload.pull_request as Record<string, unknown> : null;
  const workflow = payload.workflow_run && typeof payload.workflow_run === "object" ? payload.workflow_run as Record<string, unknown> : null;
  const pullHead = pullRequest && typeof pullRequest.head === "object" ? (pullRequest.head as Record<string, unknown>).sha : null;
  const ref = typeof payload.ref === "string" ? payload.ref : pullRequest && typeof pullRequest.base === "object" ? `refs/heads/${String((pullRequest.base as Record<string, unknown>).ref ?? "")}` : null;
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender as Record<string, unknown> : {};
  return {
    provider:"github", eventType:event, deliveryId:delivery, repository:fullName, ref,
    beforeSha:sha(payload.before, "GitHub before SHA"),
    afterSha:sha(payload.after ?? pullHead ?? workflow?.head_sha, "GitHub after SHA"),
    actor:{ id:sender.id ?? null, login:sender.login ?? null, type:sender.type ?? null }, payload, occurredAt:iso(input.receivedAt),
  };
}

export async function ensureCanonicalArtifactsTarget(db: D1Database, input: {projectId:string;ownerSub:string;repository:string;defaultBranch:string}) {
  const timestamp = now();
  await db.prepare(`INSERT INTO project_scm_targets (id, project_id, owner_sub, provider, role, repository, default_branch, created_at, updated_at)
    VALUES (?, ?, ?, 'artifacts', 'canonical', ?, ?, ?, ?)
    ON CONFLICT(project_id, provider, repository) DO UPDATE SET default_branch=excluded.default_branch, enabled=1, updated_at=excluded.updated_at`)
    .bind(`scm_art_${input.projectId}`, input.projectId, input.ownerSub, input.repository, input.defaultBranch, timestamp, timestamp).run();
}

export async function upsertGithubMirrorTarget(db: D1Database, input: {projectId:string;ownerSub:string;repository:string;defaultBranch:string;connectionRef:string}) {
  const timestamp = now();
  await db.prepare(`INSERT INTO project_scm_targets (id, project_id, owner_sub, provider, role, repository, default_branch, connection_ref, created_at, updated_at)
    VALUES (?, ?, ?, 'github', 'mirror', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET repository=excluded.repository, default_branch=excluded.default_branch, connection_ref=excluded.connection_ref, enabled=1, updated_at=excluded.updated_at`)
    .bind(`scm_gh_${input.projectId}`, input.projectId, input.ownerSub, input.repository, input.defaultBranch, input.connectionRef, timestamp, timestamp).run();
}

export async function listScmTargets(db: D1Database, ownerSub: string, projectId: string) {
  const rows = await db.prepare("SELECT * FROM project_scm_targets WHERE project_id=? AND owner_sub=? ORDER BY role, provider, repository").bind(projectId, ownerSub).all<ScmTargetRow>();
  return rows.results.map(targetFromRow);
}

export async function findProjectForScmRepository(db: D1Database, provider: ScmProvider, repository: string) {
  return db.prepare("SELECT project_id, owner_sub FROM project_scm_targets WHERE provider=? AND repository=? AND enabled=1 LIMIT 1")
    .bind(provider, repository).first<{project_id:string;owner_sub:string}>();
}

export async function recordScmEvent(db: D1Database, event: NormalizedScmEvent, project?: {projectId:string;ownerSub:string}|null) {
  const eventId = id("scme");
  const result = await db.prepare(`INSERT OR IGNORE INTO scm_events
    (id, owner_sub, project_id, provider, event_type, delivery_id, repository, ref, before_sha, after_sha, actor_json, payload_json, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, project?.ownerSub ?? "unmatched", project?.projectId ?? null, event.provider, event.eventType, event.deliveryId, event.repository, event.ref, event.beforeSha, event.afterSha, JSON.stringify(event.actor), JSON.stringify(event.payload), event.occurredAt).run();
  if (!result.meta.changes) return db.prepare("SELECT * FROM scm_events WHERE provider=? AND delivery_id=? AND event_type=?").bind(event.provider, event.deliveryId, event.eventType).first();
  return db.prepare("SELECT * FROM scm_events WHERE id=?").bind(eventId).first();
}

export async function markScmEventProcessed(db: D1Database, eventId: string, error?: string | null) {
  await db.prepare("UPDATE scm_events SET processed_at=?, error=? WHERE id=? AND processed_at IS NULL")
    .bind(now(), error?.slice(0, 8000) || null, eventId).run();
}

export async function listScmEvents(db: D1Database, ownerSub: string, input: {projectId?:string;provider?:ScmProvider;limit?:number} = {}) {
  const clauses = ["owner_sub=?"]; const values: unknown[] = [ownerSub];
  if (input.projectId) { clauses.push("project_id=?"); values.push(input.projectId); }
  if (input.provider) { clauses.push("provider=?"); values.push(input.provider); }
  values.push(Math.max(1, Math.min(input.limit ?? 100, 500)));
  return (await db.prepare(`SELECT * FROM scm_events WHERE ${clauses.join(" AND ")} ORDER BY received_at DESC LIMIT ?`).bind(...values).all()).results;
}

export function scmEventMatches(input: {event:NormalizedScmEvent;provider:ScmProvider;eventTypes:string[];repositories?:string[];refs?:string[]}) {
  if (input.event.provider !== input.provider || !input.eventTypes.includes(input.event.eventType)) return false;
  if (input.repositories?.length && !input.repositories.includes(input.event.repository)) return false;
  if (input.refs?.length && (!input.event.ref || !input.refs.includes(input.event.ref))) return false;
  return true;
}
