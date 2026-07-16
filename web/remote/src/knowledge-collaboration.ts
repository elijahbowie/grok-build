import { id, now } from "./db";
import type { ControlEnv, Identity } from "./types";
import { createCustomizationRule } from "./rules-memory";
import { requireOrganizationRole, requireProjectRole } from "./organizations";

const encoder = new TextEncoder();
function base64url(value: Uint8Array) { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
async function digest(value: string) { return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }

export async function indexTaskForSearch(db: D1Database, taskId: string) {
  const task = await db.prepare("SELECT id, owner_sub, project_id, title, prompt FROM tasks WHERE id=?").bind(taskId).first<{id:string;owner_sub:string;project_id:string;title:string;prompt:string}>();
  if (!task) return;
  const messages = await db.prepare("SELECT body FROM messages WHERE task_id=? ORDER BY created_at").bind(taskId).all<{body:string}>();
  const events = await db.prepare("SELECT data_json FROM task_events WHERE task_id=? ORDER BY seq").bind(taskId).all<{data_json:string}>();
  const paths = new Set<string>();
  for (const event of events.results) {
    const matches = event.data_json.matchAll(/(?:^|[\"'\s])([\w./-]+\.[a-zA-Z0-9]{1,12})(?=[\"'\s,}]|$)/g);
    for (const match of matches) paths.add(match[1]);
  }
  await db.prepare("DELETE FROM task_search WHERE task_id=?").bind(taskId).run();
  await db.prepare("INSERT INTO task_search (task_id, owner_sub, project_id, title, prompt, transcript, paths) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(task.id, task.owner_sub, task.project_id, task.title, task.prompt, messages.results.map((item) => item.body).join("\n"), [...paths].join(" ")).run();
}

export async function searchTasks(db: D1Database, ownerSub: string, query: string, projectId?: string) {
  const cleaned = query.trim().replace(/["'():*]/g, " ").split(/\s+/).filter(Boolean).slice(0, 12).map((term) => `"${term}"*`).join(" AND ");
  if (!cleaned) return [];
  const rows = projectId
    ? await db.prepare("SELECT task_id, title, snippet(task_search, 5, '<mark>', '</mark>', '…', 18) snippet, bm25(task_search) rank FROM task_search WHERE task_search MATCH ? AND owner_sub=? AND project_id=? ORDER BY rank LIMIT 50").bind(cleaned, ownerSub, projectId).all()
    : await db.prepare("SELECT task_id, title, snippet(task_search, 5, '<mark>', '</mark>', '…', 18) snippet, bm25(task_search) rank FROM task_search WHERE task_search MATCH ? AND owner_sub=? ORDER BY rank LIMIT 50").bind(cleaned, ownerSub).all();
  return rows.results;
}

export async function createTaskShare(db: D1Database, identity: Identity, input: { taskId:string; permission:"view"|"comment"|"review"; expiresAt?:string|null }) {
  const task = await db.prepare("SELECT id FROM tasks WHERE id=? AND owner_sub=?").bind(input.taskId, identity.sub).first();
  if (!task || !["view", "comment", "review"].includes(input.permission)) throw new Error("Invalid task share");
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32))); const shareId = id("share"); const timestamp = now();
  await db.prepare("INSERT INTO task_shares (id, task_id, owner_sub, token_hash, permission, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(shareId, input.taskId, identity.sub, await digest(secret), input.permission, input.expiresAt || null, timestamp).run();
  return { id:shareId, token:secret, permission:input.permission, expiresAt:input.expiresAt || null, createdAt:timestamp };
}

export async function revokeTaskShare(db: D1Database, identity: Identity, shareId: string) {
  const result = await db.prepare("UPDATE task_shares SET revoked_at=? WHERE id=? AND owner_sub=? AND revoked_at IS NULL").bind(now(), shareId, identity.sub).run();
  return Boolean(result.meta.changes);
}

async function shareContext(db: D1Database, token: string) {
  return db.prepare(`SELECT s.id share_id, s.permission, s.task_id, t.title, t.status, t.created_at, t.completed_at,
    p.name project_name FROM task_shares s JOIN tasks t ON t.id=s.task_id JOIN projects p ON p.id=t.project_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?)`).bind(await digest(token), now()).first<Record<string, unknown>>();
}

export async function publicTaskShareRoute(request: Request, env: ControlEnv) {
  const match = new URL(request.url).pathname.match(/^\/shared\/([^/]+)(?:\/comments)?$/);
  if (!match) return Response.json({ error:"Share not found" }, { status:404 });
  const shared = await shareContext(env.CONTROL_DB, match[1]);
  if (!shared) return Response.json({ error:"Share is invalid, expired, or revoked" }, { status:404 });
  await env.CONTROL_DB.prepare("UPDATE task_shares SET last_used_at=? WHERE id=?").bind(now(), shared.share_id).run();
  if (request.method === "POST") {
    if (shared.permission === "view") return Response.json({ error:"This share is read-only" }, { status:403 });
    const body = await request.json<{author?:string;body?:string;filePath?:string;line?:number}>();
    if (!body.body?.trim()) return Response.json({ error:"Comment body is required" }, { status:400 });
    await env.CONTROL_DB.prepare("INSERT INTO task_share_comments (id, share_id, task_id, author_label, body, file_path, line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id("shc"), shared.share_id, shared.task_id, body.author?.trim().slice(0, 80) || "Guest", body.body.trim().slice(0, 8_000), body.filePath?.slice(0, 500) || null, body.line || null, now()).run();
  }
  const [messages, events, comments] = await Promise.all([
    env.CONTROL_DB.prepare("SELECT role, body, created_at FROM messages WHERE task_id=? AND role IN ('user','assistant') ORDER BY created_at").bind(shared.task_id).all(),
    env.CONTROL_DB.prepare("SELECT type, data_json, created_at FROM task_events WHERE task_id=? AND type IN ('verification','review.completed','task.completed','task.failed') ORDER BY seq").bind(shared.task_id).all(),
    env.CONTROL_DB.prepare("SELECT author_label, body, file_path, line, created_at FROM task_share_comments WHERE share_id=? ORDER BY created_at").bind(shared.share_id).all(),
  ]);
  const payload = { task:shared, transcript:messages.results, evidence:events.results, comments:comments.results };
  if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) {
    const escape = (value:unknown) => String(value ?? "").replace(/[&<>\"']/g, (character) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]!));
    const messageHtml = messages.results.map((item) => { const value=item as {role:string;body:string;created_at:string}; return `<article><header>${escape(value.role)} <time>${escape(value.created_at)}</time></header><pre>${escape(value.body)}</pre></article>`; }).join("");
    const commentHtml = comments.results.map((item) => { const value=item as {author_label:string;body:string;created_at:string}; return `<li><strong>${escape(value.author_label)}</strong> ${escape(value.body)} <time>${escape(value.created_at)}</time></li>`; }).join("");
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(shared.title)} · Grok Build review</title><style>body{margin:0;background:#f7f7f5;color:#171714;font:15px/1.5 ui-sans-serif,system-ui}main{max-width:880px;margin:auto;padding:48px 24px}header{display:flex;gap:12px;justify-content:space-between;color:#666;font-size:12px}h1{font-size:28px;margin:8px 0}.meta{border-bottom:1px solid #d8d8d2;padding-bottom:24px;margin-bottom:24px}article{background:#fff;border:1px solid #dddcd5;border-radius:8px;padding:18px;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}time{color:#777}li{margin:8px 0}.proof{font-size:12px;color:#555}</style><main><div class="meta"><small>Grok Build · shared ${escape(shared.permission)} review</small><h1>${escape(shared.title)}</h1><p>${escape(shared.project_name)} · ${escape(shared.status)}</p><p class="proof">This read-only surface contains the retained transcript and selected verification events. Cloudflare Artifacts is the canonical source repository.</p></div><section aria-label="Transcript">${messageHtml}</section><section><h2>Reviewer comments</h2><ul>${commentHtml || "<li>No comments yet.</li>"}</ul></section></main></html>`, { headers:{ "content-type":"text/html; charset=utf-8", "cache-control":"private, no-store", "x-content-type-options":"nosniff", "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
  }
  return Response.json(payload, { headers:{ "cache-control":"private, no-store" } });
}

export async function listMarketplace(db: D1Database, ownerSub: string, organizationId?: string) {
  const rows = organizationId
    ? await db.prepare("SELECT * FROM marketplace_items WHERE organization_id=? AND trust_status='approved' ORDER BY kind, name").bind(organizationId).all()
    : await db.prepare("SELECT * FROM marketplace_items WHERE owner_sub=? ORDER BY updated_at DESC").bind(ownerSub).all();
  return rows.results;
}

export async function createMarketplaceItem(db: D1Database, identity: Identity, input: { organizationId?:string|null;kind:string;name:string;description:string;version:string;source:string;manifest:Record<string, unknown> }) {
  if (!['mcp','plugin','skill','rule','command','hook','subagent'].includes(input.kind) || !input.name?.trim() || !input.version?.trim()) throw new Error("Invalid marketplace item");
  if (input.organizationId) await requireOrganizationRole(db, identity, input.organizationId, "developer");
  const itemId = id("market"); const timestamp = now(); const canonical = JSON.stringify(input.manifest || {}); const itemDigest = await digest(canonical);
  await db.prepare(`INSERT INTO marketplace_items (id, owner_sub, organization_id, kind, name, description, version, source, digest, manifest_json, trust_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(itemId, identity.sub, input.organizationId || null, input.kind, input.name.trim().slice(0,120), input.description?.trim().slice(0,2_000) || "", input.version.trim().slice(0,40), input.source.trim().slice(0,1_000), itemDigest, canonical, timestamp, timestamp).run();
  return { id:itemId, digest:itemDigest, trustStatus:"pending", createdAt:timestamp };
}

export async function setMarketplaceTrust(db: D1Database, identity: Identity, itemId: string, status:"approved"|"rejected"|"revoked") {
  const item = await db.prepare("SELECT owner_sub,organization_id FROM marketplace_items WHERE id=?").bind(itemId).first<{owner_sub:string;organization_id:string|null}>();
  if (!item) throw new Error("Marketplace item not found");
  if (item.owner_sub !== identity.sub) {
    if (!item.organization_id) throw new Error("Marketplace owner approval is required");
    await requireOrganizationRole(db, identity, item.organization_id, "admin");
  }
  const result = await db.prepare("UPDATE marketplace_items SET trust_status=?, updated_at=? WHERE id=?").bind(status, now(), itemId).run();
  if (!result.meta.changes) throw new Error("Marketplace item not found");
  return { id:itemId, trustStatus:status };
}

export async function installMarketplaceItem(db: D1Database, identity: Identity, itemId: string, input: { subjectType:"organization"|"group"|"project"|"member";subjectId:string }) {
  const item = await db.prepare("SELECT id,organization_id FROM marketplace_items WHERE id=? AND trust_status='approved'").bind(itemId).first<{id:string;organization_id:string|null}>();
  if (!item) throw new Error("Only approved marketplace items can be installed");
  if (input.subjectType === "organization") await requireOrganizationRole(db, identity, input.subjectId, "admin");
  else if (input.subjectType === "project") await requireProjectRole(db, identity, input.subjectId, "maintainer");
  else if (input.subjectType === "member" && input.subjectId !== identity.sub) {
    if (!item.organization_id) throw new Error("Only the current member can install this item");
    await requireOrganizationRole(db, identity, item.organization_id, "admin");
  }
  await db.prepare("INSERT OR REPLACE INTO marketplace_grants (item_id, subject_type, subject_id, installed_by_sub, installed_at) VALUES (?, ?, ?, ?, ?)")
    .bind(itemId, input.subjectType, input.subjectId, identity.sub, now()).run();
  return { itemId, ...input, installed:true };
}

export async function approveRuleCandidate(db: D1Database, identity: Identity, candidateId: string) {
  const candidate = await db.prepare("SELECT * FROM review_rule_candidates WHERE id=? AND owner_sub=? AND status='candidate'").bind(candidateId, identity.sub).first<{id:string;project_id:string;title:string;content:string;rationale:string}>();
  if (!candidate) throw new Error("Rule candidate not found");
  const rule = await createCustomizationRule(db, { ownerSub:identity.sub, actorSub:identity.sub, scope:"project", projectId:candidate.project_id, name:candidate.title, mode:"always", content:candidate.content, reason:candidate.rationale });
  await db.prepare("UPDATE review_rule_candidates SET status='approved', approved_rule_id=?, updated_at=? WHERE id=?").bind(rule.id, now(), candidate.id).run();
  return rule;
}
