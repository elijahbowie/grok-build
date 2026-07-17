import { id, now } from "./db";
import type { Task } from "./types";

export type SessionOperation = "snapshot" | "fork" | "rewind";
export type SessionMessage = { id:string; role:"user"|"assistant"|"system"|"tool"; body:string; createdAt:string };
export type TaskSession = { id:string; ownerSub:string; projectId:string; rootTaskId:string; sourceSessionId:string|null; name:string; createdBySub:string; createdAt:string; updatedAt:string };
export type TaskSessionRevision = { id:string; sessionId:string; sourceTaskId:string; parentRevisionId:string|null; operation:SessionOperation; promptMessageId:string; title:string; prompt:string; executionContext:string; taskStatus:string; model:string; permissionMode:string; baseSha:string|null; headSha:string|null; acpSessionId:string|null; transcript:SessionMessage[]; createdBySub:string; createdAt:string };
export type ExecutableSessionTask = { taskId:string; workflowId:string; sourceTaskId:string; sourceHeadSha:string; title:string; prompt:string };

type SessionRow = { id:string;owner_sub:string;project_id:string;root_task_id:string;source_session_id:string|null;name:string;created_by_sub:string;created_at:string;updated_at:string };
type RevisionRow = { id:string;session_id:string;source_task_id:string;parent_revision_id:string|null;operation:SessionOperation;prompt_message_id:string;title:string;prompt:string;execution_context:string;task_status:string;model:string;permission_mode:string;base_sha:string|null;head_sha:string|null;acp_session_id:string|null;transcript_json:string;created_by_sub:string;created_at:string };
type MessageRow = { id:string;role:SessionMessage["role"];body:string;created_at:string;head_sha?:string|null;acp_session_id?:string|null;execution_prompt?:string|null };

function fail(message:string):never { throw new Error(message); }
export function validateSessionName(value:unknown) {
  if (typeof value !== "string") fail("Session name is required");
  const name = value.trim();
  if (!name || name.length > 160 || name.includes("\0")) fail("Session name must contain 1 to 160 characters");
  return name;
}
function presentSession(row:SessionRow):TaskSession { return { id:row.id,ownerSub:row.owner_sub,projectId:row.project_id,rootTaskId:row.root_task_id,sourceSessionId:row.source_session_id,name:row.name,createdBySub:row.created_by_sub,createdAt:row.created_at,updatedAt:row.updated_at }; }
function presentRevision(row:RevisionRow):TaskSessionRevision { let transcript:SessionMessage[]=[]; try { transcript=JSON.parse(row.transcript_json) as SessionMessage[]; } catch { fail("Stored session transcript is invalid"); } return { id:row.id,sessionId:row.session_id,sourceTaskId:row.source_task_id,parentRevisionId:row.parent_revision_id,operation:row.operation,promptMessageId:row.prompt_message_id,title:row.title,prompt:row.prompt,executionContext:row.execution_context,taskStatus:row.task_status,model:row.model,permissionMode:row.permission_mode,baseSha:row.base_sha,headSha:row.head_sha,acpSessionId:row.acp_session_id,transcript,createdBySub:row.created_by_sub,createdAt:row.created_at }; }
const access = `(s.owner_sub=? OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=s.project_id AND pm.member_sub=?) OR EXISTS (SELECT 1 FROM projects p JOIN organization_memberships om ON om.organization_id=p.organization_id WHERE p.id=s.project_id AND om.member_sub=? AND om.status='active'))`;

async function taskMessagesThrough(db:D1Database, taskId:string, promptMessageId?:string) {
  const rows=(await db.prepare(`SELECT m.id,m.role,m.body,m.created_at,c.head_sha,c.acp_session_id,c.execution_prompt
    FROM messages m LEFT JOIN task_message_checkpoints c ON c.message_id=m.id
    WHERE m.task_id=? ORDER BY m.created_at,m.id`).bind(taskId).all<MessageRow>()).results;
  return boundTranscript(rows,promptMessageId);
}
export function boundTranscript(rows:MessageRow[],promptMessageId?:string) { if (!rows.length) fail("Task has no retained prompts"); const promptIndex=promptMessageId ? rows.findIndex((message) => message.id===promptMessageId) : rows.findLastIndex((message) => message.role==="user"); if (promptIndex<0 || rows[promptIndex].role!=="user") fail("Rewind must bind to an exact retained user prompt"); const nextPrompt=rows.findIndex((message,index) => index>promptIndex && message.role==="user"); const end=nextPrompt<0 ? rows.length : nextPrompt; return { prompt:rows[promptIndex],transcript:rows.slice(0,end).map((message) => ({id:message.id,role:message.role,body:message.body,createdAt:message.created_at})) }; }

