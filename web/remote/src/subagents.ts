function now() { return new Date().toISOString(); }
function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

export const subagentStates = ["queued", "running", "blocked", "completed", "failed", "cancelled"] as const;
export const prBabysitModes = ["off", "monitor", "repair"] as const;
export const prBabysitStatuses = ["idle", "watching", "waiting", "repairing", "passing", "failed", "cancelled"] as const;

export type SubagentState = typeof subagentStates[number];
export type PrBabysitMode = typeof prBabysitModes[number];
export type PrBabysitStatus = typeof prBabysitStatuses[number];
export type CollectionMode = "merge" | "collect";

export type SubagentRunRow = {
  id: string;
  project_id: string;
  owner_sub: string;
  parent_task_id: string;
  child_task_id: string;
  branch_name: string;
  runtime_identity: string;
  workflow_identity: string;
  state: SubagentState;
  title: string;
  prompt: string;
  model: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SubagentEvidence = {
  kind: "artifact" | "diff" | "log" | "review" | "test" | "url";
  ref: string;
  digest?: string;
  label?: string;
};

export type SubagentHandoff = {
  id: string;
  subagentId: string;
  parentTaskId: string;
  projectId: string;
  ownerSub: string;
  baseSha: string;
  commitSha: string;
  changedPaths: string[];
  result: Record<string, unknown>;
  evidence: SubagentEvidence[];
  createdAt: string;
};

type SubagentHandoffRow = {
  id: string;
  subagent_id: string;
  parent_task_id: string;
  project_id: string;
  owner_sub: string;
  base_sha: string;
  commit_sha: string;
  changed_paths_json: string;
  result_json: string;
  evidence_json: string;
  created_at: string;
};

export type PrBabysitInput = {
  repositoryFullName: string;
  prNumber: number;
  mode: PrBabysitMode;
  status: PrBabysitStatus;
  lastHeadSha?: string | null;
  lastCheckAt?: string | null;
  nextCheckAt?: string | null;
  repairAttempts?: number;
  maxRepairAttempts?: number;
  lastError?: string | null;
};

export class SubagentValidationError extends Error {
  constructor(message: string) { super(message); this.name = "SubagentValidationError"; }
}

export class SubagentConflictError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.name = "SubagentConflictError";
    this.reasons = reasons;
  }
}

function fail(message: string): never { throw new SubagentValidationError(message); }

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) fail(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value.trim();
}

function identifier(value: unknown, label: string) {
  const normalized = boundedText(value, label, 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

export function assertSubagentGitSha(value: unknown, label = "Commit SHA") {
  if (typeof value !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)) fail(`${label} must be a full Git SHA`);
  return value.toLowerCase();
}

function changedPath(value: unknown) {
  const path = boundedText(value, "Changed path", 1024).replace(/^\.\//, "");
  if (path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) fail(`Invalid repository-relative changed path: ${path}`);
  return path;
}

function timestamp(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  return Number(value);
}

function jsonObject(value: unknown, label: string, maximumBytes: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail(`${label} must be JSON serializable`); }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > maximumBytes) fail(`${label} is too large`);
  return JSON.parse(encoded) as Record<string, unknown>;
}

export function validateSubagentSpawnInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Subagent input must be an object");
  const value = input as Record<string, unknown>;
  const dependsOn = value.dependsOnSubagentIds ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.length > 32) fail("dependsOnSubagentIds must contain at most 32 identifiers");
  const normalizedDependencies = dependsOn.map((entry) => identifier(entry, "Dependency subagent ID"));
  if (new Set(normalizedDependencies).size !== normalizedDependencies.length) fail("Dependency subagent IDs must be unique");
  return {
    title: boundedText(value.title, "Title", 240),
    prompt: boundedText(value.prompt, "Prompt", 64_000),
    model: boundedText(value.model ?? "grok-4.5", "Model", 160),
    dependsOnSubagentIds: normalizedDependencies,
  };
}

