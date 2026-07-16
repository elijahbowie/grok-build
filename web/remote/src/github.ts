import { SignJWT, importPKCS8 } from "jose";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decryptSecret, encryptSecret } from "./connectors";
import { id, now } from "./db";
import { sandboxFor, shell } from "./sandbox-runtime";
import type { ControlEnv, Identity, Project } from "./types";
import { getAutomationTrigger } from "./cloud-automations";
import { dispatchAutomation } from "./automation-runtime";
import { resolveTaskEnvironment } from "./environments";
import { pinTaskSecurityPolicy } from "./security-policy";

type GitHubAppConfig = { id:number; slug:string; pem:string; webhook_secret:string; client_id?:string };
type GitHubAppRow = { owner_sub:string;app_id:string;slug:string;client_id:string|null;encrypted_config_key:string };
type SyncInput = { projectId:string; runId:string; direction:"github-to-artifacts"|"artifacts-to-github" };
type SyncContext = { project:Project;installationId:string;repository:string;artifactSha:string|null;githubSha:string|null;ownerSub:string };

const encoder = new TextEncoder();

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function appConfig(env: ControlEnv, ownerSub: string) {
  const app = await env.CONTROL_DB.prepare("SELECT * FROM github_apps WHERE owner_sub = ?").bind(ownerSub).first<GitHubAppRow>();
  if (!app) throw new Error("GitHub App is not configured");
  const stored = await env.CONNECTOR_SECRETS.get(app.encrypted_config_key);
  if (!stored) throw new Error("GitHub App credentials are unavailable");
  return JSON.parse(await decryptSecret(env, await stored.text())) as GitHubAppConfig;
}

async function appJwt(config: GitHubAppConfig) {
  const key = await importPKCS8(config.pem, "RS256");
  const issuedAt = Math.floor(Date.now() / 1000) - 30;
  return new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 540).setIssuer(String(config.id)).sign(key);
}

