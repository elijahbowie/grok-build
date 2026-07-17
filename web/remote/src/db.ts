import type { Project, Task, TaskStatus } from "./types";

export function now() {
  return new Date().toISOString();
}

export function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function slug(value: string) {
  const clean = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return clean || "project";
}

export async function listProjects(db: D1Database, ownerSub: string) {
  return (await db.prepare(`SELECT DISTINCT p.* FROM projects p WHERE p.owner_sub=?
    OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.member_sub=?)
    OR EXISTS (SELECT 1 FROM organization_memberships om WHERE om.organization_id=p.organization_id AND om.member_sub=? AND om.status='active')
    ORDER BY p.updated_at DESC`).bind(ownerSub, ownerSub, ownerSub).all<Project>()).results;
}

export async function getProject(db: D1Database, ownerSub: string, projectId: string) {
  return db.prepare(`SELECT p.* FROM projects p WHERE p.id=? AND (p.owner_sub=?
    OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.member_sub=?)
    OR EXISTS (SELECT 1 FROM organization_memberships om WHERE om.organization_id=p.organization_id AND om.member_sub=? AND om.status='active'))`)
    .bind(projectId, ownerSub, ownerSub, ownerSub).first<Project>();
}

export async function listTasks(db: D1Database, ownerSub: string, projectId?: string) {
  const access = `(t.owner_sub=? OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=t.project_id AND pm.member_sub=?) OR EXISTS (SELECT 1 FROM projects p JOIN organization_memberships om ON om.organization_id=p.organization_id WHERE p.id=t.project_id AND om.member_sub=? AND om.status='active'))`;
  const query = projectId
    ? db.prepare(`SELECT t.* FROM tasks t WHERE ${access} AND t.project_id=? AND t.archived_at IS NULL ORDER BY t.created_at DESC`).bind(ownerSub, ownerSub, ownerSub, projectId)
    : db.prepare(`SELECT t.* FROM tasks t WHERE ${access} AND t.archived_at IS NULL ORDER BY t.created_at DESC`).bind(ownerSub, ownerSub, ownerSub);
  return (await query.all<Task>()).results;
}

export async function getTask(db: D1Database, ownerSub: string, taskId: string) {
  return db.prepare(`SELECT t.* FROM tasks t WHERE t.id=? AND (t.owner_sub=?
    OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=t.project_id AND pm.member_sub=?)
    OR EXISTS (SELECT 1 FROM projects p JOIN organization_memberships om ON om.organization_id=p.organization_id WHERE p.id=t.project_id AND om.member_sub=? AND om.status='active'))`)
    .bind(taskId, ownerSub, ownerSub, ownerSub).first<Task>();
}

export async function workflowTask(db: D1Database, taskId: string, ownerSub: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ? AND owner_sub = ?").bind(taskId, ownerSub).first<Task>();
}

export async function updateTask(db: D1Database, taskId: string, status: TaskStatus, fields: { taskRepo?: string; sessionId?: string; baseSha?: string; headSha?: string; error?: string | null; repairAttempts?: number } = {}) {
  const timestamp = now();
  await db.prepare(`UPDATE tasks SET status = ?, task_repo = COALESCE(?, task_repo), session_id = COALESCE(?, session_id), base_sha = COALESCE(?, base_sha), head_sha = COALESCE(?, head_sha), error = ?, repair_attempts = COALESCE(?, repair_attempts), updated_at = ?, completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END WHERE id = ?`)
    .bind(status, fields.taskRepo ?? null, fields.sessionId ?? null, fields.baseSha ?? null, fields.headSha ?? null, fields.error ?? null, fields.repairAttempts ?? null, timestamp, status, timestamp, taskId).run();
}

export async function appendEvent(db: D1Database, taskId: string, type: string, data: unknown) {
  const result = await db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?").bind(taskId).first<{seq: number}>();
  const seq = result?.seq ?? 1;
  await db.prepare("INSERT INTO task_events (task_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(taskId, seq, type, JSON.stringify(data), now()).run();
  return { taskId, seq, type, data, createdAt: now() };
}

export async function taskEvents(db: D1Database, taskId: string, after = 0) {
  return (await db.prepare("SELECT seq, type, data_json, created_at FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT 1000").bind(taskId, after).all<{seq:number;type:string;data_json:string;created_at:string}>()).results.map((event) => ({ seq: event.seq, type: event.type, data: JSON.parse(event.data_json), createdAt: event.created_at }));
}