export function validateSubagentHandoffInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Handoff must be an object");
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.changedPaths) || value.changedPaths.length > 2_000) fail("changedPaths must contain at most 2000 paths");
  const paths = value.changedPaths.map(changedPath).sort();
  if (new Set(paths).size !== paths.length) fail("changedPaths must be unique");
  if (!Array.isArray(value.evidence) || value.evidence.length > 200) fail("evidence must contain at most 200 entries");
  const evidence = value.evidence.map((candidate, index): SubagentEvidence => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail(`evidence[${index}] must be an object`);
    const item = candidate as Record<string, unknown>;
    const kind = item.kind;
    if (!(kind === "artifact" || kind === "diff" || kind === "log" || kind === "review" || kind === "test" || kind === "url")) fail(`evidence[${index}].kind is invalid`);
    const digest = item.digest === undefined ? undefined : assertSubagentGitSha(item.digest, `evidence[${index}].digest`);
    const label = item.label === undefined ? undefined : boundedText(item.label, `evidence[${index}].label`, 240);
    return { kind, ref: boundedText(item.ref, `evidence[${index}].ref`, 2_000), ...(digest ? { digest } : {}), ...(label ? { label } : {}) };
  });
  const baseSha = assertSubagentGitSha(value.baseSha, "Base SHA");
  const commitSha = assertSubagentGitSha(value.commitSha, "Commit SHA");
  if (baseSha === commitSha) fail("Commit SHA must differ from the base SHA");
  return { baseSha, commitSha, changedPaths: paths, result: jsonObject(value.result, "Result", 128_000), evidence };
}