export async function installationToken(env: ControlEnv, ownerSub: string, installationId: string) {
  const config = await appConfig(env, ownerSub);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${await appJwt(config)}`, "user-agent": "Grok-Build", "x-github-api-version": "2026-03-10" } });
  if (!response.ok) throw new Error(`GitHub installation token failed (${response.status})`);
  return (await response.json<{token:string}>()).token;
}

const tokenEncoder = new TextEncoder();
function secretBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function tokenBase64(value: Uint8Array) { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function tokenFromBase64(value: string) { const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4); return secretBytes(normalized); }
async function ciSigningKey(env: ControlEnv) { return crypto.subtle.importKey("raw", secretBytes(env.CONNECTOR_ENCRYPTION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function ciLogToken(env: ControlEnv, repairId: string, taskId: string) {
  const payload = tokenBase64(tokenEncoder.encode(JSON.stringify({ repairId, taskId, exp: Math.floor(Date.now() / 1000) + 7200 })));
  const signature = await crypto.subtle.sign("HMAC", await ciSigningKey(env), tokenEncoder.encode(payload));
  return `${payload}.${tokenBase64(new Uint8Array(signature))}`;
}
async function verifyCiLogToken(env: ControlEnv, token: string, repairId: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!await crypto.subtle.verify("HMAC", await ciSigningKey(env), tokenFromBase64(signature), tokenEncoder.encode(payload))) return null;
  const claims = JSON.parse(new TextDecoder().decode(tokenFromBase64(payload))) as {repairId:string;taskId:string;exp:number};
  return claims.repairId === repairId && claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
}

export async function ciRepairInstructions(env: ControlEnv, taskId: string) {
  const repair = await env.CONTROL_DB.prepare("SELECT id, workflow_name, repository_full_name, github_run_id, run_url FROM ci_repairs WHERE task_id = ?").bind(taskId).first<{id:string;workflow_name:string;repository_full_name:string;github_run_id:string;run_url:string|null}>();
  if (!repair) return "";
  const token = await ciLogToken(env, repair.id, taskId);
  const logUrl = `${env.MACHINE_ORIGIN}/github-ci-proxy/${repair.id}/logs`;
  return `\n\nCI repair context: GitHub Actions workflow ${repair.workflow_name} failed for ${repair.repository_full_name} (run ${repair.github_run_id}). Inspect the read-only logs with: curl -fL -H ${shell(`Authorization: Bearer ${token}`)} ${shell(logUrl)} -o /tmp/ci-logs.zip && unzip -o /tmp/ci-logs.zip -d /tmp/ci-logs. Fix only the root cause demonstrated by those logs and rerun the relevant local checks. Run URL: ${repair.run_url || "unavailable"}.`;
}

export async function githubCiLogProxy(request: Request, env: ControlEnv) {
  const match = new URL(request.url).pathname.match(/^\/github-ci-proxy\/([^/]+)\/logs$/);
  if (!match || request.method !== "GET") return json({ error: "CI log route not found" }, 404);
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const claims = await verifyCiLogToken(env, supplied, match[1]);
  if (!claims) return json({ error: "Invalid or expired CI log token" }, 401);
  const repair = await env.CONTROL_DB.prepare("SELECT c.owner_sub, c.github_run_id, c.repository_full_name, g.installation_id FROM ci_repairs c JOIN projects p ON p.id=c.project_id JOIN sync_state s ON s.project_id=p.id JOIN github_connections g ON g.id=s.github_connection_id WHERE c.id = ? AND c.task_id = ?").bind(match[1], claims.taskId).first<{owner_sub:string;github_run_id:string;repository_full_name:string;installation_id:string}>();
  if (!repair) return json({ error: "CI repair context not found" }, 404);
  const response = await fetch(`https://api.github.com/repos/${repair.repository_full_name}/actions/runs/${encodeURIComponent(repair.github_run_id)}/logs`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${await installationToken(env, repair.owner_sub, repair.installation_id)}`, "user-agent": "Grok-Build", "x-github-api-version": "2026-03-10" }, redirect: "follow" });
  if (!response.ok || !response.body) return json({ error: `GitHub CI logs failed (${response.status})` }, 502);
  return new Response(response.body, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="github-actions-${repair.github_run_id}.zip"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

export async function githubManifest(env: ControlEnv, identity: Identity) {
  const state = crypto.randomUUID();
  const timestamp = now();
  await env.CONTROL_DB.prepare("INSERT INTO github_manifest_states (state, owner_sub, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(state, identity.sub, new Date(Date.now() + 3_600_000).toISOString(), timestamp).run();
  const origin = env.PUBLIC_ORIGIN;
  return {
    action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
    manifest: {
      name: "Grok Build Cloud", url: origin, description: "Optional two-way GitHub sync for Grok Build projects", public: false,
      hook_attributes: { url: `${env.MACHINE_ORIGIN}/github/webhook`, active: true }, redirect_url: `${origin}/api/github/manifest/callback`,
      callback_urls: [`${origin}/api/github/installation/callback`], setup_url: `${origin}/?github=installed`, setup_on_update: true,
      default_permissions: { contents: "write", metadata: "read", checks: "read", actions: "read" },
      default_events: ["push", "installation", "installation_repositories", "check_suite", "workflow_run"],
    },
  };
}

export async function githubManifestCallback(request: Request, env: ControlEnv, identity: Identity) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
  const valid = state ? await env.CONTROL_DB.prepare("SELECT * FROM github_manifest_states WHERE state = ? AND owner_sub = ? AND expires_at > ?").bind(state, identity.sub, now()).first() : null;
  if (!code || !valid) return json({ error: "Invalid or expired GitHub manifest callback" }, 400);
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "Grok-Build", "x-github-api-version": "2026-03-10" } });
  if (!response.ok) return json({ error: `GitHub App conversion failed (${response.status})` }, 502);
  const config = await response.json<GitHubAppConfig>();
  const secretKey = `github/apps/${identity.sub}.json.enc`;
  await env.CONNECTOR_SECRETS.put(secretKey, await encryptSecret(env, JSON.stringify(config)), { httpMetadata: { contentType: "application/octet-stream" } });
  const timestamp = now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("INSERT INTO github_apps (owner_sub, app_id, slug, client_id, encrypted_config_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_sub) DO UPDATE SET app_id=excluded.app_id, slug=excluded.slug, client_id=excluded.client_id, encrypted_config_key=excluded.encrypted_config_key, updated_at=excluded.updated_at").bind(identity.sub, String(config.id), config.slug, config.client_id || null, secretKey, timestamp, timestamp),
    env.CONTROL_DB.prepare("DELETE FROM github_manifest_states WHERE state = ?").bind(state),
  ]);
  return Response.redirect(`https://github.com/apps/${config.slug}/installations/new`, 302);
}

