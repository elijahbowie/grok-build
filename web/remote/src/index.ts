import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox";
import { accessConfigured, accessIdentity } from "./auth";
import { controlRoute, desktopRoute } from "./api";
import type { ControlEnv, Identity } from "./types";
import { connectorProxyRoute } from "./connectors";
import { githubCiLogProxy, githubWebhook } from "./github";
import { companionArtifactToken, companionIdentity, pairCompanion, revokeCompanionToken } from "./companion";
import { getAutomationTrigger, listDueCronTriggers, recordCronTriggerFired, verifyWebhookHmac } from "./cloud-automations";
import { dispatchAutomation, drainAutomationQueue } from "./automation-runtime";
import { agentApiRoute } from "./agent-api";
import { cleanupExpiredAgentInputAttachments } from "./agent-jobs";
import { processArtifactsEvent } from "./scm-events";
import { publicTaskShareRoute } from "./knowledge-collaboration";
import { retryAgentWebhookDeliveries } from "./agent-webhooks";
import { retryAutomationDeliveries } from "./automation-delivery";
import { runAcpPrompt } from "./acp-runtime";
import { defaultSecurityPolicy } from "./security-policy";
import { nativePermissionConfig, permissionCliArgs } from "./runtime-security";
export { TaskHub } from "./task-hub";
export { TaskWorkflow } from "./workflow";
export { GitHubSyncWorkflow } from "./github";
export { ReviewWorkflow } from "./review-workflow";
export { PlanningWorkflow } from "./planning-workflow";
export { DesignWorkflow } from "./design-workflow";

type RunRequest = {
  taskId: string; repository: string; baseBranch: string; branch: string; prompt: string;
  model?: string; permissionMode?: "isolated-write" | "review-only"; sessionId?: string;
};
type PreviewRequest = { taskId: string; command: string; port: number };

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const grokHome = "/home/grok";
const authProcessId = "grok-device-login";
const subscriptionSandboxId = "subscription-v2";

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: jsonHeaders }); }
function shell(value: string) { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }
function taskId(value: unknown) { return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value) ? value.toLowerCase() : null; }
function repository(value: unknown) { return typeof value === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value) ? value : null; }
async function authorized(request: Request, expected: string) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(supplied)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
  return crypto.subtle.timingSafeEqual(left, right);
}
async function body<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 128_000) throw new Error("Request body exceeds 128 KB");
  return request.json<T>();
}
function sandboxFor(env: Env, id: string) { return getSandbox(env.Sandbox, `grok-${id}`, { normalizeId: true, sleepAfter: "30s" }); }

function cleanAuthLog(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/xai-[A-Za-z0-9_-]{20,}/g, "[REDACTED]").replace(/eyJ[A-Za-z0-9._-]{40,}/g, "[REDACTED]").slice(-12_000);
}

async function hasSavedSubscription(sandbox: Sandbox) {
  return (await sandbox.exec(`test -s ${shell(`${grokHome}/auth.json`)}`)).success;
}

async function loadSubscription(env: Env, sandbox: Sandbox) {
  await sandbox.exec(`mkdir -p ${shell(grokHome)} && chmod 700 ${shell(grokHome)}`);
  if (await hasSavedSubscription(sandbox)) return true;
  const stored = await env.GROK_HOME_STORE.get("profile/auth.json");
  if (!stored) return false;
  await sandbox.writeFile(`${grokHome}/auth.json`, await stored.text());
  await sandbox.exec(`chmod 600 ${shell(`${grokHome}/auth.json`)}`);
  return true;
}

async function persistSubscription(env: Env, sandbox: Sandbox) {
  if (!await hasSavedSubscription(sandbox)) return false;
  const auth = await sandbox.readFile(`${grokHome}/auth.json`);
  if (!auth.success) return false;
  await env.GROK_HOME_STORE.put("profile/auth.json", auth.content, { httpMetadata: { contentType: "application/json" } });
  return true;
}

async function subscriptionStatus(env: Env) {
  const sandbox = sandboxFor(env, subscriptionSandboxId);
  await loadSubscription(env, sandbox);
  const process = await sandbox.getProcess(authProcessId);
  if (process) {
    const [status, logs] = await Promise.all([process.getStatus(), process.getLogs()]);
    if (status === "running" || status === "starting") return { authenticated: false, status: "waiting", log: cleanAuthLog(`${logs.stdout}\n${logs.stderr}`) };
  }
  const logs = process ? await process.getLogs() : { stdout: "", stderr: "" };
  const authenticated = await persistSubscription(env, sandbox);
  return { authenticated, status: authenticated ? "authenticated" : process ? "failed" : "signed-out", log: cleanAuthLog(`${logs.stdout}\n${logs.stderr}`) };
}

