import { id, now } from "./db";

export const approvalActions = ["publish", "promotion", "external-write", "connector-write", "automation-enable"] as const;
export const approvalStatuses = ["pending", "approved", "denied", "expired", "consumed", "cancelled"] as const;
export const approvalTargetKinds = ["repository-ref", "external-resource", "connector", "automation"] as const;
export const rollbackStrategies = ["automatic", "manual", "none"] as const;

export type ApprovalAction = typeof approvalActions[number];
export type ApprovalStatus = typeof approvalStatuses[number];
export type ApprovalTargetKind = typeof approvalTargetKinds[number];
export type RollbackStrategy = typeof rollbackStrategies[number];
export type ApprovalDecision = "approved" | "denied";

export type ApprovalTarget = { kind: ApprovalTargetKind; identifier: string; label: string };
export type ApprovalRollback = { strategy: RollbackStrategy; instructions: string };
export type ApprovalRequest = {
  projectId: string;
  taskId: string;
  action: ApprovalAction;
  target: ApprovalTarget;
  consequence: string;
  rollback: ApprovalRollback;
  expectedHeadSha: string;
  requestReason: string;
  expiresAt: string;
};

export type ApprovalRow = {
  id:string; owner_sub:string; project_id:string; task_id:string; action:ApprovalAction;
  target_json:string; consequence:string; rollback_json:string; expected_head_sha:string;
  status:ApprovalStatus; request_reason:string; requested_by:string; expires_at:string;
  created_at:string; updated_at:string; decided_at:string|null; consumed_at:string|null; cancelled_at:string|null;
};

export type ApprovalAuditRow = {
  id:string; approval_id:string; owner_sub:string; event_type:"requested"|ApprovalStatus;
  actor_sub:string; reason:string; expected_head_sha:string; created_at:string;
};

export type PromotionDeliveryPayload = {
  approvedBy:string; approvedAt:string; expectedHeadSha:string; reviewRunId:string; approvalDeliveryId:string;
};

export type ApprovalDeliveryRow = {
  id:string; approval_id:string; owner_sub:string; task_id:string; expected_head_sha:string; workflow_id:string;
  event_type:"promote"; payload_json:string; status:"pending"|"delivering"|"failed"|"delivered";
  attempt_count:number; lease_token:string|null; lease_expires_at:string|null; last_error:string|null;
  created_at:string; updated_at:string; delivered_at:string|null;
};

export class ApprovalValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ApprovalValidationError"; }
}

function fail(message: string): never { throw new ApprovalValidationError(message); }

function record(value: unknown, label: string, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  return result;
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) fail(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value.trim();
}

function identifier(value: unknown, label: string) {
  const result = text(value, label, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(result) || result.includes("..")) fail(`${label} must be an opaque identifier`);
  return result;
}

