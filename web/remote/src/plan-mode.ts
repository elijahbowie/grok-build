import { id, now } from "./db";

export const planRevisionStatuses = ["draft", "awaiting_approval", "approved", "rejected", "changes_requested", "cancelled"] as const;
export const planStepStatuses = ["pending", "in_progress", "completed", "blocked", "skipped"] as const;
export const planExecutionPhases = ["planning", "awaiting_approval", "approved", "building", "cancelled", "recovery_required", "completed"] as const;

export type PlanRevisionStatus = typeof planRevisionStatuses[number];
export type PlanStepStatus = typeof planStepStatuses[number];
export type PlanExecutionPhase = typeof planExecutionPhases[number];
export type PlanDecision = "approve" | "reject" | "request_changes";
export type PlanCapability = "read" | "queue_message" | "plan_decision" | "workspace_write" | "command_execute" | "external_write";

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  acceptanceChecks: string[];
};

export type StructuredPlan = {
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
  acceptanceChecks: string[];
};

export type PlanRevisionRow = {
  id: string;
  task_id: string;
  owner_sub: string;
  revision: number;
  status: PlanRevisionStatus;
  goal: string;
  assumptions_json: string;
  steps_json: string;
  acceptance_checks_json: string;
  content_digest: string;
  created_by_sub: string;
  submitted_at: string | null;
  decided_by_sub: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanStateRow = {
  task_id: string;
  owner_sub: string;
  current_revision_id: string | null;
  approved_revision_id: string | null;
  execution_phase: PlanExecutionPhase;
  cancellation_reason: string | null;
  cancelled_by_sub: string | null;
  cancelled_at: string | null;
  updated_at: string;
};

export type PlanStepStateRow = {
  plan_revision_id: string;
  task_id: string;
  owner_sub: string;
  step_id: string;
  position: number;
  status: PlanStepStatus;
  status_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export class PlanValidationError extends Error {
  constructor(message: string) { super(message); this.name = "PlanValidationError"; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new PlanValidationError(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value.trim();
}

function stringList(value: unknown, label: string, maximumItems: number, maximumLength: number, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new PlanValidationError(`${label} must be an array with at most ${maximumItems} entries`);
  const normalized = value.map((entry, index) => requiredText(entry, `${label}[${index}]`, maximumLength));
  if (!allowEmpty && !normalized.length) throw new PlanValidationError(`${label} cannot be empty`);
  if (new Set(normalized).size !== normalized.length) throw new PlanValidationError(`${label} cannot contain duplicates`);
  return normalized;
}

export function validateStructuredPlan(value: unknown): StructuredPlan {
  const root = object(value, "plan");
  const goal = requiredText(root.goal, "goal", 8_000);
  const assumptions = stringList(root.assumptions, "assumptions", 100, 2_000);
  const acceptanceChecks = stringList(root.acceptanceChecks, "acceptanceChecks", 200, 2_000, false);
  if (!Array.isArray(root.steps) || !root.steps.length || root.steps.length > 200) throw new PlanValidationError("steps must contain between 1 and 200 entries");

  const seen = new Set<string>();
  const steps = root.steps.map((candidate, index): PlanStep => {
    const step = object(candidate, `steps[${index}]`);
    const stepId = requiredText(step.id, `steps[${index}].id`, 80);
    if (!/^[a-z][a-z0-9_-]*$/.test(stepId)) throw new PlanValidationError(`steps[${index}].id must use lowercase letters, digits, hyphens, or underscores and start with a letter`);
    if (seen.has(stepId)) throw new PlanValidationError(`duplicate step id: ${stepId}`);
    const dependencies = stringList(step.dependencies, `steps[${index}].dependencies`, 50, 80);
    for (const dependency of dependencies) {
      if (!seen.has(dependency)) throw new PlanValidationError(`step ${stepId} dependency ${dependency} must reference an earlier step`);
    }
    seen.add(stepId);
    return {
      id: stepId,
      title: requiredText(step.title, `steps[${index}].title`, 240),
      description: requiredText(step.description, `steps[${index}].description`, 8_000),
      dependencies,
      acceptanceChecks: stringList(step.acceptanceChecks, `steps[${index}].acceptanceChecks`, 50, 2_000, false),
    };
  });
  return { goal, assumptions, steps, acceptanceChecks };
}

export function planFromRow(row: PlanRevisionRow): StructuredPlan {
  return validateStructuredPlan({
    goal: row.goal,
    assumptions: JSON.parse(row.assumptions_json),
    steps: JSON.parse(row.steps_json),
    acceptanceChecks: JSON.parse(row.acceptance_checks_json),
  });
}

function stablePlanJson(plan: StructuredPlan) {
  return JSON.stringify({ goal: plan.goal, assumptions: plan.assumptions, steps: plan.steps, acceptanceChecks: plan.acceptanceChecks });
}

export async function planDigest(value: unknown) {
  const data = new TextEncoder().encode(stablePlanJson(validateStructuredPlan(value)));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decidePlanCapability(phase: PlanExecutionPhase, capability: PlanCapability) {
  const control = capability === "read" || capability === "queue_message" || capability === "plan_decision";
  if (phase === "planning" || phase === "awaiting_approval" || phase === "approved") {
    return { allowed: control, reason: control ? "planning-control" : "planning-is-read-only" };
  }
  if (phase === "building") return { allowed: capability !== "plan_decision", reason: capability === "plan_decision" ? "plan-already-approved" : "build-running" };
  return { allowed: capability === "read", reason: capability === "read" ? "read-only-terminal-phase" : `execution-${phase}` };
}

export function assertPlanCapability(phase: PlanExecutionPhase, capability: PlanCapability) {
  const decision = decidePlanCapability(phase, capability);
  if (!decision.allowed) throw new PlanValidationError(`Capability ${capability} denied: ${decision.reason}`);
}

export function evaluateBuildGate(input: { requestedRevisionId: string; currentRevisionId: string | null; approvedRevisionId: string | null; revisionStatus: PlanRevisionStatus | null; executionPhase: PlanExecutionPhase }) {
  const reasons: string[] = [];
  if (!input.currentRevisionId || input.requestedRevisionId !== input.currentRevisionId) reasons.push("Requested plan revision is not current");
  if (!input.approvedRevisionId || input.requestedRevisionId !== input.approvedRevisionId) reasons.push("Exact plan revision has not been approved");
  if (input.revisionStatus !== "approved") reasons.push("Plan revision status is not approved");
  if (input.executionPhase !== "approved") reasons.push(`Plan execution phase is ${input.executionPhase}`);
  return { allowed: reasons.length === 0, reasons };
}

const allowedStepTransitions: Record<PlanStepStatus, readonly PlanStepStatus[]> = {
  pending: ["in_progress", "blocked", "skipped"],
  in_progress: ["completed", "blocked"],
  blocked: ["in_progress", "skipped"],
  completed: [],
  skipped: [],
};

export function validateStepTransition(input: { from: PlanStepStatus; to: PlanStepStatus; dependencies: string[]; stepStates: Readonly<Record<string, PlanStepStatus>>; reason?: string | null }) {
  if (!allowedStepTransitions[input.from].includes(input.to)) throw new PlanValidationError(`Invalid step transition: ${input.from} -> ${input.to}`);
  const unmet = input.dependencies.filter((dependency) => !["completed", "skipped"].includes(input.stepStates[dependency]));
  if (input.to === "in_progress" && unmet.length) throw new PlanValidationError(`Step has unmet dependencies: ${unmet.join(", ")}`);
  if ((input.to === "blocked" || input.to === "skipped") && !input.reason?.trim()) throw new PlanValidationError(`${input.to} transitions require a reason`);
  return true;
}

export async function initializePlanExecution(db: D1Database, input: {taskId:string;ownerSub:string;actorSub:string}) {
  const timestamp = now();
  const result = await db.prepare("INSERT OR IGNORE INTO task_plan_state (task_id, owner_sub, current_revision_id, approved_revision_id, execution_phase, updated_at) SELECT id, owner_sub, NULL, NULL, 'planning', ? FROM tasks WHERE id=? AND owner_sub=?")
    .bind(timestamp, input.taskId, input.ownerSub).run();
  if (!result.meta.changes) {
    const existing = await db.prepare("SELECT task_id FROM task_plan_state WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first();
    if (!existing) throw new PlanValidationError("Planning task was not found");
  } else await audit(db, { taskId: input.taskId, ownerSub: input.ownerSub, actorSub: input.actorSub, action: "execution.initialized", to: "planning" });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

async function audit(db: D1Database, input: {taskId:string;ownerSub:string;revisionId?:string|null;actorSub:string;action:string;from?:string|null;to?:string|null;detail?:unknown}) {
  await db.prepare("INSERT INTO plan_audit_events (id, task_id, owner_sub, plan_revision_id, actor_sub, action, from_state, to_state, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id("pae"), input.taskId, input.ownerSub, input.revisionId ?? null, input.actorSub, input.action, input.from ?? null, input.to ?? null, JSON.stringify(input.detail ?? {}), now()).run();
}

export async function createPlanRevision(db: D1Database, input: {taskId:string;ownerSub:string;createdBySub:string;plan:unknown;submit?:boolean}) {
  const plan = validateStructuredPlan(input.plan);
  const digest = await planDigest(plan);
  const timestamp = now();
  const revisionId = id("pln");
  const next = await db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM plan_revisions WHERE task_id = ? AND owner_sub = ?").bind(input.taskId, input.ownerSub).first<{revision:number}>();
  const revision = next?.revision ?? 1;
  const status: PlanRevisionStatus = input.submit ? "awaiting_approval" : "draft";
  await db.batch([
    db.prepare("INSERT INTO plan_revisions (id, task_id, owner_sub, revision, status, goal, assumptions_json, steps_json, acceptance_checks_json, content_digest, created_by_sub, submitted_at, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND owner_sub = ?)")
      .bind(revisionId, input.taskId, input.ownerSub, revision, status, plan.goal, JSON.stringify(plan.assumptions), JSON.stringify(plan.steps), JSON.stringify(plan.acceptanceChecks), digest, input.createdBySub, input.submit ? timestamp : null, timestamp, timestamp, input.taskId, input.ownerSub),
    ...plan.steps.map((step, position) => db.prepare("INSERT INTO plan_step_states (plan_revision_id, task_id, owner_sub, step_id, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(revisionId, input.taskId, input.ownerSub, step.id, position, timestamp)),
    db.prepare("INSERT INTO task_plan_state (task_id, owner_sub, current_revision_id, approved_revision_id, execution_phase, updated_at) VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(task_id) DO UPDATE SET current_revision_id=excluded.current_revision_id, approved_revision_id=NULL, execution_phase=excluded.execution_phase, cancellation_reason=NULL, cancelled_by_sub=NULL, cancelled_at=NULL, updated_at=excluded.updated_at WHERE task_plan_state.owner_sub=excluded.owner_sub")
      .bind(input.taskId, input.ownerSub, revisionId, input.submit ? "awaiting_approval" : "planning", timestamp),
  ]);
  const created = await getPlanRevision(db, input.ownerSub, revisionId);
  if (!created) throw new Error("Task was not found or plan revision could not be created");
  await audit(db, { taskId: input.taskId, ownerSub: input.ownerSub, revisionId, actorSub: input.createdBySub, action: "revision.created", to: status, detail: { revision, digest } });
  return created;
}

export async function getPlanRevision(db: D1Database, ownerSub: string, revisionId: string) {
  return db.prepare("SELECT * FROM plan_revisions WHERE id = ? AND owner_sub = ?").bind(revisionId, ownerSub).first<PlanRevisionRow>();
}

export async function listPlanRevisions(db: D1Database, ownerSub: string, taskId: string) {
  return (await db.prepare("SELECT * FROM plan_revisions WHERE task_id = ? AND owner_sub = ? ORDER BY revision DESC").bind(taskId, ownerSub).all<PlanRevisionRow>()).results;
}

export async function getTaskPlan(db: D1Database, ownerSub: string, taskId: string) {
  const state = await db.prepare("SELECT * FROM task_plan_state WHERE task_id = ? AND owner_sub = ?").bind(taskId, ownerSub).first<PlanStateRow>();
  if (!state) return null;
  const [revision, steps] = state.current_revision_id ? await Promise.all([
    getPlanRevision(db, ownerSub, state.current_revision_id),
    db.prepare("SELECT * FROM plan_step_states WHERE plan_revision_id = ? AND owner_sub = ? ORDER BY position").bind(state.current_revision_id, ownerSub).all<PlanStepStateRow>(),
  ]) : [null, { results: [] as PlanStepStateRow[] }];
  return { state, revision, plan: revision ? planFromRow(revision) : null, steps: steps.results };
}

export async function submitPlanRevision(db: D1Database, input: {revisionId:string;taskId:string;ownerSub:string;actorSub:string}) {
  const timestamp = now();
  const result = await db.prepare("UPDATE plan_revisions SET status='awaiting_approval', submitted_at=?, updated_at=? WHERE id=? AND task_id=? AND owner_sub=? AND status='draft' AND EXISTS (SELECT 1 FROM task_plan_state WHERE task_id=? AND owner_sub=? AND current_revision_id=?)")
    .bind(timestamp, timestamp, input.revisionId, input.taskId, input.ownerSub, input.taskId, input.ownerSub, input.revisionId).run();
  if (!result.meta.changes) throw new PlanValidationError("Only the current draft revision can be submitted");
  await db.prepare("UPDATE task_plan_state SET execution_phase='awaiting_approval', updated_at=? WHERE task_id=? AND owner_sub=? AND current_revision_id=?").bind(timestamp, input.taskId, input.ownerSub, input.revisionId).run();
  await audit(db, { ...input, revisionId: input.revisionId, action: "revision.submitted", from: "draft", to: "awaiting_approval" });
  return getPlanRevision(db, input.ownerSub, input.revisionId);
}

export async function decidePlanRevision(db: D1Database, input: {revisionId:string;taskId:string;ownerSub:string;actorSub:string;decision:PlanDecision;reason?:string|null}) {
  const reason = input.decision === "approve" ? (input.reason?.trim().slice(0, 4_000) || null) : requiredText(input.reason, "decision reason", 4_000);
  const target: PlanRevisionStatus = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
  const phase: PlanExecutionPhase = target === "approved" ? "approved" : "planning";
  const timestamp = now();
  const result = await db.prepare("UPDATE plan_revisions SET status=?, decided_by_sub=?, decision_reason=?, decided_at=?, updated_at=? WHERE id=? AND task_id=? AND owner_sub=? AND status='awaiting_approval' AND EXISTS (SELECT 1 FROM task_plan_state WHERE task_id=? AND owner_sub=? AND current_revision_id=?)")
    .bind(target, input.actorSub, reason, timestamp, timestamp, input.revisionId, input.taskId, input.ownerSub, input.taskId, input.ownerSub, input.revisionId).run();
  if (!result.meta.changes) throw new PlanValidationError("Only the exact current revision awaiting approval can be decided");
  await db.prepare("UPDATE task_plan_state SET approved_revision_id=?, execution_phase=?, updated_at=? WHERE task_id=? AND owner_sub=? AND current_revision_id=?")
    .bind(target === "approved" ? input.revisionId : null, phase, timestamp, input.taskId, input.ownerSub, input.revisionId).run();
  await audit(db, { ...input, revisionId: input.revisionId, action: `revision.${input.decision}`, from: "awaiting_approval", to: target, detail: { reason } });
  return getPlanRevision(db, input.ownerSub, input.revisionId);
}

export async function startApprovedPlanBuild(db: D1Database, input: {taskId:string;ownerSub:string;revisionId:string;actorSub:string}) {
  const state = await db.prepare("SELECT * FROM task_plan_state WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<PlanStateRow>();
  const revision = await getPlanRevision(db, input.ownerSub, input.revisionId);
  const gate = evaluateBuildGate({ requestedRevisionId: input.revisionId, currentRevisionId: state?.current_revision_id ?? null, approvedRevisionId: state?.approved_revision_id ?? null, revisionStatus: revision?.status ?? null, executionPhase: state?.execution_phase ?? "planning" });
  if (!gate.allowed) throw new PlanValidationError(`Build cannot start: ${gate.reasons.join("; ")}`);
  const timestamp = now();
  const result = await db.prepare("UPDATE task_plan_state SET execution_phase='building', updated_at=? WHERE task_id=? AND owner_sub=? AND current_revision_id=? AND approved_revision_id=? AND execution_phase='approved'")
    .bind(timestamp, input.taskId, input.ownerSub, input.revisionId, input.revisionId).run();
  if (!result.meta.changes) throw new PlanValidationError("Plan approval changed before build start");
  await audit(db, { ...input, revisionId: input.revisionId, action: "build.started", from: "approved", to: "building" });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

export async function transitionPlanStep(db: D1Database, input: {taskId:string;ownerSub:string;revisionId:string;stepId:string;to:PlanStepStatus;actorSub:string;reason?:string|null}) {
  const taskPlan = await getTaskPlan(db, input.ownerSub, input.taskId);
  if (!taskPlan || taskPlan.state.execution_phase !== "building" || taskPlan.state.approved_revision_id !== input.revisionId || taskPlan.revision?.id !== input.revisionId) throw new PlanValidationError("Steps can change only while the exact approved revision is building");
  const step = taskPlan.plan?.steps.find((candidate) => candidate.id === input.stepId);
  const current = taskPlan.steps.find((candidate) => candidate.step_id === input.stepId);
  if (!step || !current) throw new PlanValidationError("Plan step was not found");
  const states = Object.fromEntries(taskPlan.steps.map((candidate) => [candidate.step_id, candidate.status]));
  validateStepTransition({ from: current.status, to: input.to, dependencies: step.dependencies, stepStates: states, reason: input.reason });
  const timestamp = now();
  const result = await db.prepare("UPDATE plan_step_states SET status=?, status_reason=?, started_at=CASE WHEN ?='in_progress' THEN COALESCE(started_at, ?) ELSE started_at END, completed_at=CASE WHEN ? IN ('completed','skipped') THEN ? ELSE NULL END, updated_at=? WHERE plan_revision_id=? AND task_id=? AND owner_sub=? AND step_id=? AND status=?")
    .bind(input.to, input.reason?.trim().slice(0, 4_000) || null, input.to, timestamp, input.to, timestamp, timestamp, input.revisionId, input.taskId, input.ownerSub, input.stepId, current.status).run();
  if (!result.meta.changes) throw new PlanValidationError("Step state changed concurrently");
  await audit(db, { ...input, revisionId: input.revisionId, action: "step.transitioned", from: current.status, to: input.to, detail: { stepId: input.stepId, reason: input.reason ?? null } });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

export async function queuePlanMessage(db: D1Database, input: {taskId:string;ownerSub:string;body:string;actorSub?:string}) {
  const body = requiredText(input.body, "message", 16_000);
  const state = await db.prepare("SELECT execution_phase FROM task_plan_state WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<{execution_phase:PlanExecutionPhase}>();
  if (!state || !["planning", "awaiting_approval", "approved", "building", "recovery_required"].includes(state.execution_phase)) throw new PlanValidationError("Messages can be queued only while planning or agent execution is active");
  const sequence = (await db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM plan_message_queue WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<{sequence:number}>())?.sequence ?? 1;
  const messageId = id("pmsg");
  await db.prepare("INSERT INTO plan_message_queue (id, task_id, owner_sub, sequence, body, queued_at) VALUES (?, ?, ?, ?, ?, ?)").bind(messageId, input.taskId, input.ownerSub, sequence, body, now()).run();
  await audit(db, { taskId: input.taskId, ownerSub: input.ownerSub, actorSub: input.actorSub ?? input.ownerSub, action: "message.queued", to: "queued", detail: { messageId, sequence } });
  return { id: messageId, taskId: input.taskId, sequence, body, status: "queued" as const };
}

export async function listPlanMessages(db: D1Database, input: {taskId:string;ownerSub:string;limit?:number}) {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  return (await db.prepare("SELECT id, sequence, body, status, queued_at, delivered_at, cancelled_at FROM plan_message_queue WHERE task_id=? AND owner_sub=? ORDER BY sequence DESC LIMIT ?")
    .bind(input.taskId, input.ownerSub, limit).all<{id:string;sequence:number;body:string;status:"queued"|"delivered"|"cancelled";queued_at:string;delivered_at:string|null;cancelled_at:string|null}>()).results;
}

type ClaimedPlanMessage = {id:string;sequence:number;body:string;queued_at:string;claimToken:string;claimedAt:string};

export async function deliverQueuedPlanMessages(db: D1Database, input: {taskId:string;ownerSub:string;limit?:number;actorSub?:string}): Promise<ClaimedPlanMessage[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const messages = (await db.prepare("SELECT id, sequence, body, queued_at FROM plan_message_queue WHERE task_id=? AND owner_sub=? AND status='queued' AND claim_token IS NULL ORDER BY sequence LIMIT ?").bind(input.taskId, input.ownerSub, limit).all<{id:string;sequence:number;body:string;queued_at:string}>()).results;
  if (messages.length) {
    const claimToken = id("pmsg_claim"); const claimedAt = now();
    const results = await db.batch(messages.map((message) => db.prepare("UPDATE plan_message_queue SET claim_token=?, claimed_at=? WHERE id=? AND task_id=? AND owner_sub=? AND status='queued' AND claim_token IS NULL").bind(claimToken, claimedAt, message.id, input.taskId, input.ownerSub)));
    if (results.some((result) => result.meta.changes !== 1)) throw new PlanValidationError("Queued plan guidance changed while it was being claimed");
    return messages.map((message) => ({ ...message, claimToken, claimedAt }));
  }
  return [];
}

export async function acknowledgePlanMessages(db: D1Database, input: {taskId:string;ownerSub:string;claimToken:string;actorSub?:string}) {
  const timestamp = now();
  const rows = await db.prepare("SELECT id FROM plan_message_queue WHERE task_id=? AND owner_sub=? AND status='queued' AND claim_token=?").bind(input.taskId, input.ownerSub, input.claimToken).all<{id:string}>();
  if (!rows.results.length) throw new PlanValidationError("Queued plan guidance claim is no longer active");
  await db.prepare("UPDATE plan_message_queue SET status='delivered', delivered_at=?, claim_token=NULL, claimed_at=NULL WHERE task_id=? AND owner_sub=? AND status='queued' AND claim_token=?")
    .bind(timestamp, input.taskId, input.ownerSub, input.claimToken).run();
  await audit(db, { taskId: input.taskId, ownerSub: input.ownerSub, actorSub: input.actorSub ?? input.ownerSub, action: "messages.delivered", from: "queued", to: "delivered", detail: { messageIds: rows.results.map((row) => row.id) } });
}

export async function releasePlanMessages(db: D1Database, input: {taskId:string;ownerSub:string;claimToken:string}) {
  await db.prepare("UPDATE plan_message_queue SET claim_token=NULL, claimed_at=NULL WHERE task_id=? AND owner_sub=? AND status='queued' AND claim_token=?")
    .bind(input.taskId, input.ownerSub, input.claimToken).run();
}

export async function cancelPlanExecution(db: D1Database, input: {taskId:string;ownerSub:string;actorSub:string;reason:string}) {
  const reason = requiredText(input.reason, "cancellation reason", 4_000); const timestamp = now();
  const state = await db.prepare("SELECT * FROM task_plan_state WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<PlanStateRow>();
  if (!state || ["cancelled", "completed"].includes(state.execution_phase)) throw new PlanValidationError("Plan execution cannot be cancelled from its current phase");
  await db.batch([
    db.prepare("UPDATE task_plan_state SET execution_phase='cancelled', cancellation_reason=?, cancelled_by_sub=?, cancelled_at=?, updated_at=? WHERE task_id=? AND owner_sub=? AND execution_phase=?").bind(reason, input.actorSub, timestamp, timestamp, input.taskId, input.ownerSub, state.execution_phase),
    db.prepare("UPDATE plan_message_queue SET status='cancelled', cancelled_at=? WHERE task_id=? AND owner_sub=? AND status='queued'").bind(timestamp, input.taskId, input.ownerSub),
  ]);
  await audit(db, { ...input, revisionId: state.current_revision_id, action: "execution.cancelled", from: state.execution_phase, to: "cancelled", detail: { reason } });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

export async function requirePlanRecovery(db: D1Database, input: {taskId:string;ownerSub:string;actorSub:string;reason:string}) {
  const reason = requiredText(input.reason, "recovery reason", 4_000); const timestamp = now();
  const state = await db.prepare("SELECT * FROM task_plan_state WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<PlanStateRow>();
  if (!state || state.execution_phase !== "building") throw new PlanValidationError("Recovery can be required only for a running build");
  await db.prepare("UPDATE task_plan_state SET execution_phase='recovery_required', cancellation_reason=?, updated_at=? WHERE task_id=? AND owner_sub=? AND execution_phase='building'").bind(reason, timestamp, input.taskId, input.ownerSub).run();
  await audit(db, { ...input, revisionId: state.current_revision_id, action: "execution.recovery_required", from: "building", to: "recovery_required", detail: { reason } });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

export async function recoverPlanExecution(db: D1Database, input: {taskId:string;ownerSub:string;revisionId:string;actorSub:string;reason:string}) {
  const reason = requiredText(input.reason, "recovery reason", 4_000); const timestamp = now();
  const state = await db.prepare("SELECT * FROM task_plan_state WHERE task_id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<PlanStateRow>();
  const revision = await getPlanRevision(db, input.ownerSub, input.revisionId);
  if (!state || !revision || !["cancelled", "recovery_required"].includes(state.execution_phase) || state.current_revision_id !== input.revisionId || revision.task_id !== input.taskId) throw new PlanValidationError("Only the exact current revision can recover a cancelled or failed Plan Mode session");
  let phase: PlanExecutionPhase;
  if (revision.status === "approved" && state.approved_revision_id === input.revisionId) phase = "approved";
  else if (state.execution_phase === "recovery_required") throw new PlanValidationError("A failed build can recover only with its exact approved revision");
  else if (revision.status === "awaiting_approval") phase = "awaiting_approval";
  else phase = "planning";
  const statements = [
    db.prepare("UPDATE task_plan_state SET execution_phase=?, cancellation_reason=NULL, cancelled_by_sub=NULL, cancelled_at=NULL, updated_at=? WHERE task_id=? AND owner_sub=? AND current_revision_id=? AND execution_phase=?").bind(phase, timestamp, input.taskId, input.ownerSub, input.revisionId, state.execution_phase),
  ];
  if (phase === "approved") statements.push(db.prepare("UPDATE plan_step_states SET status='pending', status_reason=NULL, started_at=NULL, completed_at=NULL, updated_at=? WHERE plan_revision_id=? AND task_id=? AND owner_sub=? AND status IN ('in_progress','blocked')").bind(timestamp, input.revisionId, input.taskId, input.ownerSub));
  await db.batch(statements);
  await audit(db, { ...input, revisionId: input.revisionId, action: "execution.recovered", from: state.execution_phase, to: phase, detail: { reason } });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

export async function completePlanExecution(db: D1Database, input: {taskId:string;ownerSub:string;revisionId:string;actorSub:string}) {
  const taskPlan = await getTaskPlan(db, input.ownerSub, input.taskId);
  if (!taskPlan || taskPlan.state.execution_phase !== "building" || taskPlan.state.approved_revision_id !== input.revisionId) throw new PlanValidationError("Only the exact running approved plan can complete");
  const unfinished = taskPlan.steps.filter((step) => step.status !== "completed" && step.status !== "skipped");
  if (unfinished.length) throw new PlanValidationError(`Plan has unfinished steps: ${unfinished.map((step) => step.step_id).join(", ")}`);
  await db.prepare("UPDATE task_plan_state SET execution_phase='completed', updated_at=? WHERE task_id=? AND owner_sub=? AND approved_revision_id=? AND execution_phase='building'").bind(now(), input.taskId, input.ownerSub, input.revisionId).run();
  await audit(db, { ...input, revisionId: input.revisionId, action: "execution.completed", from: "building", to: "completed" });
  return getTaskPlan(db, input.ownerSub, input.taskId);
}

export async function listPlanAuditEvents(db: D1Database, ownerSub: string, taskId: string, limit = 200) {
  return (await db.prepare("SELECT * FROM plan_audit_events WHERE task_id=? AND owner_sub=? ORDER BY created_at DESC LIMIT ?").bind(taskId, ownerSub, Math.max(1, Math.min(1000, Math.trunc(limit)))).all()).results;
}
