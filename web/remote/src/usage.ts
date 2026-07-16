import { id, now } from "./db";

export type UsageCategory = "model" | "container" | "storage" | "network" | "workflow";
export type BudgetEnforcement = "warn" | "block_new" | "stop_active";

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
};

export class UsageValidationError extends Error {
  constructor(message: string) { super(message); this.name = "UsageValidationError"; }
}
function safeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function extractAgentUsage(jsonl: string): AgentUsage {
  let inputTokens = 0; let outputTokens = 0; let totalTokens = 0; let costMicros = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
    if (usage) {
      inputTokens = Math.max(inputTokens, safeCount(usage.input_tokens ?? usage.inputTokens));
      outputTokens = Math.max(outputTokens, safeCount(usage.output_tokens ?? usage.outputTokens));
      totalTokens = Math.max(totalTokens, safeCount(usage.total_tokens ?? usage.totalTokens));
    }
    const dollars = typeof event.total_cost_usd === "number" ? event.total_cost_usd : typeof event.cost_usd === "number" ? event.cost_usd : null;
    if (dollars !== null && Number.isFinite(dollars) && dollars >= 0) costMicros = Math.max(costMicros, Math.round(dollars * 1_000_000));
  }
  if (!totalTokens) totalTokens = inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens, costMicros };
}

export function containerCostMicros(activeMilliseconds: number, hourlyMicros: number) {
  if (!Number.isFinite(activeMilliseconds) || activeMilliseconds < 0 || !Number.isFinite(hourlyMicros) || hourlyMicros < 0) throw new UsageValidationError("Container cost inputs must be non-negative");
  return Math.round((activeMilliseconds / 3_600_000) * hourlyMicros);
}

