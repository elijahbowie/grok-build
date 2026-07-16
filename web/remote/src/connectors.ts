import { id, now } from "./db";
import type { ControlEnv, Identity, Project } from "./types";
import { appendSecurityAuditEvent, isMcpToolGranted } from "./security-policy";

type Connector = {
  id: string; owner_sub: string; kind: "http" | "sse"; label: string; endpoint: string;
  auth_type: "none" | "oauth" | "secret-proxy"; secret_ref: string | null; enabled: number;
  created_at: string; updated_at: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(value: string) {
  return bytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
}

async function key(env: ControlEnv, usage: Array<"encrypt" | "decrypt">) {
  return crypto.subtle.importKey("raw", bytes(env.CONNECTOR_ENCRYPTION_KEY), { name: "AES-GCM" }, false, usage);
}

export async function encryptSecret(env: ControlEnv, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env, ["encrypt"]), encoder.encode(value));
  return JSON.stringify({ v: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) });
}

export async function decryptSecret(env: ControlEnv, value: string) {
  const parsed = JSON.parse(value) as {iv:string;ciphertext:string};
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(parsed.iv) }, await key(env, ["decrypt"]), fromBase64url(parsed.ciphertext));
  return decoder.decode(plaintext);
}

function safeEndpoint(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || hostname === "localhost" || hostname.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) throw new Error("MCP endpoints must use a public HTTPS hostname");
  return url.toString();
}