const transitions: Record<SubagentState, readonly SubagentState[]> = {
  queued: ["running", "cancelled"],
  running: ["blocked", "failed", "cancelled"],
  blocked: ["queued", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionSubagent(from: SubagentState, to: SubagentState) {
  return transitions[from].includes(to);
}

export function evaluateHandoffCollection(input: {
  mode: CollectionMode;
  expectedParentHeadSha: string;
  currentParentHeadSha: string | null;
  handoffs: readonly Pick<SubagentHandoff, "id" | "baseSha" | "commitSha" | "changedPaths">[];
}) {
  if (input.mode !== "merge" && input.mode !== "collect") fail("Collection mode is invalid");
  const expected = assertSubagentGitSha(input.expectedParentHeadSha, "Expected parent head SHA");
  const reasons: string[] = [];
  if (!input.currentParentHeadSha || assertSubagentGitSha(input.currentParentHeadSha, "Current parent head SHA") !== expected) reasons.push("Parent head changed after the collection decision was prepared");
  if (!input.handoffs.length) reasons.push("At least one completed handoff is required");
  const ids = new Set<string>();
  const commits = new Set<string>();
  const owners = new Map<string, string>();
  for (const handoff of input.handoffs) {
    if (ids.has(handoff.id)) reasons.push(`Handoff ${handoff.id} was selected more than once`);
    ids.add(handoff.id);
    if (assertSubagentGitSha(handoff.baseSha, "Handoff base SHA") !== expected) reasons.push(`Handoff ${handoff.id} is stale for the expected parent head`);
    const commit = assertSubagentGitSha(handoff.commitSha, "Handoff commit SHA");
    if (commits.has(commit)) reasons.push(`Commit ${commit} was supplied by more than one handoff`);
    commits.add(commit);
    for (const rawPath of handoff.changedPaths) {
      const path = changedPath(rawPath);
      const prior = owners.get(path);
      if (prior && prior !== handoff.id) reasons.push(`Overlapping change to ${path} in handoffs ${prior} and ${handoff.id}`);
      else owners.set(path, handoff.id);
    }
  }
  return { allowed: reasons.length === 0, reasons, expectedParentHeadSha: expected, changedPaths: [...owners.keys()].sort() };
}

async function ownedParent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string) {
  const row = await db.prepare("SELECT t.id, t.status, t.head_sha, t.task_repo FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.project_id=? AND t.owner_sub=? AND p.owner_sub=?")
    .bind(parentTaskId, projectId, ownerSub, ownerSub).first<{id:string;status:string;head_sha:string|null;task_repo:string|null}>();
  if (!row) throw new Error("Parent task not found");
  return row;
}

async function ownedRun(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string) {
  await ownedParent(db, ownerSub, projectId, parentTaskId);
  const row = await db.prepare("SELECT * FROM subagent_runs WHERE id=? AND parent_task_id=? AND project_id=? AND owner_sub=?")
    .bind(subagentId, parentTaskId, projectId, ownerSub).first<SubagentRunRow>();
  if (!row) throw new Error("Subagent not found");
  return row;
}

function handoffFromRow(row: SubagentHandoffRow): SubagentHandoff {
  return {
    id: row.id, subagentId: row.subagent_id, parentTaskId: row.parent_task_id, projectId: row.project_id, ownerSub: row.owner_sub,
    baseSha: row.base_sha, commitSha: row.commit_sha, changedPaths: JSON.parse(row.changed_paths_json), result: JSON.parse(row.result_json),
    evidence: JSON.parse(row.evidence_json), createdAt: row.created_at,
  };
}

export async function configureSubagentGroup(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, concurrencyLimit: number) {
  await ownedParent(db, ownerSub, projectId, parentTaskId);
  const limit = integer(concurrencyLimit, "Concurrency limit", 1, 32);
  const time = now();
  await db.prepare("INSERT INTO subagent_groups (parent_task_id, project_id, owner_sub, concurrency_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(parent_task_id) DO UPDATE SET concurrency_limit=excluded.concurrency_limit, updated_at=excluded.updated_at WHERE project_id=excluded.project_id AND owner_sub=excluded.owner_sub")
    .bind(parentTaskId, projectId, ownerSub, limit, time, time).run();
  return { parentTaskId, projectId, concurrencyLimit: limit };
}

export async function spawnSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, rawInput: unknown) {
  const parent = await ownedParent(db, ownerSub, projectId, parentTaskId);
  if (["completed", "failed", "cancelled"].includes(parent.status)) throw new Error("Cannot spawn a subagent from a terminal parent task");
  if (!parent.head_sha || !parent.task_repo || parent.status !== "review") throw new Error("Subagents require a parent result that is ready for review");
  const input = validateSubagentSpawnInput(rawInput);
  await db.prepare("INSERT OR IGNORE INTO subagent_groups (parent_task_id, project_id, owner_sub, concurrency_limit, created_at, updated_at) VALUES (?, ?, ?, 4, ?, ?)")
    .bind(parentTaskId, projectId, ownerSub, now(), now()).run();
  if (input.dependsOnSubagentIds.length) {
    const placeholders = input.dependsOnSubagentIds.map(() => "?").join(",");
    const result = await db.prepare(`SELECT id FROM subagent_runs WHERE parent_task_id=? AND project_id=? AND owner_sub=? AND id IN (${placeholders})`)
      .bind(parentTaskId, projectId, ownerSub, ...input.dependsOnSubagentIds).all<{id:string}>();
    if (result.results.length !== input.dependsOnSubagentIds.length) throw new Error("Every dependency must be an authorized sibling subagent");
  }
  const subagentId = id("sub");
  const childTaskId = id("task");
  const workflowIdentity = id("subwf");
  const runtimeIdentity = `subagent:${subagentId}`;
  const branchName = `codex/subagents/${parentTaskId.slice(-12)}/${subagentId.slice(-12)}`;
  const time = now();
  await db.batch([
    db.prepare("INSERT INTO tasks (id, owner_sub, project_id, workflow_id, title, prompt, status, model, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 'isolated-write', ?, ?)")
      .bind(childTaskId, ownerSub, projectId, workflowIdentity, input.title, input.prompt, input.model, time, time),
    db.prepare("INSERT INTO subagent_runs (id, project_id, owner_sub, parent_task_id, child_task_id, branch_name, runtime_identity, workflow_identity, state, title, prompt, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
      .bind(subagentId, projectId, ownerSub, parentTaskId, childTaskId, branchName, runtimeIdentity, workflowIdentity, input.title, input.prompt, input.model, time, time),
    ...input.dependsOnSubagentIds.map((dependencyId) => db.prepare("INSERT INTO subagent_dependencies (subagent_id, depends_on_subagent_id, parent_task_id, created_at) VALUES (?, ?, ?, ?)").bind(subagentId, dependencyId, parentTaskId, time)),
  ]);
  return ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
}

export async function listSubagents(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string) {
  await ownedParent(db, ownerSub, projectId, parentTaskId);
  return (await db.prepare("SELECT * FROM subagent_runs WHERE parent_task_id=? AND project_id=? AND owner_sub=? ORDER BY created_at, id")
    .bind(parentTaskId, projectId, ownerSub).all<SubagentRunRow>()).results;
}

export async function inspectSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string) {
  const run = await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  const [dependencies, steers, handoff, babysit] = await Promise.all([
    db.prepare("SELECT d.depends_on_subagent_id AS id, r.state FROM subagent_dependencies d JOIN subagent_runs r ON r.id=d.depends_on_subagent_id WHERE d.subagent_id=? AND d.parent_task_id=? AND r.project_id=? AND r.owner_sub=? ORDER BY r.created_at")
      .bind(subagentId, parentTaskId, projectId, ownerSub).all<{id:string;state:SubagentState}>(),
    db.prepare("SELECT id, instruction, created_at FROM subagent_steers WHERE subagent_id=? AND parent_task_id=? AND owner_sub=? ORDER BY created_at, id")
      .bind(subagentId, parentTaskId, ownerSub).all<{id:string;instruction:string;created_at:string}>(),
    db.prepare("SELECT * FROM subagent_handoffs WHERE subagent_id=? AND parent_task_id=? AND project_id=? AND owner_sub=?")
      .bind(subagentId, parentTaskId, projectId, ownerSub).first<SubagentHandoffRow>(),
    db.prepare("SELECT * FROM subagent_pr_babysit WHERE subagent_id=? AND parent_task_id=? AND project_id=? AND owner_sub=?")
      .bind(subagentId, parentTaskId, projectId, ownerSub).first(),
  ]);
  return { run, dependencies: dependencies.results, steers: steers.results, handoff: handoff ? handoffFromRow(handoff) : null, prBabysit: babysit ?? null };
}