export async function recordUsageEvent(db: D1Database, input: {
  ownerSub:string; projectId?:string|null; taskId?:string|null; automationRunId?:string|null;
  category:UsageCategory; meter:string; quantity:number; unit:string; costMicros?:number; model?:string|null;
  source:string; idempotencyKey:string; metadata?:Record<string, unknown>; occurredAt?:string;
}) {
  if (!Number.isFinite(input.quantity) || input.quantity < 0 || !Number.isInteger(input.costMicros ?? 0) || (input.costMicros ?? 0) < 0) throw new UsageValidationError("Usage quantity or cost is invalid");
  const timestamp = now(); const usageId = id("use");
  await db.prepare(`INSERT OR IGNORE INTO usage_events
    (id, owner_sub, project_id, task_id, automation_run_id, category, meter, quantity, unit, cost_micros, model, source, idempotency_key, metadata_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(usageId, input.ownerSub, input.projectId ?? null, input.taskId ?? null, input.automationRunId ?? null, input.category, input.meter.slice(0, 160), input.quantity, input.unit.slice(0, 80), input.costMicros ?? 0, input.model ?? null, input.source.slice(0, 160), input.idempotencyKey.slice(0, 300), JSON.stringify(input.metadata ?? {}), input.occurredAt ?? timestamp, timestamp).run();
  return db.prepare("SELECT * FROM usage_events WHERE owner_sub=? AND idempotency_key=?").bind(input.ownerSub, input.idempotencyKey).first();
}

export async function openContainerSession(db: D1Database, input: {ownerSub:string;projectId?:string|null;taskId?:string|null;sandboxId:string;instanceType:string;wakeReason:string}) {
  const timestamp = now(); const sessionId = id("ctr");
  await db.prepare(`INSERT INTO container_sessions
    (id, owner_sub, project_id, task_id, sandbox_id, instance_type, state, wake_reason, started_at, last_active_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .bind(sessionId, input.ownerSub, input.projectId ?? null, input.taskId ?? null, input.sandboxId, input.instanceType, input.wakeReason.slice(0, 300), timestamp, timestamp, timestamp).run();
  return sessionId;
}

export async function closeContainerSession(db: D1Database, input: {sessionId:string;activeMilliseconds:number;state?:"sleeping"|"stopped"|"failed"}) {
  const timestamp = now(); const state = input.state ?? "sleeping";
  await db.prepare(`UPDATE container_sessions SET state=?, last_active_at=?, slept_at=CASE WHEN ?='sleeping' THEN ? ELSE slept_at END,
    stopped_at=CASE WHEN ? IN ('stopped','failed') THEN ? ELSE stopped_at END, active_milliseconds=?, updated_at=? WHERE id=? AND state IN ('starting','active')`)
    .bind(state, timestamp, state, timestamp, state, timestamp, Math.max(0, Math.floor(input.activeMilliseconds)), timestamp, input.sessionId).run();
}

function periodStart(period: "task"|"day"|"month", at = new Date()) {
  if (period === "task") return "task";
  if (period === "day") return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

export async function evaluateBudgets(db: D1Database, input: {ownerSub:string;projectId?:string|null;taskId?:string|null;additionalMicros?:number;at?:Date}) {
  const rows = await db.prepare("SELECT * FROM budgets WHERE owner_sub=? AND enabled=1 AND (project_id IS NULL OR project_id=?) ORDER BY project_id DESC, period")
    .bind(input.ownerSub, input.projectId ?? null).all<{id:string;project_id:string|null;period:"task"|"day"|"month";limit_micros:number;warning_percent:number;enforcement:BudgetEnforcement}>();
  const at = input.at ?? new Date(); const decisions = [];
  for (const budget of rows.results) {
    const start = periodStart(budget.period, at);
    const query = budget.period === "task"
      ? db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS spent FROM usage_events WHERE owner_sub=? AND task_id=?").bind(input.ownerSub, input.taskId ?? "")
      : db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS spent FROM usage_events WHERE owner_sub=? AND occurred_at>=? AND (project_id=? OR ? IS NULL)").bind(input.ownerSub, start, budget.project_id, budget.project_id);
    const spent = (await query.first<{spent:number}>())?.spent ?? 0;
    const projected = spent + Math.max(0, input.additionalMicros ?? 0);
    const percent = budget.limit_micros ? Math.round((projected / budget.limit_micros) * 100) : 0;
    decisions.push({ budgetId:budget.id, period:budget.period, spentMicros:spent, projectedMicros:projected, limitMicros:budget.limit_micros, percent, warning:percent >= budget.warning_percent, blocked:projected >= budget.limit_micros && budget.enforcement !== "warn", enforcement:budget.enforcement, periodStart:start });
  }
  return decisions;
}

export async function assertBudgetAllowsTask(db: D1Database, input: {ownerSub:string;projectId:string;taskId?:string}) {
  const decisions = await evaluateBudgets(db, input);
  const blocked = decisions.filter((decision) => decision.blocked && (decision.enforcement === "block_new" || decision.enforcement === "stop_active"));
  if (blocked.length) throw new UsageValidationError(`Budget limit reached for ${blocked.map((decision) => decision.period).join(", ")}`);
  return decisions;
}

export async function upsertBudget(db: D1Database, input: {ownerSub:string;projectId?:string|null;period:"task"|"day"|"month";limitMicros:number;warningPercent?:number;enforcement?:BudgetEnforcement;enabled?:boolean}) {
  if (!Number.isInteger(input.limitMicros) || input.limitMicros <= 0) throw new UsageValidationError("Budget limit must be a positive integer in micros");
  const warning = input.warningPercent ?? 80;
  if (!Number.isInteger(warning) || warning < 1 || warning > 100) throw new UsageValidationError("Budget warning percent is invalid");
  const scopeKey = input.projectId ?? "*"; const timestamp = now(); const budgetId = id("bdg");
  await db.prepare(`INSERT INTO budgets (id, owner_sub, project_id, scope_key, period, limit_micros, warning_percent, enforcement, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_sub, scope_key, period) DO UPDATE SET limit_micros=excluded.limit_micros, warning_percent=excluded.warning_percent, enforcement=excluded.enforcement, enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .bind(budgetId, input.ownerSub, input.projectId ?? null, scopeKey, input.period, input.limitMicros, warning, input.enforcement ?? "warn", input.enabled === false ? 0 : 1, timestamp, timestamp).run();
  return db.prepare("SELECT * FROM budgets WHERE owner_sub=? AND scope_key=? AND period=?").bind(input.ownerSub, scopeKey, input.period).first();
}

export async function usageSummary(db: D1Database, ownerSub: string, input: {projectId?:string;taskId?:string;since?:string} = {}) {
  const clauses = ["owner_sub=?"]; const values: unknown[] = [ownerSub];
  if (input.projectId) { clauses.push("project_id=?"); values.push(input.projectId); }
  if (input.taskId) { clauses.push("task_id=?"); values.push(input.taskId); }
  if (input.since) { clauses.push("occurred_at>=?"); values.push(input.since); }
  const totals = await db.prepare(`SELECT category, meter, unit, SUM(quantity) AS quantity, SUM(cost_micros) AS cost_micros, COUNT(*) AS events FROM usage_events WHERE ${clauses.join(" AND ")} GROUP BY category, meter, unit ORDER BY category, meter`).bind(...values).all();
  const total = await db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS cost_micros FROM usage_events WHERE ${clauses.join(" AND ")}`).bind(...values).first<{cost_micros:number}>();
  const sessions = input.taskId ? (await db.prepare("SELECT * FROM container_sessions WHERE owner_sub=? AND task_id=? ORDER BY started_at DESC LIMIT 100").bind(ownerSub, input.taskId).all()).results : [];
  const budgets = await evaluateBudgets(db, { ownerSub, projectId:input.projectId, taskId:input.taskId });
  return { totalCostMicros:total?.cost_micros ?? 0, meters:totals.results, containerSessions:sessions, budgets };
}