function continuationPrompt(revision:TaskSessionRevision) {
  const transcript=revision.transcript.map((message) => `${message.role.toUpperCase()}:\n${message.body}`).join("\n\n");
  const prompt=`Resume the retained Grok Build session at its exact code and conversation checkpoint. Inspect the current checkout, preserve completed work, continue from the final transcript message, and rerun relevant validation. Do not repeat work already completed.\n\nRetained execution context (including the exact selected rules and memory):\n${revision.executionContext}\n\nRetained conversation:\n${transcript}`;
  if (prompt.length>100_000) fail("Retained session transcript exceeds the task prompt limit");
  return prompt;
}

export function executableSessionTask(task:Task,revision:TaskSessionRevision):ExecutableSessionTask {
  if (!task.task_repo || !revision.headSha || !/^[a-f0-9]{40}$/i.test(revision.headSha)) fail("Session revision has no executable source code snapshot");
  const taskId=id("tsk");
  return { taskId,workflowId:`task-${taskId}`,sourceTaskId:task.id,sourceHeadSha:revision.headSha,title:`${revision.operation === "rewind" ? "Rewind" : "Fork"}: ${revision.title}`.slice(0,160),prompt:continuationPrompt(revision) };
}

export async function createExecutableSessionTask(db:D1Database,input:{task:Task;revision:TaskSessionRevision;actorSub:string}) {
  const execution=executableSessionTask(input.task,input.revision); const timestamp=now();
  const [environment,securityPolicy,runtimePin]=await Promise.all([
    db.prepare("SELECT 1 present FROM task_environments WHERE task_id=?").bind(input.task.id).first<{present:number}>(),
    db.prepare("SELECT 1 present FROM task_security_policy_pins WHERE task_id=?").bind(input.task.id).first<{present:number}>(),
    db.prepare("SELECT 1 present FROM task_runtime_pins WHERE task_id=?").bind(input.task.id).first<{present:number}>(),
  ]);
  if (!environment || !securityPolicy || !runtimePin) fail("Session source task has no complete pinned execution configuration");
  await db.batch([
    db.prepare(`INSERT INTO tasks (id,owner_sub,project_id,workflow_id,title,prompt,status,model,permission_mode,model_profile_id,output_schema_json,max_turns,allowed_tools_json,denied_tools_json,web_search_mode,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?)`).bind(execution.taskId,input.task.owner_sub,input.task.project_id,execution.workflowId,execution.title,execution.prompt,input.revision.model,input.revision.permissionMode,input.task.model_profile_id,input.task.output_schema_json,input.task.max_turns,input.task.allowed_tools_json,input.task.denied_tools_json,input.task.web_search_mode,timestamp,timestamp),
    db.prepare("INSERT INTO messages (id,task_id,role,body,created_at) VALUES (?,?,'user',?,?)").bind(id("msg"),execution.taskId,execution.prompt,timestamp),
    db.prepare("INSERT INTO task_events (task_id,seq,type,data_json,created_at) VALUES (?,1,'task.queued',?,?)").bind(execution.taskId,JSON.stringify({sessionId:input.revision.sessionId,revisionId:input.revision.id,operation:input.revision.operation,sourceTaskId:input.task.id,sourceHeadSha:execution.sourceHeadSha,actorSub:input.actorSub}),timestamp),
    db.prepare(`INSERT INTO task_environments (task_id,environment_version_id,snapshot_id,target_repository_id,manifest_hash,resolved_at)
      SELECT ?,environment_version_id,snapshot_id,target_repository_id,manifest_hash,? FROM task_environments WHERE task_id=?`).bind(execution.taskId,timestamp,input.task.id),
    db.prepare(`INSERT INTO task_security_policy_pins (task_id,revision_id,policy_digest,pinned_at)
      SELECT ?,revision_id,policy_digest,? FROM task_security_policy_pins WHERE task_id=?`).bind(execution.taskId,timestamp,input.task.id),
    db.prepare(`INSERT INTO task_runtime_pins (task_id,policy_layers_json,marketplace_items_json,digest,pinned_at)
      SELECT ?,policy_layers_json,marketplace_items_json,digest,? FROM task_runtime_pins WHERE task_id=?`).bind(execution.taskId,timestamp,input.task.id),
  ]);
  return execution;
}
async function latestRevision(db:D1Database, sessionId:string) { return db.prepare("SELECT * FROM task_session_revisions WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1").bind(sessionId).first<RevisionRow>(); }
async function insertRevision(db:D1Database, input:{sessionId:string;task:Task;parentRevisionId?:string|null;operation:SessionOperation;promptMessageId?:string;actorSub:string}) {
  const bounded=await taskMessagesThrough(db,input.task.id,input.promptMessageId); const revisionId=id("sessionrev"); const timestamp=now();
  if (!bounded.prompt.head_sha || !/^[a-f0-9]{40}$/i.test(bounded.prompt.head_sha)) fail("Selected prompt has no executable code checkpoint");
  if (!bounded.prompt.execution_prompt) fail("Selected prompt has no retained execution context");
  await db.prepare(`INSERT INTO task_session_revisions (id,session_id,source_task_id,parent_revision_id,operation,prompt_message_id,title,prompt,execution_context,task_status,model,permission_mode,base_sha,head_sha,acp_session_id,transcript_json,created_by_sub,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(revisionId,input.sessionId,input.task.id,input.parentRevisionId||null,input.operation,bounded.prompt.id,input.task.title,bounded.prompt.body,bounded.prompt.execution_prompt,input.task.status,input.task.model,input.task.permission_mode,input.task.base_sha,bounded.prompt.head_sha,bounded.prompt.acp_session_id||null,JSON.stringify(bounded.transcript),input.actorSub,timestamp).run();
  return presentRevision((await db.prepare("SELECT * FROM task_session_revisions WHERE id=?").bind(revisionId).first<RevisionRow>())!);
}

export async function ensureTaskSession(db:D1Database,input:{task:Task;actorSub:string}) {
  let row=await db.prepare("SELECT * FROM task_sessions WHERE root_task_id=? AND source_session_id IS NULL ORDER BY created_at LIMIT 1").bind(input.task.id).first<SessionRow>();
  if (!row) { const timestamp=now(); const sessionId=id("session"); await db.prepare("INSERT INTO task_sessions (id,owner_sub,project_id,root_task_id,source_session_id,name,created_by_sub,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?,?)").bind(sessionId,input.task.owner_sub,input.task.project_id,input.task.id,validateSessionName(input.task.title),input.actorSub,timestamp,timestamp).run(); row=(await db.prepare("SELECT * FROM task_sessions WHERE id=?").bind(sessionId).first<SessionRow>())!; await insertRevision(db,{sessionId,task:input.task,operation:"snapshot",actorSub:input.actorSub}); }
  return getTaskSession(db,input.actorSub,row.id);
}

export async function forkTaskSession(db:D1Database,input:{task:Task;actorSub:string;promptMessageId?:string;name?:string}) {
  const source=await ensureTaskSession(db,{task:input.task,actorSub:input.actorSub}); if (!source) fail("Source session not found"); const parent=source.revisions.at(-1)!; const timestamp=now(); const sessionId=id("session"); const name=validateSessionName(input.name || `${source.session.name} (fork)`);
  await db.prepare("INSERT INTO task_sessions (id,owner_sub,project_id,root_task_id,source_session_id,name,created_by_sub,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(sessionId,input.task.owner_sub,input.task.project_id,input.task.id,source.session.id,name,input.actorSub,timestamp,timestamp).run();
  const revision=await insertRevision(db,{sessionId,task:input.task,parentRevisionId:parent.id,operation:"fork",promptMessageId:input.promptMessageId,actorSub:input.actorSub});
  return { session:presentSession((await db.prepare("SELECT * FROM task_sessions WHERE id=?").bind(sessionId).first<SessionRow>())!),revision };
}

export async function rewindTaskSession(db:D1Database,input:{task:Task;actorSub:string;sessionId?:string;promptMessageId:string}) {
  const bundle=input.sessionId ? await getTaskSession(db,input.actorSub,input.sessionId) : await ensureTaskSession(db,{task:input.task,actorSub:input.actorSub});
  if (!bundle || bundle.session.rootTaskId!==input.task.id) fail("Session does not belong to the task"); const parent=bundle.revisions.at(-1); if (!parent) fail("Session has no revision");
  const revision=await insertRevision(db,{sessionId:bundle.session.id,task:input.task,parentRevisionId:parent.id,operation:"rewind",promptMessageId:input.promptMessageId,actorSub:input.actorSub});
  await db.prepare("UPDATE task_sessions SET updated_at=? WHERE id=?").bind(revision.createdAt,bundle.session.id).run();
  return { session:{...bundle.session,updatedAt:revision.createdAt},revision };
}

export async function getTaskSession(db:D1Database,actorSub:string,sessionId:string) {
  const row=await db.prepare(`SELECT s.* FROM task_sessions s WHERE s.id=? AND ${access}`).bind(sessionId,actorSub,actorSub,actorSub).first<SessionRow>(); if (!row) return null;
  const revisions=(await db.prepare("SELECT * FROM task_session_revisions WHERE session_id=? ORDER BY created_at,id").bind(row.id).all<RevisionRow>()).results.map(presentRevision); return {session:presentSession(row),revisions};
}
export async function findTaskSession(db:D1Database,actorSub:string,taskId:string) { const row=await db.prepare(`SELECT s.* FROM task_sessions s WHERE s.root_task_id=? AND ${access} ORDER BY s.source_session_id IS NOT NULL,s.created_at LIMIT 1`).bind(taskId,actorSub,actorSub,actorSub).first<SessionRow>(); return row ? getTaskSession(db,actorSub,row.id) : null; }
export async function renameTaskSession(db:D1Database,actorSub:string,sessionId:string,name:unknown) { const value=validateSessionName(name); const result=await db.prepare(`UPDATE task_sessions AS s SET name=?,updated_at=? WHERE s.id=? AND ${access}`).bind(value,now(),sessionId,actorSub,actorSub,actorSub).run(); if (!result.meta.changes) fail("Session not found"); return getTaskSession(db,actorSub,sessionId); }
export async function searchTaskSessions(db:D1Database,actorSub:string,query:string,projectId?:string) { const cleaned=query.trim().slice(0,200); if (!cleaned) return []; const pattern=`%${cleaned.replaceAll("%","\\%").replaceAll("_","\\_")}%`; const project=projectId ? " AND s.project_id=?" : ""; const rows=await db.prepare(`SELECT s.*,r.id revision_id,r.operation,r.prompt,r.created_at revision_created_at FROM task_sessions s JOIN task_session_revisions r ON r.id=(SELECT id FROM task_session_revisions WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) WHERE ${access}${project} AND (s.name LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR r.prompt LIKE ? ESCAPE '\\' OR r.transcript_json LIKE ? ESCAPE '\\') ORDER BY s.updated_at DESC LIMIT 50`).bind(actorSub,actorSub,actorSub,...(projectId?[projectId]:[]),pattern,pattern,pattern,pattern).all<Record<string,unknown>>(); return rows.results; }

export function renderSessionMarkdown(bundle:{session:TaskSession;revisions:TaskSessionRevision[]}) { const lines=[`# ${bundle.session.name}`,"",`Session: ${bundle.session.id}`,`Project: ${bundle.session.projectId}`,"",...bundle.revisions.flatMap((revision,index) => [`## Revision ${index+1} · ${revision.operation}`,"",`Created: ${revision.createdAt}`,`Prompt boundary: ${revision.promptMessageId}`,`Source task: ${revision.sourceTaskId}`,revision.headSha ? `Head: ${revision.headSha}` : "Head: unavailable",revision.acpSessionId ? `ACP session: ${revision.acpSessionId}` : "ACP session: unavailable","",...revision.transcript.flatMap((message) => [`### ${message.role}`,"",message.body,""])] )]; return `${lines.join("\n").trim()}\n`; }