async function verifyWebhook(env: ControlEnv, body: string, signature: string) {
  const apps = (await env.CONTROL_DB.prepare("SELECT * FROM github_apps").all<GitHubAppRow>()).results;
  const supplied = signature.startsWith("sha256=") ? signature.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(supplied)) return null;
  const signatureBytes = Uint8Array.from(supplied.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
  for (const app of apps) {
    const config = await appConfig(env, app.owner_sub);
    const key = await crypto.subtle.importKey("raw", encoder.encode(config.webhook_secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body))) return app.owner_sub;
  }
  return null;
}

export async function githubWebhook(request: Request, env: ControlEnv) {
  const body = await request.text();
  const ownerSub = await verifyWebhook(env, body, request.headers.get("x-hub-signature-256") || "");
  if (!ownerSub) return json({ error: "Invalid webhook signature" }, 401);
  const event = request.headers.get("x-github-event") || "";
  const delivery = request.headers.get("x-github-delivery") || crypto.randomUUID();
  const payload = JSON.parse(body) as Record<string, any>;
  if ((event === "push" || event === "pull_request") && payload.repository?.full_name) {
    const triggerIds = await env.CONTROL_DB.prepare("SELECT t.id FROM cloud_automation_triggers t JOIN cloud_automations a ON a.id=t.automation_id WHERE a.owner_sub=? AND a.status='enabled' AND t.type='github' AND t.enabled=1").bind(ownerSub).all<{id:string}>();
    const changedPaths = event === "push" ? [...new Set((Array.isArray(payload.commits) ? payload.commits : []).flatMap((commit:Record<string, unknown>) => [commit.added, commit.modified, commit.removed].flatMap((paths) => Array.isArray(paths) ? paths.map(String) : [])))] : [];
    const branch = event === "push" ? String(payload.ref || "").replace(/^refs\/heads\//, "") : String(payload.pull_request?.base?.ref || "");
    for (const candidate of triggerIds.results) {
      const trigger = await getAutomationTrigger(env.CONTROL_DB, ownerSub, candidate.id);
      if (!trigger) continue;
      await dispatchAutomation(env, {
        ownerSub, automationId:trigger.automationId, triggerId:trigger.id, triggerType:"github",
        idempotencyKey:`github:${delivery}:${trigger.id}`, provenance:{ source:"github", delivery, repository:String(payload.repository.full_name), event, action:payload.action ?? null, branch },
        triggerPayload:{ event, action:payload.action ?? null, branch, changedPaths },
      });
    }
  }
  if (event === "installation" && ["created", "new_permissions_accepted"].includes(String(payload.action))) {
    const timestamp = now();
    await env.CONTROL_DB.prepare("INSERT INTO github_connections (id, owner_sub, installation_id, account_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET account_login=excluded.account_login, updated_at=excluded.updated_at")
      .bind(id("ghc"), ownerSub, String(payload.installation.id), String(payload.installation.account.login), timestamp, timestamp).run();
  }
  if (event === "installation" && payload.action === "deleted") await env.CONTROL_DB.prepare("DELETE FROM github_connections WHERE installation_id = ? AND owner_sub = ?").bind(String(payload.installation.id), ownerSub).run();
  if (event === "push" && payload.repository?.full_name) {
    const states = (await env.CONTROL_DB.prepare("SELECT s.project_id FROM sync_state s JOIN projects p ON p.id=s.project_id WHERE p.owner_sub = ? AND s.repository_full_name = ?").bind(ownerSub, String(payload.repository.full_name)).all<{project_id:string}>()).results;
    for (const state of states) {
      const runId = `sync_gh_${delivery.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}_${state.project_id.slice(-6)}`;
      const timestamp = now();
      const inserted = await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO sync_runs (id, project_id, direction, status, source_sha, created_at, updated_at) VALUES (?, ?, 'github-to-artifacts', 'queued', ?, ?, ?)").bind(runId, state.project_id, payload.after || null, timestamp, timestamp).run();
      if (inserted.meta.changes) await env.GITHUB_SYNC_WORKFLOW.create({ id: runId, params: { projectId: state.project_id, runId, direction: "github-to-artifacts" }, retention: { successRetention: "30 days", errorRetention: "30 days" } });
    }
  }
  if (event === "workflow_run" && payload.action === "completed" && ["failure", "timed_out"].includes(String(payload.workflow_run?.conclusion))) {
    const repository = String(payload.repository?.full_name || "");
    const runId = String(payload.workflow_run?.id || "");
    const headSha = String(payload.workflow_run?.head_sha || "");
    const workflowName = String(payload.workflow_run?.name || "GitHub Actions").slice(0, 160);
    const project = repository ? await env.CONTROL_DB.prepare("SELECT p.*, g.installation_id FROM projects p JOIN sync_state s ON s.project_id=p.id JOIN github_connections g ON g.id=s.github_connection_id WHERE p.owner_sub = ? AND s.repository_full_name = ?").bind(ownerSub, repository).first<Project & {installation_id:string}>() : null;
    const grokCommit = project && headSha ? await env.CONTROL_DB.prepare("SELECT id FROM sync_runs WHERE project_id = ? AND direction = 'artifacts-to-github' AND status = 'completed' AND target_sha = ?").bind(project.id, headSha).first<{id:string}>() : null;
    const duplicate = runId ? await env.CONTROL_DB.prepare("SELECT id FROM ci_repairs WHERE github_run_id = ?").bind(runId).first<{id:string}>() : null;
    const recent = project ? await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM ci_repairs WHERE project_id = ? AND workflow_name = ? AND created_at > ?").bind(project.id, workflowName, new Date(Date.now() - 86_400_000).toISOString()).first<{count:number}>() : null;
    const active = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('queued','preparing','running','repairing')").first<{count:number}>();
    if (project && grokCommit && !duplicate && runId && (recent?.count || 0) < 3 && (active?.count || 0) < Number(env.MAX_CONCURRENT_TASKS)) {
      const taskId = id("tsk"); const workflowId = `task-${taskId}`; const repairId = id("cir"); const timestamp = now();
      const title = `Repair ${workflowName} CI failure`;
      const prompt = `Repair the GitHub Actions failure in ${repository} at commit ${headSha}. Inspect the authenticated CI logs supplied in the cloud task context, reproduce the failure locally, make the smallest correct fix, and run the relevant verification. Do not modify unrelated code or bypass the failing check.`;
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare("INSERT INTO tasks (id, owner_sub, project_id, workflow_id, title, prompt, status, model, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'grok-4.5', 'isolated-write', ?, ?)").bind(taskId, ownerSub, project.id, workflowId, title, prompt, timestamp, timestamp),
        env.CONTROL_DB.prepare("INSERT INTO messages (id, task_id, role, body, created_at) VALUES (?, ?, 'system', ?, ?)").bind(id("msg"), taskId, `Automatic repair for GitHub Actions run ${runId}`, timestamp),
        env.CONTROL_DB.prepare("INSERT INTO task_events (task_id, seq, type, data_json, created_at) VALUES (?, 1, 'task.queued', ?, ?)").bind(taskId, JSON.stringify({ source: "github-actions", runId, headSha }), timestamp),
        env.CONTROL_DB.prepare("INSERT INTO ci_repairs (id, project_id, task_id, github_run_id, workflow_name, repository_full_name, head_sha, run_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)").bind(repairId, project.id, taskId, runId, workflowName, repository, headSha, String(payload.workflow_run?.html_url || "") || null, timestamp, timestamp),
      ]);
      try {
        await Promise.all([
          resolveTaskEnvironment(env.CONTROL_DB, ownerSub, taskId),
          pinTaskSecurityPolicy(env.CONTROL_DB, { taskId, ownerSub }),
        ]);
        await env.TASK_WORKFLOW.create({ id: workflowId, params: { taskId, ownerSub }, retention: { successRetention: "30 days", errorRetention: "30 days" } });
        const stub = env.TASK_HUB.get(env.TASK_HUB.idFromName(ownerSub));
        await stub.fetch("https://task-hub.internal/broadcast", { method: "POST", body: JSON.stringify({ type: "task.queued", taskId, source: "github-actions" }) });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 4000) : "CI repair workflow creation failed";
        await env.CONTROL_DB.batch([
          env.CONTROL_DB.prepare("UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=?").bind(message, now(), taskId),
          env.CONTROL_DB.prepare("UPDATE ci_repairs SET status='failed', updated_at=? WHERE id=?").bind(now(), repairId),
        ]);
      }
    }
  }
  return json({ accepted: true }, 202);
}