function enumeration<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} is invalid`);
  return value as T;
}

export function validateApprovalHeadSha(value: unknown) {
  const sha = text(value, "expectedHeadSha", 64).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) fail("expectedHeadSha must be a full Git SHA");
  return sha;
}

export function validateApprovalTarget(actionValue: unknown, targetValue: unknown): { action:ApprovalAction; target:ApprovalTarget } {
  const action = enumeration(actionValue, "action", approvalActions);
  const target = record(targetValue, "target", ["kind", "identifier", "label"]);
  const kind = enumeration(target.kind, "target.kind", approvalTargetKinds);
  const requiredKind: Record<ApprovalAction, ApprovalTargetKind> = {
    publish: "repository-ref", promotion: "repository-ref", "external-write": "external-resource",
    "connector-write": "connector", "automation-enable": "automation",
  };
  if (kind !== requiredKind[action]) fail(`${action} approvals require a ${requiredKind[action]} target`);
  return { action, target: { kind, identifier: identifier(target.identifier, "target.identifier"), label: text(target.label, "target.label", 240) } };
}

export function validateApprovalRollback(value: unknown): ApprovalRollback {
  const input = record(value, "rollback", ["strategy", "instructions"]);
  const strategy = enumeration(input.strategy, "rollback.strategy", rollbackStrategies);
  const instructions = text(input.instructions, "rollback.instructions", 4000);
  if (strategy === "none" && instructions.length < 12) fail("non-reversible actions must explain why rollback is unavailable");
  return { strategy, instructions };
}

export function validateApprovalRequest(value: unknown, at = new Date()): ApprovalRequest {
  const input = record(value, "approval request", ["projectId", "taskId", "action", "target", "consequence", "rollback", "expectedHeadSha", "requestReason", "expiresAt"]);
  const expiresAt = text(input.expiresAt, "expiresAt", 40);
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) fail("expiresAt must be an ISO timestamp");
  const minimum = at.getTime() + 60_000;
  const maximum = at.getTime() + 7 * 24 * 60 * 60 * 1000;
  if (expiry < minimum || expiry > maximum) fail("expiresAt must be between one minute and seven days from now");
  const { action, target } = validateApprovalTarget(input.action, input.target);
  return {
    projectId: identifier(input.projectId, "projectId"), taskId: identifier(input.taskId, "taskId"), action, target,
    consequence: text(input.consequence, "consequence", 4000), rollback: validateApprovalRollback(input.rollback),
    expectedHeadSha: validateApprovalHeadSha(input.expectedHeadSha), requestReason: text(input.requestReason, "requestReason", 2000),
    expiresAt: new Date(expiry).toISOString(),
  };
}

export function validateApprovalForAction(input: { approval: Pick<ApprovalRow, "action"|"task_id"|"expected_head_sha"|"status"|"expires_at">; action: unknown; taskId: unknown; expectedHeadSha: unknown }, at = new Date()) {
  const action = enumeration(input.action, "action", approvalActions);
  const taskId = identifier(input.taskId, "taskId");
  const expectedHeadSha = validateApprovalHeadSha(input.expectedHeadSha);
  const reasons: string[] = [];
  if (input.approval.action !== action) reasons.push("Approval is for a different consequential action");
  if (input.approval.task_id !== taskId) reasons.push("Approval is bound to a different task");
  if (validateApprovalHeadSha(input.approval.expected_head_sha) !== expectedHeadSha) reasons.push("Approval is stale for the requested task head");
  if (input.approval.status !== "approved") reasons.push(`Approval is ${input.approval.status}`);
  if (Date.parse(input.approval.expires_at) <= at.getTime()) reasons.push("Approval has expired");
  return { allowed: reasons.length === 0, reasons };
}

function owner(value: unknown) { return text(value, "ownerSub", 512); }
function actor(value: unknown) { return text(value, "actorSub", 512); }
function approvalId(value: unknown) { return identifier(value, "approvalId"); }
function eventId() { return id("apa"); }

function timestamp(value: unknown, label: string) {
  const result = text(value, label, 40); const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be an ISO timestamp`);
  return new Date(milliseconds).toISOString();
}

export function validatePromotionDeliveryPayload(value: unknown): PromotionDeliveryPayload {
  const input = record(value, "promotion delivery payload", ["approvedBy", "approvedAt", "expectedHeadSha", "reviewRunId", "approvalDeliveryId"]);
  return {
    approvedBy:text(input.approvedBy, "approvedBy", 512), approvedAt:timestamp(input.approvedAt, "approvedAt"),
    expectedHeadSha:validateApprovalHeadSha(input.expectedHeadSha), reviewRunId:identifier(input.reviewRunId, "reviewRunId"),
    approvalDeliveryId:identifier(input.approvalDeliveryId, "approvalDeliveryId"),
  };
}

function presentDelivery(row: ApprovalDeliveryRow) {
  return { ...row, payload:validatePromotionDeliveryPayload(JSON.parse(row.payload_json)) };
}