async function activateSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, from: "queued" | "blocked") {
  const run = await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  if (run.state !== from) throw new Error(`Only ${from} subagents can ${from === "queued" ? "start" : "resume"}; current state is ${run.state}`);
  const time = now();
  const activation = db.prepare(`UPDATE subagent_runs SET state='running', started_at=COALESCE(started_at, ?), error=NULL, updated_at=?
    WHERE id=? AND parent_task_id=? AND project_id=? AND owner_sub=? AND state=?
      AND EXISTS (SELECT 1 FROM tasks child WHERE child.id=subagent_runs.child_task_id AND child.project_id=? AND child.owner_sub=? AND child.status=?)
      AND NOT EXISTS (SELECT 1 FROM subagent_dependencies d JOIN subagent_runs dependency ON dependency.id=d.depends_on_subagent_id WHERE d.subagent_id=subagent_runs.id AND dependency.state<>'completed')
      AND (SELECT COUNT(*) FROM subagent_runs active WHERE active.parent_task_id=subagent_runs.parent_task_id AND active.state='running') < (SELECT concurrency_limit FROM subagent_groups g WHERE g.parent_task_id=subagent_runs.parent_task_id AND g.project_id=? AND g.owner_sub=?)`)
    .bind(time, time, subagentId, parentTaskId, projectId, ownerSub, from, projectId, ownerSub, from === "queued" ? "queued" : "running", projectId, ownerSub);
  if (from === "queued") {
    const [result, task] = await db.batch([
      activation,
      db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=? AND project_id=? AND owner_sub=? AND status='queued' AND EXISTS (SELECT 1 FROM subagent_runs r WHERE r.id=? AND r.state='running' AND r.parent_task_id=? AND r.project_id=? AND r.owner_sub=?)")
        .bind(time, run.child_task_id, projectId, ownerSub, subagentId, parentTaskId, projectId, ownerSub),
    ]);
    if (!result.meta.changes || !task.meta.changes) throw new Error("Subagent is dependency-blocked, the concurrency limit is reached, or the child task is not queued");
  } else {
    const result = await activation.run();
    if (!result.meta.changes) throw new Error("Subagent is dependency-blocked or the parent concurrency limit is reached");
  }
  return ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
}

export async function startSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string) {
  return activateSubagent(db, ownerSub, projectId, parentTaskId, subagentId, "queued");
}

export async function startReadySubagents(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string) {
  const queued = await db.prepare("SELECT id FROM subagent_runs WHERE parent_task_id=? AND project_id=? AND owner_sub=? AND state='queued' ORDER BY created_at, id LIMIT 100")
    .bind(parentTaskId, projectId, ownerSub).all<{id:string}>();
  const started: SubagentRunRow[] = [];
  for (const candidate of queued.results) {
    try { started.push(await startSubagent(db, ownerSub, projectId, parentTaskId, candidate.id)); }
    catch (error) {
      if (!(error instanceof Error) || !/dependency-blocked|concurrency limit/.test(error.message)) throw error;
    }
  }
  return started;
}