async function startDeviceLogin(env: Env) {
  const current = await subscriptionStatus(env);
  if (current.authenticated || current.status === "waiting") return current;
  const sandbox = sandboxFor(env, subscriptionSandboxId);
  const existing = await sandbox.getProcess(authProcessId);
  if (existing) await existing.kill();
  const process = await sandbox.startProcess("stdbuf -oL -eL grok login --device-auth", { processId: authProcessId, autoCleanup: false, env: { GROK_HOME: grokHome, NO_COLOR: "1" } });
  await process.waitForLog("https://", 15_000).catch(() => undefined);
  return subscriptionStatus(env);
}

async function prepare(sandbox: Sandbox, input: RunRequest) {
  const repo = repository(input.repository); const id = taskId(input.taskId);
  if (!repo || !id || !input.prompt?.trim() || input.prompt.length > 100_000) throw new Error("Invalid task, repository, or prompt");
  const cwd = "/workspace/repository";
  const exists = await sandbox.exec("test -d .git", { cwd });
  if (!exists.success) {
    const clone = await sandbox.exec(`rm -rf ${shell(cwd)} && git clone --branch ${shell(input.baseBranch || "main")} --single-branch ${shell(repo)} ${shell(cwd)}`, { timeout: 180_000 });
    if (!clone.success) throw new Error(`Repository clone failed: ${clone.stderr.slice(-1200)}`);
    await sandbox.exec(`git checkout -b ${shell(input.branch)}`, { cwd });
    await sandbox.exec("git config user.name 'Grok Build' && git config user.email 'grok-build@users.noreply.github.com'", { cwd });
  }
  await sandbox.writeFile("/workspace/prompt.txt", input.prompt);
  return cwd;
}

async function runTask(request: Request, env: Env) {
  const input = await body<RunRequest>(request); const id = taskId(input.taskId);
  if (!id) return json({ error: "Invalid task id" }, 400);
  const sandbox = sandboxFor(env, id);
  if (!await loadSubscription(env, sandbox)) return json({ error: "Cloud Grok subscription is signed out. Complete device authentication in Settings." }, 401);
  const cwd = await prepare(sandbox, input);
  const readOnly = input.permissionMode === "review-only";
  const policy=defaultSecurityPolicy();
  policy.filesystem.readRoots=[cwd]; policy.filesystem.writeRoots=[cwd];
  const permissionArgs=permissionCliArgs(nativePermissionConfig(policy,readOnly));
  const result = await runAcpPrompt(sandbox, id, { cwd, grokHome, model:input.model || "grok-4.5", prompt:input.prompt, permissionArgs, sessionId:input.sessionId, reviewOnly:readOnly, env:{}, deniedPaths:policy.filesystem.deniedPaths });
  await persistSubscription(env, sandbox);
  await sandbox.exec("git add -N .", { cwd });
  const diff = await sandbox.exec("git diff --binary --no-ext-diff HEAD", { cwd, timeout: 120_000 });
  return json({ ok: result.ok, exitCode:result.ok ? 0 : 1, stderr: result.stderr.slice(-20_000), events:result.events.slice(-2000), patch: diff.stdout, sessionId:result.sessionId || input.sessionId || null }, result.ok ? 200 : 422);
}

async function startPreview(request: Request, env: Env) {
  const input = await body<PreviewRequest>(request); const id = taskId(input.taskId);
  if (!id || !input.command?.trim() || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) return json({ error: "Invalid preview request" }, 400);
  const sandbox = sandboxFor(env, id); const process = await sandbox.startProcess(input.command, { cwd: "/workspace/repository", processId: `preview-${id}`, env: { HOST: "0.0.0.0" }, autoCleanup: false });
  await process.waitForPort(input.port, { timeout: 90_000 });
  const exposed = await sandbox.exposePort(input.port, { hostname: new URL(request.url).hostname, name: `preview-${id}` });
  return json({ status: "running", url: exposed.url, command: input.command, port: input.port, processId: process.id });
}

