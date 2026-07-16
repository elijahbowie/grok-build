import { controlRoute } from "./api";
import { agentApiProjectAllowed, authenticateAgentApiKey, idempotentResponse, requestDigest, requireAgentApiScope } from "./agent-api-auth";
import type { ControlEnv, Identity } from "./types";
import { createAgentWebhook, disableAgentWebhook, listAgentWebhooks } from "./agent-webhooks";

const jsonHeaders = { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers:jsonHeaders }); }

function rewrittenRequest(request: Request, path: string, body?: string) {
  const url = new URL(request.url); url.pathname = path;
  const headers = new Headers(request.headers); headers.delete("authorization");
  return new Request(url, { method:request.method, headers, body:request.method === "GET" || request.method === "HEAD" ? undefined : body, redirect:"manual" });
}

async function taskProject(env: ControlEnv, ownerSub: string, taskId: string) {
  return env.CONTROL_DB.prepare(`SELECT t.project_id FROM tasks t WHERE t.id=? AND (t.owner_sub=?
    OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=t.project_id AND pm.member_sub=?)
    OR EXISTS (SELECT 1 FROM projects p JOIN organization_memberships om ON om.organization_id=p.organization_id WHERE p.id=t.project_id AND om.member_sub=? AND om.status='active'))`)
    .bind(taskId, ownerSub, ownerSub, ownerSub).first<{project_id:string}>();
}

export async function agentApiRoute(request: Request, env: ControlEnv) {
  const apiIdentity = await authenticateAgentApiKey(request, env.CONTROL_DB);
  if (!apiIdentity) return json({ error:"Valid Grok Build API key required" }, 401);
  const identity: Identity = { sub:apiIdentity.ownerSub, email:`api-key-${apiIdentity.keyId}@grok-build.invalid`, name:"Agent API" };
  const url = new URL(request.url);
  try {
    if (url.pathname === "/v1/webhooks" && request.method === "GET") {
      requireAgentApiScope(apiIdentity, "webhooks:write");
      return json({ webhooks:await listAgentWebhooks(env.CONTROL_DB, apiIdentity.ownerSub) });
    }
    if (url.pathname === "/v1/webhooks" && request.method === "POST") {
      requireAgentApiScope(apiIdentity, "webhooks:write");
      const input = await request.json<{projectId?:string|null;label:string;endpoint:string;eventTypes:string[]}>();
      if (input.projectId && !agentApiProjectAllowed(apiIdentity, input.projectId)) return json({ error:"Project is outside this API key scope" }, 403);
      return json(await createAgentWebhook(env, { ownerSub:apiIdentity.ownerSub, organizationId:apiIdentity.organizationId, ...input }), 201);
    }
    const webhookMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
    if (webhookMatch && request.method === "DELETE") {
      requireAgentApiScope(apiIdentity, "webhooks:write");
      return json({ disabled:await disableAgentWebhook(env.CONTROL_DB, apiIdentity.ownerSub, webhookMatch[1]) });
    }
    if (url.pathname === "/v1/agents" && request.method === "POST") {
      requireAgentApiScope(apiIdentity, "agents:write");
      const body = await request.text(); let input: {projectId?:string};
      try { input = JSON.parse(body) as {projectId?:string}; } catch { return json({ error:"Request body must be JSON" }, 400); }
      if (!input.projectId || !agentApiProjectAllowed(apiIdentity, input.projectId)) return json({ error:"Project is outside this API key scope" }, 403);
      const execute = () => controlRoute(rewrittenRequest(request, "/api/tasks", body), env, identity);
      const key = request.headers.get("idempotency-key");
      return key ? idempotentResponse(env.CONTROL_DB, { identity:apiIdentity, key, requestDigest:await requestDigest(request, body), execute }) : execute();
    }
    if (url.pathname === "/v1/agents" && request.method === "GET") {
      requireAgentApiScope(apiIdentity, "agents:read");
      const projectId = url.searchParams.get("projectId");
      if (apiIdentity.projectIds.length && (!projectId || !agentApiProjectAllowed(apiIdentity, projectId))) return json({ error:"A projectId inside this API key scope is required" }, 403);
      const path = `/api/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`;
      return controlRoute(rewrittenRequest(request, path), env, identity);
    }
    const eventsMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/events$/);
    if (eventsMatch && request.method === "GET") {
      requireAgentApiScope(apiIdentity, "events:read");
      const task = await taskProject(env, apiIdentity.ownerSub, eventsMatch[1]);
      if (!task || !agentApiProjectAllowed(apiIdentity, task.project_id)) return json({ error:"Agent not found" }, 404);
      const after = Math.max(0, Number(url.searchParams.get("after") || 0));
      const events = await env.CONTROL_DB.prepare("SELECT id, seq, type, data_json, created_at FROM task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 1000").bind(eventsMatch[1], after).all();
      return json({ events:events.results });
    }
    const followupMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/followups$/);
    if (followupMatch && request.method === "POST") {
      requireAgentApiScope(apiIdentity, "agents:write");
      const task = await taskProject(env, apiIdentity.ownerSub, followupMatch[1]);
      if (!task || !agentApiProjectAllowed(apiIdentity, task.project_id)) return json({ error:"Agent not found" }, 404);
      return controlRoute(rewrittenRequest(request, `/api/tasks/${followupMatch[1]}/followups`, await request.text()), env, identity);
    }
    const cancelMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      requireAgentApiScope(apiIdentity, "agents:cancel");
      const task = await taskProject(env, apiIdentity.ownerSub, cancelMatch[1]);
      if (!task || !agentApiProjectAllowed(apiIdentity, task.project_id)) return json({ error:"Agent not found" }, 404);
      return controlRoute(rewrittenRequest(request, `/api/tasks/${cancelMatch[1]}/cancel`, await request.text()), env, identity);
    }
    const detailMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (detailMatch && request.method === "GET") {
      requireAgentApiScope(apiIdentity, "agents:read");
      const task = await taskProject(env, apiIdentity.ownerSub, detailMatch[1]);
      if (!task || !agentApiProjectAllowed(apiIdentity, task.project_id)) return json({ error:"Agent not found" }, 404);
      return controlRoute(rewrittenRequest(request, `/api/tasks/${detailMatch[1]}`), env, identity);
    }
    return json({ error:"Agent API route not found" }, 404);
  } catch (error) {
    return json({ error:error instanceof Error ? error.message : "Agent API request failed" }, 403);
  }
}