async function transitionActiveSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, target: Exclude<SubagentState, "completed">, error?: string | null) {
  const run = await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  if (!canTransitionSubagent(run.state, target)) throw new Error(`Invalid subagent transition from ${run.state} to ${target}`);
  const message = error == null ? null : boundedText(error, "Error", 12_000);
  const time = now();
  const terminal = target === "failed" || target === "cancelled";
  await db.batch([
    db.prepare("UPDATE subagent_runs SET state=?, error=?, completed_at=CASE WHEN ? THEN ? ELSE completed_at END, updated_at=? WHERE id=? AND parent_task_id=? AND project_id=? AND owner_sub=? AND state=?")
      .bind(target, message, terminal ? 1 : 0, time, time, subagentId, parentTaskId, projectId, ownerSub, run.state),
    ...(terminal ? [db.prepare("UPDATE tasks SET status=?, error=?, completed_at=?, updated_at=? WHERE id=? AND project_id=? AND owner_sub=?")
      .bind(target, message, time, time, run.child_task_id, projectId, ownerSub)] : []),
  ]);
  return ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
}

export async function blockSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, reason: string) {
  return transitionActiveSubagent(db, ownerSub, projectId, parentTaskId, subagentId, "blocked", reason);
}

export async function resumeSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string) {
  return activateSubagent(db, ownerSub, projectId, parentTaskId, subagentId, "blocked");
}

export async function failSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, error: string) {
  return transitionActiveSubagent(db, ownerSub, projectId, parentTaskId, subagentId, "failed", error);
}

export async function cancelSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, reason = "Cancelled by parent") {
  return transitionActiveSubagent(db, ownerSub, projectId, parentTaskId, subagentId, "cancelled", reason);
}