async function route(request: Request, env: ControlEnv) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return json({ ok: true });
  const automationWebhook = url.pathname.match(/^\/automation\/webhooks\/([^/]+)$/);
  if (automationWebhook && request.method === "POST") {
    const row = await env.CONTROL_DB.prepare("SELECT t.secret_ref, a.owner_sub FROM cloud_automation_triggers t JOIN cloud_automations a ON a.id=t.automation_id WHERE t.id=? AND t.type='webhook' AND t.enabled=1 AND a.status='enabled'").bind(automationWebhook[1]).first<{secret_ref:string;owner_sub:string}>();
    if (!row) return json({ error: "Automation webhook not found" }, 404);
    const secret = (env as unknown as Record<string, unknown>)[row.secret_ref];
    if (typeof secret !== "string" || !secret) return json({ error: "Automation webhook secret is unavailable" }, 503);
    const bodyText = await request.text();
    const timestamp = request.headers.get("x-grok-timestamp") || ""; const signature = request.headers.get("x-grok-signature") || "";
    if (!await verifyWebhookHmac({ secret, body:bodyText, timestamp, signature })) return json({ error: "Invalid automation webhook signature" }, 401);
    let payload: Record<string, unknown>; try { payload = JSON.parse(bodyText) as Record<string, unknown>; } catch { return json({ error: "Webhook body must be a JSON object" }, 400); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "Webhook body must be a JSON object" }, 400);
    const trigger = await getAutomationTrigger(env.CONTROL_DB, row.owner_sub, automationWebhook[1]);
    if (!trigger) return json({ error: "Automation webhook not found" }, 404);
    const delivery = request.headers.get("x-grok-delivery");
    if (!delivery || !/^[A-Za-z0-9._:-]{1,120}$/.test(delivery)) return json({ error: "x-grok-delivery is required" }, 400);
    const dispatched = await dispatchAutomation(env, { ownerSub:row.owner_sub, automationId:trigger.automationId, triggerId:trigger.id, triggerType:"webhook", idempotencyKey:`webhook:${delivery}:${trigger.id}`, provenance:{ source:"signed-webhook", delivery, timestamp }, triggerPayload:payload, webhookVerified:true });
    return json(dispatched, dispatched.admitted ? 202 : 200);
  }
  if (url.pathname.startsWith("/mcp-proxy/")) return connectorProxyRoute(request, env);
  if (url.pathname.startsWith("/shared/")) return publicTaskShareRoute(request, env);
  if (url.pathname.startsWith("/github-ci-proxy/")) return githubCiLogProxy(request, env);
  if (url.pathname === "/github/webhook" && request.method === "POST") return githubWebhook(request, env);
  if (url.pathname === "/v1/agents" || url.pathname.startsWith("/v1/agents/") || url.pathname === "/v1/attachments" || url.pathname === "/v1/webhooks" || url.pathname.startsWith("/v1/webhooks/")) return agentApiRoute(request, env);
  if (url.pathname === "/v1/companion/pair" && request.method === "POST") return pairCompanion(request, env);
  if (url.pathname.startsWith("/v1/companion/") && url.pathname !== "/v1/companion/pair") {
    const bodyText = request.method === "GET" ? "" : await request.text();
    const companion = await companionIdentity(request, env, bodyText);
    if (!companion) return json({ error: "Companion signature required" }, 401);
    if (request.method === "POST" && /^\/v1\/companion\/projects\/[^/]+\/artifact-token$/.test(url.pathname)) return companionArtifactToken(request, env, companion.owner_sub);
    if (request.method === "DELETE" && url.pathname === "/v1/companion/artifact-token") return revokeCompanionToken(env, companion.owner_sub, bodyText);
    return json({ error: "Companion route not found" }, 404);
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/desktop/")) {
    let identity = await accessIdentity(request, env);
    const localServiceAccess = ["localhost", "127.0.0.1"].includes(url.hostname) && await authorized(request, env.RUNNER_TOKEN);
    if (!identity && localServiceAccess) identity = { sub: "local-development", email: env.ACCESS_EMAIL } satisfies Identity;
    if (!identity) return json({ error: accessConfigured(env) ? "Cloudflare Access authentication required" : "Cloudflare Access is not configured" }, accessConfigured(env) ? 401 : 503);
    return url.pathname.startsWith("/desktop/") ? desktopRoute(request, env, identity) : controlRoute(request, env, identity);
  }
  if (!url.pathname.startsWith("/v1/")) {
    if (request.method === "GET" || request.method === "HEAD") return env.ASSETS.fetch(request);
    return json({ error: "Route not found" }, 404);
  }
  if (!await authorized(request, env.RUNNER_TOKEN)) return json({ error: "Authentication required" }, 401);
  if (request.method === "POST" && url.pathname === "/v1/health") {
    const sandbox = sandboxFor(env, "health-0-12-3"); const probe = await sandbox.exec("grok --version && uname -srm", { timeout: 120_000 });
    const subscription = await subscriptionStatus(env);
    return json({ ok: probe.success, compute: probe.stdout.trim(), subscription }, probe.success ? 200 : 503);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/device") return json(await startDeviceLogin(env), 202);
  if (request.method === "POST" && url.pathname === "/v1/auth/status") return json(await subscriptionStatus(env));
  if (request.method === "DELETE" && url.pathname === "/v1/auth") { const sandbox = sandboxFor(env, subscriptionSandboxId); await loadSubscription(env, sandbox); const process = await sandbox.getProcess(authProcessId); if (process) await process.kill(); await sandbox.exec("grok logout", { timeout: 60_000, env: { GROK_HOME: grokHome, NO_COLOR: "1" } }); await env.GROK_HOME_STORE.delete("profile/auth.json"); return json({ authenticated: false, status: "signed-out" }); }
  if (request.method === "POST" && url.pathname === "/v1/run") return runTask(request, env);
  if (request.method === "POST" && url.pathname === "/v1/preview") return startPreview(request, env);
  if (request.method === "POST" && url.pathname === "/v1/cancel") { const input = await body<{taskId:string}>(request); const id = taskId(input.taskId); if (!id) return json({ error: "Invalid task id" }, 400); const killed = await sandboxFor(env, id).killAllProcesses(); return json({ ok: true, killed }); }
  if (request.method === "DELETE" && url.pathname === "/v1/preview") { const input = await body<{taskId:string;port?:number}>(request); const id = taskId(input.taskId); if (!id) return json({ error: "Invalid task id" }, 400); const sandbox = sandboxFor(env, id); const process = await sandbox.getProcess(`preview-${id}`); if (process) await process.kill(); if (input.port) await sandbox.unexposePort(input.port); return json({ status: "stopped" }); }
  return json({ error: "Route not found" }, 404);
}