export async function linkGitHubProject(env: ControlEnv, identity: Identity, projectId: string, input: {installationId?:string;repository?:string}) {
  const project = await env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_sub = ?").bind(projectId, identity.sub).first<Project>();
  const connection = input.installationId ? await env.CONTROL_DB.prepare("SELECT * FROM github_connections WHERE installation_id = ? AND owner_sub = ?").bind(input.installationId, identity.sub).first() : null;
  if (!project || !connection || !input.repository || !/^[\w.-]+\/[\w.-]+$/.test(input.repository)) throw new Error("Invalid GitHub project link");
  await env.CONTROL_DB.prepare("INSERT INTO sync_state (project_id, github_connection_id, repository_full_name, status, updated_at) VALUES (?, (SELECT id FROM github_connections WHERE installation_id = ?), ?, 'in_sync', ?) ON CONFLICT(project_id) DO UPDATE SET github_connection_id=excluded.github_connection_id, repository_full_name=excluded.repository_full_name, status='in_sync', updated_at=excluded.updated_at")
    .bind(projectId, input.installationId, input.repository, now()).run();
}

async function syncContext(env: ControlEnv, projectId: string): Promise<SyncContext> {
  const row = await env.CONTROL_DB.prepare("SELECT p.*, s.artifact_sha, s.github_sha, s.repository_full_name, g.installation_id FROM projects p JOIN sync_state s ON s.project_id=p.id JOIN github_connections g ON g.id=s.github_connection_id WHERE p.id = ?").bind(projectId).first<Project & {artifact_sha:string|null;github_sha:string|null;repository_full_name:string;installation_id:string}>();
  if (!row) throw new Error("GitHub sync is not configured for this project");
  return { project: row, installationId: row.installation_id, repository: row.repository_full_name, artifactSha: row.artifact_sha, githubSha: row.github_sha, ownerSub: row.owner_sub };
}