export async function steerSubagent(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, instruction: string) {
  const run = await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  if (!["queued", "running", "blocked"].includes(run.state)) throw new Error("Terminal subagents cannot be steered");
  const steerId = id("steer"); const time = now();
  await db.prepare("INSERT INTO subagent_steers (id, subagent_id, parent_task_id, owner_sub, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(steerId, subagentId, parentTaskId, ownerSub, boundedText(instruction, "Steering instruction", 32_000), time).run();
  return { id: steerId, subagentId, instruction: instruction.trim(), createdAt: time };
}

export async function claimPendingSubagentSteers(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string) {
  await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  const pending = await db.prepare("SELECT id, instruction, created_at FROM subagent_steers WHERE subagent_id=? AND parent_task_id=? AND owner_sub=? AND consumed_at IS NULL AND claim_token IS NULL ORDER BY created_at, id")
    .bind(subagentId, parentTaskId, ownerSub).all<{id:string;instruction:string;created_at:string}>();
  if (!pending.results.length) return [];
  const claimToken = id("steer_claim"); const claimedAt = now();
  const placeholders = pending.results.map(() => "?").join(",");
  const result = await db.prepare(`UPDATE subagent_steers SET claim_token=?, claimed_at=? WHERE subagent_id=? AND parent_task_id=? AND owner_sub=? AND consumed_at IS NULL AND claim_token IS NULL AND id IN (${placeholders})`)
    .bind(claimToken, claimedAt, subagentId, parentTaskId, ownerSub, ...pending.results.map((item) => item.id)).run();
  if (result.meta.changes !== pending.results.length) throw new Error("Subagent steering changed while it was being claimed");
  return pending.results.map((item) => ({ ...item, claimToken, claimedAt }));
}

export async function acknowledgeSubagentSteers(db: D1Database, ownerSub: string, parentTaskId: string, subagentId: string, claimToken: string) {
  const consumedAt = now();
  const result = await db.prepare("UPDATE subagent_steers SET consumed_at=?, claim_token=NULL, claimed_at=NULL WHERE subagent_id=? AND parent_task_id=? AND owner_sub=? AND claim_token=? AND consumed_at IS NULL")
    .bind(consumedAt, subagentId, parentTaskId, ownerSub, claimToken).run();
  if (!result.meta.changes) throw new Error("Subagent steering claim is no longer active");
  return result.meta.changes;
}

export async function releaseSubagentSteers(db: D1Database, ownerSub: string, parentTaskId: string, subagentId: string, claimToken: string) {
  await db.prepare("UPDATE subagent_steers SET claim_token=NULL, claimed_at=NULL WHERE subagent_id=? AND parent_task_id=? AND owner_sub=? AND claim_token=? AND consumed_at IS NULL")
    .bind(subagentId, parentTaskId, ownerSub, claimToken).run();
}

export async function completeSubagentWithHandoff(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, rawInput: unknown) {
  const run = await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  if (run.state !== "running") throw new Error("Only a running subagent can complete a handoff");
  const input = validateSubagentHandoffInput(rawInput);
  const handoffId = id("handoff"); const time = now();
  const results = await db.batch([
    db.prepare(`INSERT INTO subagent_handoffs (id, subagent_id, parent_task_id, project_id, owner_sub, base_sha, commit_sha, changed_paths_json, result_json, evidence_json, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM subagent_runs r JOIN tasks t ON t.id=r.child_task_id WHERE r.id=? AND r.parent_task_id=? AND r.project_id=? AND r.owner_sub=? AND r.state='running' AND t.status='review' AND t.project_id=? AND t.owner_sub=?)`)
      .bind(handoffId, subagentId, parentTaskId, projectId, ownerSub, input.baseSha, input.commitSha, JSON.stringify(input.changedPaths), JSON.stringify(input.result), JSON.stringify(input.evidence), time, subagentId, parentTaskId, projectId, ownerSub, projectId, ownerSub),
    db.prepare("UPDATE subagent_runs SET state='completed', error=NULL, completed_at=?, updated_at=? WHERE id=? AND parent_task_id=? AND project_id=? AND owner_sub=? AND state='running'")
      .bind(time, time, subagentId, parentTaskId, projectId, ownerSub),
    db.prepare("UPDATE tasks SET status='completed', base_sha=?, head_sha=?, error=NULL, completed_at=?, updated_at=? WHERE id=? AND project_id=? AND owner_sub=? AND status='review'")
      .bind(input.baseSha, input.commitSha, time, time, run.child_task_id, projectId, ownerSub),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes || !results[2].meta.changes) throw new Error("Subagent or child task changed before the handoff could complete");
  const row = await db.prepare("SELECT * FROM subagent_handoffs WHERE id=? AND subagent_id=? AND parent_task_id=? AND project_id=? AND owner_sub=?")
    .bind(handoffId, subagentId, parentTaskId, projectId, ownerSub).first<SubagentHandoffRow>();
  if (!row) throw new Error("Handoff was not persisted");
  return handoffFromRow(row);
}

async function decisionDigest(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recordSubagentCollectionDecision(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, input: {mode:CollectionMode;expectedParentHeadSha:string;handoffIds:string[];decidedBySub:string}) {
  const parent = await ownedParent(db, ownerSub, projectId, parentTaskId);
  if (!Array.isArray(input.handoffIds) || !input.handoffIds.length || input.handoffIds.length > 32) fail("handoffIds must contain 1 to 32 identifiers");
  const handoffIds = input.handoffIds.map((value) => identifier(value, "Handoff ID"));
  if (new Set(handoffIds).size !== handoffIds.length) fail("handoffIds must be unique");
  const placeholders = handoffIds.map(() => "?").join(",");
  const result = await db.prepare(`SELECT h.* FROM subagent_handoffs h JOIN subagent_runs r ON r.id=h.subagent_id WHERE h.id IN (${placeholders}) AND h.parent_task_id=? AND h.project_id=? AND h.owner_sub=? AND r.state='completed'`)
    .bind(...handoffIds, parentTaskId, projectId, ownerSub).all<SubagentHandoffRow>();
  if (result.results.length !== handoffIds.length) throw new SubagentConflictError(["Every selected handoff must be completed and authorized for this parent"]);
  const handoffs = result.results.map(handoffFromRow);
  const evaluation = evaluateHandoffCollection({ mode: input.mode, expectedParentHeadSha: input.expectedParentHeadSha, currentParentHeadSha: parent.head_sha, handoffs });
  if (!evaluation.allowed) throw new SubagentConflictError(evaluation.reasons);
  const orderedIds = [...handoffIds].sort();
  const digest = await decisionDigest(JSON.stringify({ mode: input.mode, expectedParentHeadSha: evaluation.expectedParentHeadSha, handoffIds: orderedIds }));
  const decisionId = id("collect"); const time = now();
  await db.prepare("INSERT INTO subagent_collection_decisions (id, parent_task_id, project_id, owner_sub, mode, expected_parent_head_sha, handoff_ids_json, decision_digest, decided_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(decisionId, parentTaskId, projectId, ownerSub, input.mode, evaluation.expectedParentHeadSha, JSON.stringify(orderedIds), digest, boundedText(input.decidedBySub, "Deciding identity", 240), time).run();
  return { id: decisionId, mode: input.mode, expectedParentHeadSha: evaluation.expectedParentHeadSha, handoffIds: orderedIds, decisionDigest: digest, decidedBySub: input.decidedBySub.trim(), createdAt: time };
}

export async function getSubagentCollectionDecision(db: D1Database, ownerSub: string, parentTaskId: string, decisionId: string) {
  const decision = await db.prepare("SELECT * FROM subagent_collection_decisions WHERE id=? AND parent_task_id=? AND owner_sub=?")
    .bind(identifier(decisionId, "Collection decision ID"), parentTaskId, ownerSub).first<{id:string;parent_task_id:string;project_id:string;owner_sub:string;mode:CollectionMode;expected_parent_head_sha:string;handoff_ids_json:string;decision_digest:string;decided_by_sub:string;created_at:string}>();
  if (!decision) throw new Error("Collection decision not found");
  const handoffIds = JSON.parse(decision.handoff_ids_json) as string[];
  const placeholders = handoffIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT h.*, r.child_task_id FROM subagent_handoffs h JOIN subagent_runs r ON r.id=h.subagent_id WHERE h.id IN (${placeholders}) AND h.parent_task_id=? AND h.owner_sub=?`)
    .bind(...handoffIds, parentTaskId, ownerSub).all<SubagentHandoffRow & {child_task_id:string}>();
  if (rows.results.length !== handoffIds.length) throw new Error("Collection handoffs changed after the immutable decision");
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  return {
    id: decision.id, mode: decision.mode, expectedParentHeadSha: decision.expected_parent_head_sha, decisionDigest: decision.decision_digest,
    handoffs: handoffIds.map((handoffId) => { const row = byId.get(handoffId)!; return { ...handoffFromRow(row), childTaskId: row.child_task_id }; }),
  };
}

export async function startSubagentCollectionApplication(db: D1Database, ownerSub: string, parentTaskId: string, decisionId: string) {
  const decision = await getSubagentCollectionDecision(db, ownerSub, parentTaskId, decisionId);
  const status = decision.mode === "collect" ? "recorded" : "applying";
  const timestamp = now();
  const statements = [db.prepare("INSERT INTO subagent_collection_applications (decision_id, parent_task_id, owner_sub, prior_head_sha, status, started_at, completed_at) SELECT ?, id, owner_sub, ?, ?, ?, ? FROM tasks WHERE id=? AND owner_sub=? AND head_sha=? AND status='review'")
    .bind(decision.id, decision.expectedParentHeadSha, status, timestamp, status === "recorded" ? timestamp : null, parentTaskId, ownerSub, decision.expectedParentHeadSha)];
  if (decision.mode === "merge") statements.push(db.prepare("UPDATE tasks SET status='repairing', updated_at=? WHERE id=? AND owner_sub=? AND head_sha=? AND status='review'").bind(timestamp, parentTaskId, ownerSub, decision.expectedParentHeadSha));
  const results = await db.batch(statements);
  if (!results[0].meta.changes || (decision.mode === "merge" && !results[1].meta.changes)) throw new Error("Parent head changed or this collection decision was already applied");
  return decision;
}

export async function finishSubagentCollectionApplication(db: D1Database, ownerSub: string, parentTaskId: string, decisionId: string, input: {resultingHeadSha?:string;error?:string}) {
  const timestamp = now();
  const status = input.error ? "failed" : "applied";
  const resultingHeadSha = input.resultingHeadSha ? assertSubagentGitSha(input.resultingHeadSha, "Resulting parent head SHA") : null;
  const error = input.error ? boundedText(input.error, "Collection error", 12_000) : null;
  const result = await db.prepare("UPDATE subagent_collection_applications SET status=?, resulting_head_sha=?, error=?, completed_at=? WHERE decision_id=? AND parent_task_id=? AND owner_sub=? AND status='applying'")
    .bind(status, resultingHeadSha, error, timestamp, decisionId, parentTaskId, ownerSub).run();
  if (!result.meta.changes) throw new Error("Collection application is not active");
  if (status === "failed") await db.prepare("UPDATE tasks SET status='review', error=?, updated_at=? WHERE id=? AND owner_sub=? AND status='repairing'").bind(error, timestamp, parentTaskId, ownerSub).run();
  return { decisionId, status, resultingHeadSha, error, completedAt: timestamp };
}

export function validatePrBabysitInput(input: PrBabysitInput) {
  const repositoryFullName = boundedText(input.repositoryFullName, "Repository", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) fail("Repository must be an owner/name pair");
  if (!prBabysitModes.includes(input.mode)) fail("PR babysit mode is invalid");
  if (!prBabysitStatuses.includes(input.status)) fail("PR babysit status is invalid");
  const repairAttempts = integer(input.repairAttempts ?? 0, "Repair attempts", 0, 1_000_000);
  const maxRepairAttempts = integer(input.maxRepairAttempts ?? 3, "Maximum repair attempts", 0, 20);
  if (repairAttempts > maxRepairAttempts) fail("Repair attempts cannot exceed the configured maximum");
  if (input.mode === "off" && !["idle", "cancelled"].includes(input.status)) fail("Disabled PR babysitting must be idle or cancelled");
  if (input.mode !== "repair" && input.status === "repairing") fail("Only repair mode can have repairing status");
  return {
    repositoryFullName, prNumber: integer(input.prNumber, "PR number", 1, 2_147_483_647), mode: input.mode, status: input.status,
    lastHeadSha: input.lastHeadSha == null ? null : assertSubagentGitSha(input.lastHeadSha, "PR head SHA"),
    lastCheckAt: timestamp(input.lastCheckAt, "Last check time"), nextCheckAt: timestamp(input.nextCheckAt, "Next check time"),
    repairAttempts, maxRepairAttempts, lastError: input.lastError == null ? null : boundedText(input.lastError, "PR babysit error", 12_000),
  };
}

export async function upsertSubagentPrBabysit(db: D1Database, ownerSub: string, projectId: string, parentTaskId: string, subagentId: string, rawInput: PrBabysitInput) {
  await ownedRun(db, ownerSub, projectId, parentTaskId, subagentId);
  const input = validatePrBabysitInput(rawInput); const time = now();
  const result = await db.prepare(`INSERT INTO subagent_pr_babysit (subagent_id, parent_task_id, project_id, owner_sub, repository_full_name, pr_number, mode, status, last_head_sha, last_check_at, next_check_at, repair_attempts, max_repair_attempts, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subagent_id) DO UPDATE SET mode=excluded.mode, status=excluded.status, last_head_sha=excluded.last_head_sha, last_check_at=excluded.last_check_at, next_check_at=excluded.next_check_at, repair_attempts=excluded.repair_attempts, max_repair_attempts=excluded.max_repair_attempts, last_error=excluded.last_error, updated_at=excluded.updated_at
    WHERE project_id=excluded.project_id AND owner_sub=excluded.owner_sub AND parent_task_id=excluded.parent_task_id AND repository_full_name=excluded.repository_full_name AND pr_number=excluded.pr_number`)
    .bind(subagentId, parentTaskId, projectId, ownerSub, input.repositoryFullName, input.prNumber, input.mode, input.status, input.lastHeadSha, input.lastCheckAt, input.nextCheckAt, input.repairAttempts, input.maxRepairAttempts, input.lastError, time, time).run();
  if (!result.meta.changes) throw new Error("PR babysit target is immutable after creation");
  return db.prepare("SELECT * FROM subagent_pr_babysit WHERE subagent_id=? AND parent_task_id=? AND project_id=? AND owner_sub=?")
    .bind(subagentId, parentTaskId, projectId, ownerSub).first();
}