async function runScheduledAutomations(env: ControlEnv, scheduledTime: number) {
  const firedAt = new Date(scheduledTime).toISOString();
  const owners = await env.CONTROL_DB.prepare("SELECT DISTINCT owner_sub FROM cloud_automations WHERE status='enabled'").all<{owner_sub:string}>();
  for (const owner of owners.results) {
    const triggers = await listDueCronTriggers(env.CONTROL_DB, { ownerSub: owner.owner_sub, at: firedAt, limit: 100 });
    for (const trigger of triggers) {
      const dueAt = trigger.nextDueAt || firedAt;
      await recordCronTriggerFired(env.CONTROL_DB, { ownerSub: owner.owner_sub, triggerId: trigger.id, firedAt });
      await dispatchAutomation(env, { ownerSub: owner.owner_sub, automationId: trigger.automationId, triggerId: trigger.id, triggerType: "cron", idempotencyKey: `cron:${trigger.id}:${dueAt}`, provenance: { source:"cron", triggerId:trigger.id, dueAt, firedAt } });
    }
  }
  await drainAutomationQueue(env);
  await Promise.all([retryAgentWebhookDeliveries(env), retryAutomationDeliveries(env), cleanupExpiredAgentInputAttachments(env)]);
}

export default {
  async fetch(request, env) { try { return await route(request, env as ControlEnv); } catch (error) { const message = error instanceof Error ? error.message : "Unknown error"; console.error(JSON.stringify({ message: "runner request failed", error: message, path: new URL(request.url).pathname })); return json({ error: message }, 500); } },
  async scheduled(controller, env) { await runScheduledAutomations(env as ControlEnv, controller.scheduledTime); },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try { await processArtifactsEvent(env as ControlEnv, message.body); message.ack(); }
      catch (error) { console.error(JSON.stringify({ message:"Artifacts event processing failed", error:error instanceof Error ? error.message : String(error), messageId:message.id })); message.retry(); }
    }
  },
} satisfies ExportedHandler<Env>;
export { ContainerProxy, Sandbox };