export async function createApproval(db: D1Database, input: { ownerSub: string; requestedBy: string; request: unknown }, at = new Date()) {
  const ownerSub = owner(input.ownerSub); const requestedBy = actor(input.requestedBy); const request = validateApprovalRequest(input.request, at);
  const task = await db.prepare("SELECT id, project_id, head_sha FROM tasks WHERE id = ? AND project_id = ? AND owner_sub = ?").bind(request.taskId, request.projectId, ownerSub).first<{id:string;project_id:string;head_sha:string|null}>();
  if (!task) throw new ApprovalValidationError("Task not found");
  if (!task.head_sha || validateApprovalHeadSha(task.head_sha) !== request.expectedHeadSha) throw new ApprovalValidationError("Task head does not match expectedHeadSha");
  const approval: ApprovalRow = {
    id:id("approval"), owner_sub:ownerSub, project_id:request.projectId, task_id:request.taskId, action:request.action,
    target_json:JSON.stringify(request.target), consequence:request.consequence, rollback_json:JSON.stringify(request.rollback),
    expected_head_sha:request.expectedHeadSha, status:"pending", request_reason:request.requestReason, requested_by:requestedBy,
    expires_at:request.expiresAt, created_at:at.toISOString(), updated_at:at.toISOString(), decided_at:null, consumed_at:null, cancelled_at:null,
  };
  await db.batch([
    db.prepare("INSERT INTO high_impact_approvals (id, owner_sub, project_id, task_id, action, target_json, consequence, rollback_json, expected_head_sha, status, request_reason, requested_by, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").bind(approval.id, approval.owner_sub, approval.project_id, approval.task_id, approval.action, approval.target_json, approval.consequence, approval.rollback_json, approval.expected_head_sha, approval.request_reason, approval.requested_by, approval.expires_at, approval.created_at, approval.updated_at),
    db.prepare("INSERT INTO high_impact_approval_audit (id, approval_id, owner_sub, event_type, actor_sub, reason, expected_head_sha, created_at) VALUES (?, ?, ?, 'requested', ?, ?, ?, ?)").bind(eventId(), approval.id, ownerSub, requestedBy, request.requestReason, approval.expected_head_sha, approval.created_at),
  ]);
  return presentApproval(approval);
}

export function presentApproval(row: ApprovalRow) {
  return { ...row, target: JSON.parse(row.target_json) as ApprovalTarget, rollback: JSON.parse(row.rollback_json) as ApprovalRollback };
}

export async function getApproval(db: D1Database, ownerSub: string, value: string) {
  const row = await db.prepare("SELECT * FROM high_impact_approvals WHERE id = ? AND owner_sub = ?").bind(approvalId(value), owner(ownerSub)).first<ApprovalRow>();
  return row ? presentApproval(row) : null;
}