export async function createConnector(env: ControlEnv, identity: Identity, input: {projectId?:string;label?:string;endpoint?:string;transport?:string;authorization?:string}) {
  if (input.transport === "stdio") throw new Error("Secret-bearing stdio MCP servers are not allowed in cloud sandboxes; use HTTP or SSE through the credential proxy");
  if (!input.label?.trim() || !/^[a-zA-Z0-9._ -]{1,80}$/.test(input.label) || !["http", "sse"].includes(input.transport || "")) throw new Error("Invalid MCP connector");
  const endpoint = safeEndpoint(input.endpoint || "");
  let project: Project | null = null;
  if (input.projectId) project = await env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_sub = ?").bind(input.projectId, identity.sub).first<Project>();
  if (input.projectId && !project) throw new Error("Project not found");
  const connectorId = id("mcp");
  const secretRef = input.authorization ? `connectors/${connectorId}.json.enc` : null;
  if (secretRef) await env.CONNECTOR_SECRETS.put(secretRef, await encryptSecret(env, JSON.stringify({ authorization: input.authorization })), { httpMetadata: { contentType: "application/octet-stream" } });
  const timestamp = now();
  try {
    await env.CONTROL_DB.prepare("INSERT INTO connectors (id, owner_sub, kind, label, endpoint, auth_type, secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(connectorId, identity.sub, input.transport, input.label.trim(), endpoint, secretRef ? "secret-proxy" : "none", secretRef, timestamp, timestamp).run();
    if (project) await env.CONTROL_DB.prepare("INSERT INTO project_connectors (project_id, connector_id, read_allowed, write_allowed) VALUES (?, ?, 1, 0)").bind(project.id, connectorId).run();
  } catch (error) {
    if (secretRef) await env.CONNECTOR_SECRETS.delete(secretRef);
    throw error;
  }
  return { id: connectorId, label: input.label.trim(), endpoint, transport: input.transport, authType: secretRef ? "secret-proxy" : "none", projectId: project?.id || null, enabled: true };
}

export async function listConnectors(env: ControlEnv, identity: Identity, projectId?: string | null) {
  const result = projectId
    ? await env.CONTROL_DB.prepare("SELECT c.id, c.label, c.endpoint, c.kind, c.auth_type, c.enabled, c.created_at, c.updated_at FROM connectors c JOIN project_connectors pc ON pc.connector_id=c.id JOIN projects p ON p.id=pc.project_id WHERE c.owner_sub=? AND p.owner_sub=? AND p.id=? ORDER BY c.label").bind(identity.sub, identity.sub, projectId).all<Connector>()
    : await env.CONTROL_DB.prepare("SELECT id, label, endpoint, kind, auth_type, enabled, created_at, updated_at FROM connectors WHERE owner_sub = ? ORDER BY label").bind(identity.sub).all<Connector>();
  return result.results.map((item) => ({ id: item.id, label: item.label, endpoint: item.endpoint, transport: item.kind, authType: item.auth_type, enabled: Boolean(item.enabled), createdAt: item.created_at, updatedAt: item.updated_at }));
}

export async function removeConnector(env: ControlEnv, identity: Identity, connectorId: string) {
  const connector = await env.CONTROL_DB.prepare("SELECT * FROM connectors WHERE id = ? AND owner_sub = ?").bind(connectorId, identity.sub).first<Connector>();
  if (!connector) return false;
  await env.CONTROL_DB.prepare("DELETE FROM connectors WHERE id = ?").bind(connectorId).run();
  if (connector.secret_ref) await env.CONNECTOR_SECRETS.delete(connector.secret_ref);
  return true;
}

async function signingKey(env: ControlEnv) {
  return crypto.subtle.importKey("raw", bytes(env.CONNECTOR_ENCRYPTION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function connectorProxyToken(env: ControlEnv, connectorId: string, taskId: string, ttlSeconds = 7200) {
  const payload = base64url(encoder.encode(JSON.stringify({ connectorId, taskId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

async function verifyProxyToken(env: ControlEnv, token: string, connectorId: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const valid = await crypto.subtle.verify("HMAC", await signingKey(env), fromBase64url(signature), encoder.encode(payload));
  if (!valid) return null;
  try {
    const claims = JSON.parse(decoder.decode(fromBase64url(payload))) as {connectorId:string;taskId:string;exp:number};
    return claims.connectorId === connectorId && claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch { return null; }
}

export async function connectorProxyRoute(request: Request, env: ControlEnv) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/mcp-proxy\/([^/]+)(\/.*)?$/);
  if (!match) return Response.json({ error: "Connector route not found" }, { status: 404 });
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const claims = await verifyProxyToken(env, supplied, match[1]);
  if (!claims) return Response.json({ error: "Invalid or expired connector token" }, { status: 401 });
  if (request.method !== "GET" && request.method !== "POST") return Response.json({ error: "MCP proxy supports only GET and JSON-RPC POST" }, { status: 405, headers: { allow: "GET, POST" } });
  const connector = await env.CONTROL_DB.prepare("SELECT * FROM connectors WHERE id = ? AND enabled = 1").bind(match[1]).first<Connector>();
  if (!connector?.endpoint) return Response.json({ error: "Connector not found" }, { status: 404 });
  if (request.method === "POST") {
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
    if (mediaType !== "application/json" && !mediaType.endsWith("+json")) return Response.json({ error: "MCP POST requests must use a JSON content type" }, { status: 415 });
    let payload: unknown;
    try { payload = await request.clone().json(); }
    catch { return Response.json({ error: "Invalid MCP JSON request" }, { status: 400 }); }
    const messages = Array.isArray(payload) ? payload : [payload];
    if (!messages.length || messages.some((message) => !message || typeof message !== "object" || Array.isArray(message))) return Response.json({ error: "Invalid MCP JSON-RPC payload" }, { status: 400 });
    const task = await env.CONTROL_DB.prepare("SELECT owner_sub, project_id FROM tasks WHERE id = ?").bind(claims.taskId).first<{owner_sub:string;project_id:string}>();
    if (!task) return Response.json({ error: "Task authorization context is unavailable" }, { status: 403 });
    for (const rawMessage of messages) {
      const message = rawMessage as {method?:unknown;params?:{name?:unknown}};
      if (message.method !== "tools/call") continue;
      const toolName = typeof message.params?.name === "string" ? message.params.name : "";
      if (!toolName || !await isMcpToolGranted(env.CONTROL_DB, { taskId: claims.taskId, connectorId: connector.id, toolName })) {
        await appendSecurityAuditEvent(env.CONTROL_DB, { ownerSub: task.owner_sub, projectId: task.project_id, taskId: claims.taskId, category: "mcp", action: "tools/call", decision: "denied", target: `${connector.id}:${toolName || "invalid"}` });
        return Response.json({ error: "This exact MCP tool is not granted for the task" }, { status: 403 });
      }
      await appendSecurityAuditEvent(env.CONTROL_DB, { ownerSub: task.owner_sub, projectId: task.project_id, taskId: claims.taskId, category: "mcp", action: "tools/call", decision: "allowed", target: `${connector.id}:${toolName}` });
    }
  }
  const target = new URL(match[2] || "", connector.endpoint);
  target.search = url.search;
  const headers = new Headers(request.headers);
  headers.delete("authorization"); headers.delete("cf-access-jwt-assertion"); headers.delete("host");
  if (connector.secret_ref) {
    const stored = await env.CONNECTOR_SECRETS.get(connector.secret_ref);
    if (!stored) return Response.json({ error: "Connector credential is unavailable" }, { status: 502 });
    const secret = JSON.parse(await decryptSecret(env, await stored.text())) as {authorization?:string};
    if (secret.authorization) headers.set("authorization", secret.authorization);
  }
  return fetch(new Request(target, request), { headers, redirect: "manual" });
}

export type { Connector };