async function performSync(env: ControlEnv, input: SyncInput, item: SyncContext) {
  const githubToken = await installationToken(env, item.ownerSub, item.installationId);
  const artifact = await env.ARTIFACTS.get(item.project.artifact_repo);
  const artifactToken = await artifact.createToken("write", 3600);
  const githubRemote = `https://github.com/${item.repository}.git`;
  const sourceIsGitHub = input.direction === "github-to-artifacts";
  const targetRemote = sourceIsGitHub ? artifact.remote : githubRemote;
  const sourceRemote = sourceIsGitHub ? githubRemote : artifact.remote;
  const targetToken = sourceIsGitHub ? artifactToken.plaintext : githubToken;
  const sourceToken = sourceIsGitHub ? githubToken : artifactToken.plaintext;
  const sandbox = sandboxFor(env, input.runId);
  const cwd = "/workspace/sync";
  try {
    const clone = await sandbox.exec(`rm -rf ${shell(cwd)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${targetToken}`)} clone --branch ${shell(item.project.default_branch)} --single-branch ${shell(targetRemote)} ${shell(cwd)}`, { timeout: 180_000 });
    if (!clone.success) throw new Error(`Sync target clone failed: ${clone.stderr.slice(-1200)}`);
    const fetched = await sandbox.exec(`git -c http.extraHeader=${shell(`Authorization: Bearer ${sourceToken}`)} fetch ${shell(sourceRemote)} ${shell(item.project.default_branch)}:refs/remotes/sync/source`, { cwd, timeout: 180_000 });
    if (!fetched.success) throw new Error(`Sync source fetch failed: ${fetched.stderr.slice(-1200)}`);
    const safe = await sandbox.exec("git merge-base --is-ancestor HEAD refs/remotes/sync/source", { cwd });
    if (!safe.success) return { status: "diverged" as const, error: "GitHub and Artifacts diverged; automatic force-push is disabled" };
    const pushed = await sandbox.exec(`git merge --ff-only refs/remotes/sync/source && git -c http.extraHeader=${shell(`Authorization: Bearer ${targetToken}`)} push origin HEAD:${shell(item.project.default_branch)}`, { cwd, timeout: 180_000 });
    if (!pushed.success) throw new Error(`Sync push failed: ${pushed.stderr.slice(-1200)}`);
    const sha = (await sandbox.exec("git rev-parse HEAD", { cwd })).stdout.trim();
    return { status: "completed" as const, sha };
  } finally {
    await artifact.revokeToken(artifactToken.id).catch(() => false);
  }
}

export class GitHubSyncWorkflow extends WorkflowEntrypoint<ControlEnv, SyncInput> {
  async run(event: Readonly<WorkflowEvent<SyncInput>>, step: WorkflowStep) {
    const input = event.payload;
    try {
      const item = await step.do("load sync context", () => syncContext(this.env, input.projectId));
      await step.do("mark sync running", () => this.env.CONTROL_DB.prepare("UPDATE sync_runs SET status='running', updated_at=? WHERE id=?").bind(now(), input.runId).run().then(() => undefined));
      const result = await step.do("safe fast-forward sync", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "15 minutes" }, () => performSync(this.env, input, item));
      await step.do("record sync result", async () => {
        await this.env.CONTROL_DB.batch([
          this.env.CONTROL_DB.prepare("UPDATE sync_runs SET status=?, target_sha=?, error=?, updated_at=? WHERE id=?").bind(result.status, result.sha || null, result.error || null, now(), input.runId),
          this.env.CONTROL_DB.prepare("UPDATE sync_state SET status=?, artifact_sha=CASE WHEN ?='completed' THEN ? ELSE artifact_sha END, github_sha=CASE WHEN ?='completed' THEN ? ELSE github_sha END, last_error=?, updated_at=? WHERE project_id=?").bind(result.status === "completed" ? "in_sync" : "diverged", result.status, result.sha || null, result.status, result.sha || null, result.error || null, now(), input.projectId),
        ]);
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 4000) : "Unknown GitHub sync failure";
      await step.do("record sync failure", () => this.env.CONTROL_DB.prepare("UPDATE sync_runs SET status='failed', error=?, updated_at=? WHERE id=?").bind(message, now(), input.runId).run().then(() => undefined));
      throw error;
    }
  }
}