export async function listApprovals(db: D1Database, ownerSub: string, input: { taskId?: string; status?: ApprovalStatus; limit?: number } = {}) {
  const ownerSubValue = owner(ownerSub); const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("limit must be between 1 and 200");
  if (input.status && !approvalStatuses.includes(input.status)) fail("status is invalid");
  const result = input.taskId
    ? await db.prepare(`SELECT * FROM high_impact_approvals WHERE owner_sub = ? AND task_id = ?${input.status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(ownerSubValue, identifier(input.taskId, "taskId"), ...(input.status ? [input.status] : []), limit).all<ApprovalRow>()
    : await db.prepare(`SELECT * FROM high_impact_approvals WHERE owner_sub = ?${input.status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(ownerSubValue, ...(input.status ? [input.status] : []), limit).all<ApprovalRow>();
  return result.results.map(presentApproval);
}

export async function listApprovalAudit(db: D1Database, ownerSub: string, value: string) {
  return (await db.prepare("SELECT * FROM high_impact_approval_audit WHERE approval_id = ? AND owner_sub = ? ORDER BY created_at, id").bind(approvalId(value), owner(ownerSub)).all<ApprovalAuditRow>()).results;
}

async function expireIfNeeded(db: D1Database, row: ApprovalRow, at: Date) {
  if ((row.status === "pending" || row.status === "approved") && Date.parse(row.expires_at) <= at.getTime()) {
    const timestamp = at.toISOString();
    const results = await db.batch([
      db.prepare("UPDATE high_impact_approvals SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('pending', 'approved') AND expires_at <= ?").bind(timestamp, row.id, timestamp),
      db.prepare("INSERT OR IGNORE INTO high_impact_approval_audit (id, approval_id, owner_sub, event_type, actor_sub, reason, expected_head_sha, created_at) SELECT ?, id, owner_sub, 'expired', 'system', 'Approval validity window elapsed', expected_head_sha, ? FROM high_impact_approvals WHERE id = ? AND status = 'expired' AND updated_at = ?").bind(eventId(), timestamp, row.id, timestamp),
    ]);
    return Boolean(results[0].meta.changes);
  }
  return false;
}

export async function decideApproval(db: D1Database, ownerSub: string, value: string, input: { decision: ApprovalDecision; actorSub: string; reason: string; taskId: string; expectedHeadSha: string }, at = new Date()) {
  const row = await db.prepare("SELECT * FROM high_impact_approvals WHERE id = ? AND owner_sub = ?").bind(approvalId(value), owner(ownerSub)).first<ApprovalRow>();
  if (!row) throw new ApprovalValidationError("Approval not found");
  if (await expireIfNeeded(db, row, at)) throw new ApprovalValidationError("Approval has expired");
  const decision = enumeration(input.decision, "decision", ["approved", "denied"] as const);
  const sha = validateApprovalHeadSha(input.expectedHeadSha); const taskId = identifier(input.taskId, "taskId");
  if (row.task_id !== taskId || row.expected_head_sha !== sha) throw new ApprovalValidationError("Decision does not match the approval task and head SHA");
  const timestamp = at.toISOString(); const reason = text(input.reason, "reason", 2000); const actorSub = actor(input.actorSub);
  const results = await db.batch([
    db.prepare("UPDATE high_impact_approvals SET status = ?, decided_at = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status = 'pending' AND expires_at > ?").bind(decision, timestamp, timestamp, row.id, row.owner_sub, timestamp),
    db.prepare("INSERT OR IGNORE INTO high_impact_approval_audit (id, approval_id, owner_sub, event_type, actor_sub, reason, expected_head_sha, created_at) SELECT ?, id, owner_sub, ?, ?, ?, expected_head_sha, ? FROM high_impact_approvals WHERE id = ? AND status = ? AND updated_at = ?").bind(eventId(), decision, actorSub, reason, timestamp, row.id, decision, timestamp),
  ]);
  if (!results[0].meta.changes) throw new ApprovalValidationError("Approval is no longer pending");
  return getApproval(db, row.owner_sub, row.id);
}

export async function consumeApproval(db: D1Database, ownerSub: string, value: string, input: { action: ApprovalAction; actorSub: string; reason: string; taskId: string; expectedHeadSha: string }, at = new Date()) {
  const row = await db.prepare("SELECT * FROM high_impact_approvals WHERE id = ? AND owner_sub = ?").bind(approvalId(value), owner(ownerSub)).first<ApprovalRow>();
  if (!row) throw new ApprovalValidationError("Approval not found");
  if (await expireIfNeeded(db, row, at)) throw new ApprovalValidationError("Approval has expired");
  const gate = validateApprovalForAction({ approval:row, action:input.action, taskId:input.taskId, expectedHeadSha:input.expectedHeadSha }, at);
  if (!gate.allowed) throw new ApprovalValidationError(gate.reasons.join("; "));
  const timestamp = at.toISOString();
  const actorSub = actor(input.actorSub); const reason = text(input.reason, "reason", 2000);
  const results = await db.batch([
    db.prepare("UPDATE high_impact_approvals SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status = 'approved' AND expires_at > ?").bind(timestamp, timestamp, row.id, row.owner_sub, timestamp),
    db.prepare("INSERT OR IGNORE INTO high_impact_approval_audit (id, approval_id, owner_sub, event_type, actor_sub, reason, expected_head_sha, created_at) SELECT ?, id, owner_sub, 'consumed', ?, ?, expected_head_sha, ? FROM high_impact_approvals WHERE id = ? AND status = 'consumed' AND updated_at = ?").bind(eventId(), actorSub, reason, timestamp, row.id, timestamp),
  ]);
  if (!results[0].meta.changes) throw new ApprovalValidationError("Approval has already been consumed");
  return getApproval(db, row.owner_sub, row.id);
}

export async function getApprovalDelivery(db: D1Database, ownerSub: string, deliveryId: string) {
  const row = await db.prepare("SELECT * FROM high_impact_approval_deliveries WHERE id = ? AND owner_sub = ?").bind(identifier(deliveryId, "deliveryId"), owner(ownerSub)).first<ApprovalDeliveryRow>();
  return row ? presentDelivery(row) : null;
}

function assertDeliveryMatches(row: ApprovalDeliveryRow, input: { taskId:string; expectedHeadSha:string; workflowId:string; approvedBy:string; reviewRunId:string }) {
  const payload = validatePromotionDeliveryPayload(JSON.parse(row.payload_json));
  if (row.task_id !== input.taskId || row.expected_head_sha !== input.expectedHeadSha || row.workflow_id !== input.workflowId || payload.expectedHeadSha !== input.expectedHeadSha || payload.approvedBy !== input.approvedBy || payload.reviewRunId !== input.reviewRunId) {
    throw new ApprovalValidationError("Existing approval delivery does not match this promotion request");
  }
  return presentDelivery(row);
}

export async function enqueuePromotionApprovalDelivery(db: D1Database, ownerSub: string, value: string, input: { actorSub:string; reason:string; taskId:string; expectedHeadSha:string; workflowId:string; approvedBy:string; reviewRunId:string }, at = new Date()) {
  const ownerSubValue = owner(ownerSub); const idValue = approvalId(value);
  const taskId = identifier(input.taskId, "taskId"); const expectedHeadSha = validateApprovalHeadSha(input.expectedHeadSha);
  const workflowId = identifier(input.workflowId, "workflowId"); const approvedBy = text(input.approvedBy, "approvedBy", 512);
  const reviewRunId = identifier(input.reviewRunId, "reviewRunId");
  const row = await db.prepare("SELECT * FROM high_impact_approvals WHERE id = ? AND owner_sub = ?").bind(idValue, ownerSubValue).first<ApprovalRow>();
  if (!row) throw new ApprovalValidationError("Approval not found");
  if (row.status === "consumed") {
    const existing = await db.prepare("SELECT * FROM high_impact_approval_deliveries WHERE approval_id = ? AND owner_sub = ?").bind(row.id, ownerSubValue).first<ApprovalDeliveryRow>();
    if (!existing) throw new ApprovalValidationError("Consumed approval is missing its durable delivery record");
    return { delivery:assertDeliveryMatches(existing, { taskId, expectedHeadSha, workflowId, approvedBy, reviewRunId }), created:false };
  }
  if (await expireIfNeeded(db, row, at)) throw new ApprovalValidationError("Approval has expired");
  const gate = validateApprovalForAction({ approval:row, action:"promotion", taskId, expectedHeadSha }, at);
  if (!gate.allowed) throw new ApprovalValidationError(gate.reasons.join("; "));
  const deliveryId = id("apd"); const timestampValue = at.toISOString();
  const payload = validatePromotionDeliveryPayload({ approvedBy, approvedAt:timestampValue, expectedHeadSha, reviewRunId, approvalDeliveryId:deliveryId });
  const actorSub = actor(input.actorSub); const reason = text(input.reason, "reason", 2000);
  const results = await db.batch([
    db.prepare("UPDATE high_impact_approvals SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status = 'approved' AND expires_at > ?").bind(timestampValue, timestampValue, row.id, row.owner_sub, timestampValue),
    db.prepare("INSERT OR IGNORE INTO high_impact_approval_audit (id, approval_id, owner_sub, event_type, actor_sub, reason, expected_head_sha, created_at) SELECT ?, id, owner_sub, 'consumed', ?, ?, expected_head_sha, ? FROM high_impact_approvals WHERE id = ? AND status = 'consumed' AND updated_at = ?").bind(eventId(), actorSub, reason, timestampValue, row.id, timestampValue),
    db.prepare("INSERT OR IGNORE INTO high_impact_approval_deliveries (id, approval_id, owner_sub, task_id, expected_head_sha, workflow_id, event_type, payload_json, status, created_at, updated_at) SELECT ?, id, owner_sub, task_id, expected_head_sha, ?, 'promote', ?, 'pending', ?, ? FROM high_impact_approvals WHERE id = ? AND status = 'consumed' AND updated_at = ?").bind(deliveryId, workflowId, JSON.stringify(payload), timestampValue, timestampValue, row.id, timestampValue),
  ]);
  const delivery = await db.prepare("SELECT * FROM high_impact_approval_deliveries WHERE approval_id = ? AND owner_sub = ?").bind(row.id, ownerSubValue).first<ApprovalDeliveryRow>();
  if (!delivery) throw new ApprovalValidationError("Approval delivery could not be reserved");
  return { delivery:assertDeliveryMatches(delivery, { taskId, expectedHeadSha, workflowId, approvedBy, reviewRunId }), created:Boolean(results[0].meta.changes) };
}

export async function deliverApprovalOutbox(db: D1Database, ownerSub: string, deliveryId: string, send: (delivery: { eventType:"promote"; payload:PromotionDeliveryPayload }) => Promise<void>, at = new Date()) {
  const ownerSubValue = owner(ownerSub); const idValue = identifier(deliveryId, "deliveryId");
  const initial = await db.prepare("SELECT * FROM high_impact_approval_deliveries WHERE id = ? AND owner_sub = ?").bind(idValue, ownerSubValue).first<ApprovalDeliveryRow>();
  if (!initial) throw new ApprovalValidationError("Approval delivery not found");
  if (initial.status === "delivered") return { delivery:presentDelivery(initial), deliveredNow:false, busy:false };
  const leaseToken = id("lease"); const timestampValue = at.toISOString(); const leaseExpiresAt = new Date(at.getTime() + 60_000).toISOString();
  const claimed = await db.prepare("UPDATE high_impact_approval_deliveries SET status = 'delivering', attempt_count = attempt_count + 1, lease_token = ?, lease_expires_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND owner_sub = ? AND (status IN ('pending', 'failed') OR (status = 'delivering' AND lease_expires_at <= ?))").bind(leaseToken, leaseExpiresAt, timestampValue, idValue, ownerSubValue, timestampValue).run();
  if (!claimed.meta.changes) {
    const current = await db.prepare("SELECT * FROM high_impact_approval_deliveries WHERE id = ? AND owner_sub = ?").bind(idValue, ownerSubValue).first<ApprovalDeliveryRow>();
    if (!current) throw new ApprovalValidationError("Approval delivery not found");
    return { delivery:presentDelivery(current), deliveredNow:false, busy:current.status !== "delivered" };
  }
  const payload = validatePromotionDeliveryPayload(JSON.parse(initial.payload_json));
  try {
    await send({ eventType:"promote", payload });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Workflow event delivery failed").slice(0, 1000) || "Workflow event delivery failed";
    await db.prepare("UPDATE high_impact_approval_deliveries SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status = 'delivering' AND lease_token = ?").bind(message, new Date().toISOString(), idValue, ownerSubValue, leaseToken).run();
    throw new ApprovalValidationError(`Promotion delivery is safely queued for retry: ${message}`);
  }
  const deliveredAt = new Date().toISOString();
  const completed = await db.prepare("UPDATE high_impact_approval_deliveries SET status = 'delivered', lease_token = NULL, lease_expires_at = NULL, last_error = NULL, delivered_at = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status = 'delivering' AND lease_token = ?").bind(deliveredAt, deliveredAt, idValue, ownerSubValue, leaseToken).run();
  if (!completed.meta.changes) throw new ApprovalValidationError("Promotion was sent but its durable delivery acknowledgement could not be recorded");
  const delivery = await db.prepare("SELECT * FROM high_impact_approval_deliveries WHERE id = ? AND owner_sub = ?").bind(idValue, ownerSubValue).first<ApprovalDeliveryRow>();
  if (!delivery) throw new ApprovalValidationError("Approval delivery not found");
  return { delivery:presentDelivery(delivery), deliveredNow:true, busy:false };
}

export async function cancelApproval(db: D1Database, ownerSub: string, value: string, input: { actorSub: string; reason: string }, at = new Date()) {
  const row = await db.prepare("SELECT * FROM high_impact_approvals WHERE id = ? AND owner_sub = ?").bind(approvalId(value), owner(ownerSub)).first<ApprovalRow>();
  if (!row) throw new ApprovalValidationError("Approval not found");
  if (await expireIfNeeded(db, row, at)) throw new ApprovalValidationError("Approval has expired");
  const timestamp = at.toISOString();
  const actorSub = actor(input.actorSub); const reason = text(input.reason, "reason", 2000);
  const results = await db.batch([
    db.prepare("UPDATE high_impact_approvals SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status IN ('pending', 'approved')").bind(timestamp, timestamp, row.id, row.owner_sub),
    db.prepare("INSERT OR IGNORE INTO high_impact_approval_audit (id, approval_id, owner_sub, event_type, actor_sub, reason, expected_head_sha, created_at) SELECT ?, id, owner_sub, 'cancelled', ?, ?, expected_head_sha, ? FROM high_impact_approvals WHERE id = ? AND status = 'cancelled' AND updated_at = ?").bind(eventId(), actorSub, reason, timestamp, row.id, timestamp),
  ]);
  if (!results[0].meta.changes) throw new ApprovalValidationError("Approval cannot be cancelled in its current state");
  return getApproval(db, row.owner_sub, row.id);
}

export async function expireApprovals(db: D1Database, at = new Date(), limit = 200) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("limit must be between 1 and 1000");
  const rows = (await db.prepare("SELECT * FROM high_impact_approvals WHERE status IN ('pending', 'approved') AND expires_at <= ? ORDER BY expires_at LIMIT ?").bind(at.toISOString(), limit).all<ApprovalRow>()).results;
  let expired = 0;
  for (const row of rows) if (await expireIfNeeded(db, row, at)) expired += 1;
  return expired;
}
