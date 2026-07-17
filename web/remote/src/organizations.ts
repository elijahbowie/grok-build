import { id, now, slug } from "./db";
import type { Identity } from "./types";

export type OrganizationRole = "owner" | "admin" | "developer" | "reviewer" | "viewer";
export type ProjectRole = "maintainer" | "developer" | "reviewer" | "viewer";

const organizationRoleRank: Record<OrganizationRole, number> = { viewer:1, reviewer:2, developer:3, admin:4, owner:5 };
const projectRoleRank: Record<ProjectRole, number> = { viewer:1, reviewer:2, developer:3, maintainer:4 };

export class OrganizationAccessError extends Error {
  constructor(message: string) { super(message); this.name = "OrganizationAccessError"; }
}
export function organizationRoleAllows(actual: OrganizationRole, required: OrganizationRole) {
  return organizationRoleRank[actual] >= organizationRoleRank[required];
}

export function projectRoleAllows(actual: ProjectRole, required: ProjectRole) {
  return projectRoleRank[actual] >= projectRoleRank[required];
}

async function audit(db: D1Database, input: {organizationId:string;actorSub:string;action:string;targetType:string;targetId:string;detail?:unknown}) {
  await db.prepare("INSERT INTO organization_audit_events (id, organization_id, actor_sub, action, target_type, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id("oaud"), input.organizationId, input.actorSub, input.action, input.targetType, input.targetId, JSON.stringify(input.detail ?? {}), now()).run();
}

export async function createOrganization(db: D1Database, identity: Identity, nameValue: unknown) {
  if (typeof nameValue !== "string" || !nameValue.trim() || nameValue.length > 120) throw new OrganizationAccessError("Organization name is invalid");
  const name = nameValue.trim(); const organizationId = id("org"); const timestamp = now();
  await db.batch([
    db.prepare("INSERT INTO organizations (id, name, slug, created_by_sub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(organizationId, name, `${slug(name)}-${organizationId.slice(-6)}`, identity.sub, timestamp, timestamp),
    db.prepare("INSERT INTO organization_memberships (organization_id, member_sub, email, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?)").bind(organizationId, identity.sub, identity.email, identity.name ?? null, timestamp, timestamp),
  ]);
  await audit(db, { organizationId, actorSub:identity.sub, action:"organization.created", targetType:"organization", targetId:organizationId, detail:{name} });
  return db.prepare("SELECT * FROM organizations WHERE id=?").bind(organizationId).first();
}

export async function claimInvitedMemberships(db: D1Database, identity: Identity) {
  const invitedSub = `email:${identity.email.toLowerCase()}`;
  await db.prepare("UPDATE organization_memberships SET member_sub=?, display_name=COALESCE(?, display_name), status='active', updated_at=? WHERE member_sub=? AND email=? AND status='invited'")
    .bind(identity.sub, identity.name ?? null, now(), invitedSub, identity.email.toLowerCase()).run();
}

export async function listOrganizations(db: D1Database, identity: Identity) {
  return (await db.prepare(`SELECT o.*, m.role, m.status FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id
    WHERE m.member_sub=? AND m.status='active' ORDER BY o.name`).bind(identity.sub).all()).results;
}

export async function requireOrganizationRole(db: D1Database, identity: Identity, organizationId: string, required: OrganizationRole) {
  const membership = await db.prepare("SELECT role, status FROM organization_memberships WHERE organization_id=? AND member_sub=?").bind(organizationId, identity.sub).first<{role:OrganizationRole;status:string}>();
  if (!membership || membership.status !== "active" || !organizationRoleAllows(membership.role, required)) throw new OrganizationAccessError(`Organization ${required} role is required`);
  return membership.role;
}

export async function upsertOrganizationMember(db: D1Database, identity: Identity, input: {organizationId:string;email:string;role:OrganizationRole}) {
  await requireOrganizationRole(db, identity, input.organizationId, "admin");
  const email = input.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || !Object.hasOwn(organizationRoleRank, input.role) || input.role === "owner") throw new OrganizationAccessError("Member email or role is invalid");
  const timestamp = now(); const memberSub = `email:${email}`;
  await db.prepare(`INSERT INTO organization_memberships (organization_id, member_sub, email, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'invited', ?, ?) ON CONFLICT(organization_id, member_sub) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at`)
    .bind(input.organizationId, memberSub, email, input.role, timestamp, timestamp).run();
  await audit(db, { organizationId:input.organizationId, actorSub:identity.sub, action:"member.invited", targetType:"member", targetId:email, detail:{role:input.role} });
  return db.prepare("SELECT * FROM organization_memberships WHERE organization_id=? AND member_sub=?").bind(input.organizationId, memberSub).first();
}

export async function listOrganizationMembers(db: D1Database, identity: Identity, organizationId: string) {
  await requireOrganizationRole(db, identity, organizationId, "viewer");
  return (await db.prepare("SELECT member_sub, email, display_name, role, status, created_at, updated_at FROM organization_memberships WHERE organization_id=? ORDER BY role, email").bind(organizationId).all()).results;
}

export async function attachProjectToOrganization(db: D1Database, identity: Identity, input: {organizationId:string;projectId:string}) {
  await requireOrganizationRole(db, identity, input.organizationId, "admin");
  const result = await db.prepare("UPDATE projects SET organization_id=?, updated_at=? WHERE id=? AND owner_sub=?").bind(input.organizationId, now(), input.projectId, identity.sub).run();
  if (!result.meta.changes) throw new OrganizationAccessError("Owned project not found");
  await db.prepare("INSERT OR REPLACE INTO project_memberships (project_id, member_sub, role, created_at, updated_at) VALUES (?, ?, 'maintainer', ?, ?)").bind(input.projectId, identity.sub, now(), now()).run();
  await audit(db, { organizationId:input.organizationId, actorSub:identity.sub, action:"project.attached", targetType:"project", targetId:input.projectId });
}

export async function requireProjectRole(db: D1Database, identity: Identity, projectId: string, required: ProjectRole) {
  const project = await db.prepare("SELECT owner_sub, organization_id FROM projects WHERE id=?").bind(projectId).first<{owner_sub:string;organization_id:string|null}>();
  if (!project) throw new OrganizationAccessError("Project not found");
  if (project.owner_sub === identity.sub) return "maintainer" as const;
  const direct = await db.prepare("SELECT role FROM project_memberships WHERE project_id=? AND member_sub=?").bind(projectId, identity.sub).first<{role:ProjectRole}>();
  if (direct && projectRoleAllows(direct.role, required)) return direct.role;
  if (project.organization_id) {
    const organization = await db.prepare("SELECT role, status FROM organization_memberships WHERE organization_id=? AND member_sub=?").bind(project.organization_id, identity.sub).first<{role:OrganizationRole;status:string}>();
    const mapped: Record<OrganizationRole, ProjectRole> = { owner:"maintainer", admin:"maintainer", developer:"developer", reviewer:"reviewer", viewer:"viewer" };
    if (organization?.status === "active" && projectRoleAllows(mapped[organization.role], required)) return mapped[organization.role];
  }
  throw new OrganizationAccessError(`Project ${required} role is required`);
}

export async function assignReview(db: D1Database, identity: Identity, input: {reviewRunId:string;assigneeSub:string;reason?:string}) {
  const run = await db.prepare("SELECT r.id, t.project_id FROM review_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?").bind(input.reviewRunId).first<{id:string;project_id:string}>();
  if (!run) throw new OrganizationAccessError("Review not found");
  await requireProjectRole(db, identity, run.project_id, "developer");
  const timestamp = now(); const assignmentId = id("rva");
  await db.prepare(`INSERT INTO review_assignments (id, review_run_id, assignee_sub, assigned_by_sub, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_run_id, assignee_sub) DO UPDATE SET status='requested', reason=excluded.reason, assigned_by_sub=excluded.assigned_by_sub, updated_at=excluded.updated_at`)
    .bind(assignmentId, input.reviewRunId, input.assigneeSub, identity.sub, input.reason?.trim().slice(0, 2000) || null, timestamp, timestamp).run();
  return db.prepare("SELECT * FROM review_assignments WHERE review_run_id=? AND assignee_sub=?").bind(input.reviewRunId, input.assigneeSub).first();
}

export async function decideReviewAssignment(db: D1Database, identity: Identity, input: {assignmentId:string;status:"approved"|"changes_requested"|"dismissed";reason?:string}) {
  const assignment = await db.prepare("SELECT a.*, t.project_id FROM review_assignments a JOIN review_runs r ON r.id=a.review_run_id JOIN tasks t ON t.id=r.task_id WHERE a.id=?").bind(input.assignmentId).first<{assignee_sub:string;project_id:string}>();
  if (!assignment) throw new OrganizationAccessError("Review assignment not found");
  if (assignment.assignee_sub !== identity.sub) await requireProjectRole(db, identity, assignment.project_id, "maintainer");
  await db.prepare("UPDATE review_assignments SET status=?, reason=COALESCE(?, reason), updated_at=? WHERE id=?").bind(input.status, input.reason?.trim().slice(0, 2000) || null, now(), input.assignmentId).run();
  return db.prepare("SELECT * FROM review_assignments WHERE id=?").bind(input.assignmentId).first();
}

export async function organizationAudit(db: D1Database, identity: Identity, organizationId: string, limit = 500) {
  await requireOrganizationRole(db, identity, organizationId, "viewer");
  return (await db.prepare("SELECT * FROM organization_audit_events WHERE organization_id=? ORDER BY created_at DESC LIMIT ?").bind(organizationId, Math.max(1, Math.min(limit, 5000))).all()).results;
}
