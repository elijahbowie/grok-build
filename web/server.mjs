import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { runAcpTurn } from "./acp-client.mjs";

const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.env.GROK_WEB_REPO || join(webRoot, ".."));
const dataRoot = resolve(process.env.GROK_WEB_DATA || join(repoRoot, ".grok-web"));
const worktreeRoot = join(dataRoot, "worktrees");
const stateFile = join(dataRoot, "state.json");
const remoteConfigFile = join(dataRoot, "remote.json");
const grokBin = process.env.GROK_BIN || "grok";
const grokProtocol = process.env.GROK_WEB_PROTOCOL || "acp";
const authToken = process.env.GROK_WEB_AUTH_TOKEN || "";
const authCookie = authToken ? createHash("sha256").update(authToken).digest("hex") : "";
const port = Number(process.env.PORT || 4173);
const isProduction = process.env.NODE_ENV === "production";

await mkdir(worktreeRoot, { recursive: true });

const state = await loadState();
const remoteRunner = await loadRemoteConfig();
const processes = new Map();
const previewProcesses = new Map();
const eventClients = new Map();
let saveChain = Promise.resolve();
let automationTimer;

for (const task of state.tasks) {
  if (["queued", "running", "paused"].includes(task.status)) {
    task.status = "interrupted";
    task.error = "The local service restarted before this run completed. Send a follow-up to resume the Grok session.";
  }
}
await saveState();

let vite;
if (!isProduction) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({ root: webRoot, server: { middlewareMode: true }, appType: "spa" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      if (!url.pathname.startsWith("/api/auth/") && !isAuthorized(req)) {
        sendJson(res, 401, { error: "Authentication required" });
        return;
      }
      await handleApi(req, res, url);
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => sendJson(res, 404, { error: "Not found" }));
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Grok Build Web running at http://127.0.0.1:${port}`);
  console.log(`Repository: ${repoRoot}`);
  automationTimer = setInterval(() => void runDueAutomations(), 60_000);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  clearInterval(automationTimer);
  for (const child of processes.values()) child.kill("SIGINT");
  for (const child of previewProcesses.values()) child.kill("SIGTERM");
  if (vite) await vite.close();
  await saveState();
  server.close(() => process.exit(0));
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const parts = url.pathname.split("/").filter(Boolean).slice(1);

  if (method === "GET" && parts[0] === "auth" && parts[1] === "status") {
    sendJson(res, 200, { enabled: Boolean(authToken), authenticated: isAuthorized(req) });
    return;
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "login") {
    const input = await readBody(req); const supplied = String(input.token || input.password || "");
    const expectedEmail = String(process.env.GROK_WEB_AUTH_EMAIL || "").trim().toLowerCase();
    const suppliedEmail = String(input.email || "").trim().toLowerCase();
    if (!authToken || (expectedEmail && suppliedEmail !== expectedEmail) || !safeEqual(supplied, authToken)) {
      sendJson(res, 401, { error: "Invalid access token" });
      return;
    }
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `grok_web_session=${authCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
    sendJson(res, 200, { authenticated: true });
    return;
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "logout") {
    res.setHeader("Set-Cookie", "grok_web_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    sendJson(res, 200, { authenticated: false });
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "bootstrap") {
    const [branch, origin, grokVersion, grokModels, ghStatus, remoteStatus] = await Promise.all([
      command("git", ["branch", "--show-current"], repoRoot),
      command("git", ["remote", "get-url", "origin"], repoRoot),
      command(grokBin, ["--version"], repoRoot),
      command(grokBin, ["models"], repoRoot),
      command("gh", ["auth", "status"], repoRoot),
      probeRemoteRunner(),
    ]);
    sendJson(res, 200, {
      repository: { path: repoRoot, name: repoName(origin.stdout) || repoName(repoRoot), branch: branch.stdout.trim() || "main", remote: origin.stdout.trim() },
      capabilities: {
        grok: grokVersion.ok,
        grokVersion: grokVersion.stdout.trim() || grokVersion.stderr.trim(),
        models: parseModels(grokModels.stdout),
        github: ghStatus.ok,
        git: true,
        streaming: true,
        worktrees: true,
        terminal: true,
        previews: true,
        resumableSessions: true,
        remoteRunner: remoteStatus,
      },
      tasks: state.tasks.filter((task) => !task.archived).map((task) => publicTask(task)),
      settings: state.settings,
      automations: state.automations,
    });
    return;
  }

  if (method === "GET" && parts[0] === "tasks" && parts.length === 2) {
    sendJson(res, 200, publicTask(requireTask(parts[1]), true));
    return;
  }

  if (method === "GET" && parts[0] === "tasks" && parts[2] === "events") {
    const task = requireTask(parts[1]);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: task\ndata: ${JSON.stringify(publicTask(task, true))}\n\n`);
    const clients = eventClients.get(task.id) || new Set();
    clients.add(res);
    eventClients.set(task.id, clients);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (method === "GET" && parts[0] === "tasks" && parts[2] === "diff") {
    sendJson(res, 200, await gitDiff(requireTask(parts[1])));
    return;
  }

  if (method === "GET" && parts[0] === "tasks" && parts[2] === "file") {
    const task = requireTask(parts[1]);
    const requested = url.searchParams.get("path") || "";
    const path = safeWorktreePath(task, requested);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("File cannot be previewed");
    sendJson(res, 200, { path: requested, content: await readFile(path, "utf8"), size: info.size });
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "tasks") {
    const task = await createTask(await readBody(req));
    sendJson(res, 201, publicTask(task, true));
    return;
  }

  if (parts[0] === "cloud" && parts[1] === "auth") {
    if (method === "GET") { sendJson(res, 200, await callRemote("/v1/auth/status", {})); return; }
    if (method === "POST" && parts[2] === "device") { sendJson(res, 202, await callRemote("/v1/auth/device", {})); return; }
    if (method === "DELETE") { sendJson(res, 200, await callRemote("/v1/auth", {}, { method: "DELETE" })); return; }
  }

  if (method === "POST" && parts[0] === "tasks" && parts[2] === "followups") {
    const task = requireTask(parts[1]);
    const body = await readBody(req);
    if (!body.prompt?.trim()) throw new Error("A follow-up prompt is required");
    if (processes.has(task.id)) throw new Error("This task is already running");
    task.messages.push({ role: "user", text: body.prompt.trim(), at: now() });
    void runGrok(task, body.prompt.trim(), true);
    sendJson(res, 202, publicTask(task, true));
    return;
  }

  if (method === "POST" && parts[0] === "tasks" && ["pause", "resume", "cancel"].includes(parts[2])) {
    const task = requireTask(parts[1]);
    await controlTask(task, parts[2]);
    await saveAndBroadcast(task);
    sendJson(res, 200, publicTask(task, true));
    return;
  }

  if (method === "POST" && parts[0] === "tasks" && parts[2] === "terminal") {
    const task = requireTask(parts[1]);
    const body = await readBody(req);
    if (!body.command?.trim()) throw new Error("A command is required");
    const startedAt = Date.now();
    const result = await command("/bin/zsh", ["-lc", body.command], task.worktree, { timeoutMs: 120_000 });
    const run = { id: randomUUID(), command: redact(body.command), stdout: redact(result.stdout), stderr: redact(result.stderr), exitCode: result.code, durationMs: Date.now() - startedAt, at: now() };
    task.terminalRuns.push(run);
    await refreshTask(task);
    await saveAndBroadcast(task);
    sendJson(res, 200, run);
    return;
  }

  if (method === "POST" && parts[0] === "tasks" && parts[2] === "preview") {
    const task = requireTask(parts[1]);
    const body = await readBody(req);
    sendJson(res, 200, await startPreview(task, body.command));
    return;
  }

  if (method === "DELETE" && parts[0] === "tasks" && parts[2] === "preview") {
    const task = requireTask(parts[1]);
    if (task.executionTarget === "remote") {
      await callRemote("/v1/preview", { taskId: task.id, port: task.preview?.port }, { method: "DELETE" });
      if (task.preview) task.preview.status = "stopped";
      await saveAndBroadcast(task);
      sendJson(res, 200, task.preview);
      return;
    }
    const child = previewProcesses.get(task.id);
    if (child) child.kill("SIGTERM");
    previewProcesses.delete(task.id);
    if (task.preview) task.preview.status = "stopped";
    await saveAndBroadcast(task);
    sendJson(res, 200, task.preview);
    return;
  }

  if (method === "POST" && parts[0] === "tasks" && parts[2] === "pull-request") {
    sendJson(res, 200, await openPullRequest(requireTask(parts[1]), await readBody(req)));
    return;
  }

  if (method === "DELETE" && parts[0] === "tasks" && parts.length === 2) {
    const task = requireTask(parts[1]);
    if (processes.has(task.id)) throw new Error("Stop the active agent before archiving this task");
    task.archived = true;
    task.archivedAt = now();
    await saveAndBroadcast(task);
    sendJson(res, 200, { archived: true, undoUntil: Date.now() + 10_000 });
    return;
  }

  if (method === "POST" && parts[0] === "tasks" && parts[2] === "restore") {
    const task = requireTask(parts[1]);
    task.archived = false;
    delete task.archivedAt;
    await saveAndBroadcast(task);
    sendJson(res, 200, publicTask(task, true));
    return;
  }

  if (method === "GET" && parts[0] === "settings") {
    const [mcp, plugins, skills] = await Promise.all([
      command(grokBin, ["mcp", "list", "--json"], repoRoot),
      command(grokBin, ["plugin", "list", "--json"], repoRoot),
      discoverSkills(),
    ]);
    sendJson(res, 200, { settings: state.settings, mcp: parseMaybeJson(mcp.stdout, []), plugins: parseMaybeJson(plugins.stdout, []), skills });
    return;
  }

  if (method === "PATCH" && parts[0] === "settings") {
    state.settings = { ...state.settings, ...(await readBody(req)) };
    await saveState();
    sendJson(res, 200, state.settings);
    return;
  }

  if (method === "POST" && parts[0] === "connectors" && parts[1] === "mcp" && parts.length === 2) {
    const body = await readBody(req);
    if (!body.name?.trim() || !body.target?.trim()) throw new Error("Connector name and command or URL are required");
    const transport = ["stdio", "http", "sse"].includes(body.transport) ? body.transport : "stdio";
    const scope = body.scope === "project" ? "project" : "user";
    const args = ["mcp", "add", "--transport", transport, "--scope", scope, body.name.trim()];
    for (const value of body.env || []) if (value?.trim()) args.push("--env", value.trim());
    for (const value of body.headers || []) if (value?.trim()) args.push("--header", value.trim());
    if (transport === "stdio") args.push("--", body.target.trim(), ...(body.args || []).filter(Boolean));
    else args.push(body.target.trim());
    const result = await command(grokBin, args, repoRoot, { timeoutMs: 120_000 });
    if (!result.ok) throw new Error(redact(result.stderr || result.stdout));
    sendJson(res, 201, { configured: true, name: body.name.trim(), transport, scope });
    return;
  }

  if (method === "DELETE" && parts[0] === "connectors" && parts[1] === "mcp" && parts[2]) {
    const args = ["mcp", "remove", decodeURIComponent(parts[2])];
    const scope = url.searchParams.get("scope");
    if (["user", "project"].includes(scope)) args.push("--scope", scope);
    const result = await command(grokBin, args, repoRoot);
    if (!result.ok) throw new Error(redact(result.stderr || result.stdout));
    sendJson(res, 200, { removed: true });
    return;
  }

  if (method === "POST" && parts[0] === "connectors" && parts[1] === "mcp" && parts[3] === "doctor") {
    const result = await command(grokBin, ["mcp", "doctor", decodeURIComponent(parts[2]), "--json"], repoRoot, { timeoutMs: 120_000 });
    sendJson(res, result.ok ? 200 : 422, parseMaybeJson(result.stdout, { ok: result.ok, output: redact(result.stdout), error: redact(result.stderr) }));
    return;
  }

  if (method === "POST" && parts[0] === "connectors" && parts[1] === "plugins" && parts.length === 2) {
    const body = await readBody(req);
    if (!body.source?.trim()) throw new Error("A plugin Git URL, shorthand, or local path is required");
    if (body.confirmed !== true) throw new Error("Plugin trust must be explicitly confirmed");
    const result = await command(grokBin, ["plugin", "install", "--trust", body.source.trim()], repoRoot, { timeoutMs: 180_000 });
    if (!result.ok) throw new Error(redact(result.stderr || result.stdout));
    sendJson(res, 201, { installed: true });
    return;
  }

  if (method === "POST" && parts[0] === "connectors" && parts[1] === "plugins" && parts[2] && ["enable", "disable"].includes(parts[3])) {
    const result = await command(grokBin, ["plugin", parts[3], decodeURIComponent(parts[2])], repoRoot);
    if (!result.ok) throw new Error(redact(result.stderr || result.stdout));
    sendJson(res, 200, { updated: true });
    return;
  }

  if (method === "DELETE" && parts[0] === "connectors" && parts[1] === "plugins" && parts[2]) {
    const result = await command(grokBin, ["plugin", "uninstall", "--confirm", decodeURIComponent(parts[2])], repoRoot, { timeoutMs: 120_000 });
    if (!result.ok) throw new Error(redact(result.stderr || result.stdout));
    sendJson(res, 200, { removed: true });
    return;
  }

  if (method === "POST" && parts[0] === "automations" && parts.length === 1) {
    const body = await readBody(req);
    if (!body.name?.trim() || !body.prompt?.trim()) throw new Error("Automation name and prompt are required");
    const schedule = ["manual", "hourly", "daily"].includes(body.schedule) ? body.schedule : "manual";
    const automation = { id: randomUUID(), name: body.name.trim(), prompt: body.prompt.trim(), schedule, enabled: body.enabled !== false, createdAt: now(), lastRunAt: null, nextRunAt: nextAutomationRun(schedule) };
    state.automations.unshift(automation);
    await saveState();
    sendJson(res, 201, automation);
    return;
  }

  if (method === "POST" && parts[0] === "automations" && parts[2] === "run") {
    const automation = state.automations.find((item) => item.id === parts[1]);
    if (!automation) throw new Error("Automation not found");
    automation.lastRunAt = now();
    automation.nextRunAt = nextAutomationRun(automation.schedule);
    const task = await createTask({ prompt: automation.prompt, title: automation.name, source: "automation" });
    await saveState();
    sendJson(res, 202, publicTask(task, true));
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

async function createTask(input) {
  if (!input.prompt?.trim()) throw new Error("A task prompt is required");
  const id = randomUUID();
  const title = (input.title || input.prompt).trim().replace(/\s+/g, " ").slice(0, 72);
  const branch = `grok-web/${slug(title)}-${id.slice(0, 6)}`;
  const worktree = join(worktreeRoot, id);
  const baseBranch = input.baseBranch || state.settings.baseBranch || "main";
  const created = await command("git", ["worktree", "add", "-b", branch, worktree, baseBranch], repoRoot, { timeoutMs: 120_000 });
  if (!created.ok) throw new Error(`Could not create isolated worktree: ${created.stderr || created.stdout}`);
  const task = {
    id, title, prompt: input.prompt.trim(), source: input.source || "user", status: "queued",
    branch, baseBranch, worktree, model: input.model || state.settings.model, executionTarget: input.executionTarget === "remote" ? "remote" : "local",
    permissionMode: input.permissionMode || state.settings.permissionMode,
    createdAt: now(), updatedAt: now(), sessionId: null, stopReason: null, error: null,
    messages: [{ role: "user", text: input.prompt.trim(), at: now() }],
    events: [], terminalRuns: [], changedFiles: [], additions: 0, deletions: 0,
    archived: false, pr: null, preview: null,
  };
  state.tasks.unshift(task);
  await saveState();
  void runGrok(task, task.prompt, false);
  return task;
}

async function runGrok(task, prompt, resume) {
  if (task.executionTarget === "remote") return runRemote(task, prompt, resume);
  if (grokProtocol === "headless") return runHeadless(task, prompt, resume);
  task.status = "running";
  task.error = null;
  task.updatedAt = now();
  addEvent(task, { type: "status", protocol: "acp", data: resume ? "Resuming Grok ACP session" : "Opening Grok ACP session in isolated worktree" });
  await saveAndBroadcast(task);
  let completed = false;
  try {
    const result = await runAcpTurn({
      grokBin, task, prompt, resume,
      onChild: (child) => processes.set(task.id, child),
      onEvent: (event) => addEvent(task, { ...event, data: redact(String(event.data || "")) }),
    });
    task.sessionId = result.sessionId;
    task.stopReason = result.stopReason || null;
    completed = true;
  } catch (error) {
    if (task.status !== "cancelled") {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    processes.delete(task.id);
    await refreshTask(task);
    if (completed && task.status !== "cancelled") {
      task.status = "review";
      addEvent(task, { type: "status", protocol: "acp", data: "Grok finished; changes are ready for review" });
    }
    await saveAndBroadcast(task);
  }
}

async function runRemote(task, prompt, resume) {
  if (!remoteRunner) throw new Error("The hosted runner is not configured");
  task.status = "running"; task.error = null; task.updatedAt = now();
  addEvent(task, { type: "status", protocol: "remote", data: "Provisioning authenticated Cloudflare sandbox" });
  await saveAndBroadcast(task);
  const controller = new AbortController();
  processes.set(task.id, { kill: () => { controller.abort(); void callRemote("/v1/cancel", { taskId: task.id }).catch(() => {}); } });
  let completed = false;
  try {
    const origin = await command("git", ["remote", "get-url", "origin"], repoRoot);
    const result = await callRemote("/v1/run", { taskId: task.id, repository: origin.stdout.trim(), baseBranch: task.baseBranch, branch: task.branch, prompt, model: task.model, permissionMode: task.permissionMode, sessionId: resume ? task.sessionId : undefined }, { signal: controller.signal, timeoutMs: 960_000 });
    for (const event of result.events || []) consumeGrokLine(task, JSON.stringify(event));
    if (result.patch) {
      await command("git", ["reset", "--hard", "HEAD"], task.worktree);
      await command("git", ["clean", "-fd"], task.worktree);
      const applied = await command("git", ["apply", "--binary", "--whitespace=nowarn", "-"], task.worktree, { timeoutMs: 120_000, input: result.patch });
      if (!applied.ok) throw new Error(`Could not import the remote patch: ${applied.stderr || applied.stdout}`);
    }
    task.sessionId = result.sessionId || task.sessionId; completed = true;
  } catch (error) {
    if (task.status !== "cancelled") { task.status = "failed"; task.error = error instanceof Error ? error.message : String(error); }
  } finally {
    processes.delete(task.id); await refreshTask(task);
    if (completed && task.status !== "cancelled") {
      task.status = "review";
      addEvent(task, { type: "status", protocol: "remote", data: "Hosted run finished; its patch is ready locally for review" });
    }
    await saveAndBroadcast(task);
  }
}

async function runHeadless(task, prompt, resume) {
  task.status = "running";
  task.error = null;
  task.updatedAt = now();
  addEvent(task, { type: "status", data: resume ? "Resuming Grok session" : "Starting Grok in isolated worktree" });
  await saveAndBroadcast(task);
  const readOnly = task.permissionMode === "review-only";
  const args = ["--single", prompt, "--cwd", task.worktree, "--output-format", "streaming-json", "--model", task.model, "--sandbox", "workspace", "--permission-mode", readOnly ? "plan" : "bypassPermissions"];
  if (readOnly) args.push("--deny", "Edit", "--deny", "Write", "--deny", "Bash(*)");
  else args.push("--deny", "Bash(git push*)", "--deny", "Bash(gh *)");
  if (resume && task.sessionId) args.push("--resume", task.sessionId);
  const child = spawn(grokBin, args, { cwd: task.worktree, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  processes.set(task.id, child);
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) consumeGrokLine(task, line);
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) addEvent(task, { type: "stderr", data: redact(line) });
  });
  child.on("error", async (error) => {
    task.status = "failed";
    task.error = error.message;
    processes.delete(task.id);
    await saveAndBroadcast(task);
  });
  child.on("close", async (code, signal) => {
    if (stdoutBuffer.trim()) consumeGrokLine(task, stdoutBuffer);
    if (stderrBuffer.trim()) addEvent(task, { type: "stderr", data: redact(stderrBuffer) });
    processes.delete(task.id);
    if (task.status === "cancelled") {
      addEvent(task, { type: "status", data: "Run cancelled by user" });
    } else if (code === 0 && !task.error) {
      task.status = "running";
    } else {
      task.status = "failed";
      task.error = task.error || `Grok exited with code ${code}${signal ? ` (${signal})` : ""}`;
    }
    await refreshTask(task);
    if (code === 0 && !task.error && task.status !== "cancelled") {
      task.status = "review";
      addEvent(task, { type: "status", data: "Grok finished; changes are ready for review" });
    }
    await saveAndBroadcast(task);
  });
}

function consumeGrokLine(task, line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    if (event.type === "end") {
      task.sessionId = event.sessionId || task.sessionId;
      task.stopReason = event.stopReason || null;
      task.usage = event.usage || null;
      task.modelUsage = event.modelUsage || null;
      task.cost = event.total_cost_usd ?? null;
    } else if (event.type === "error") {
      task.error = event.message || "Grok reported an error";
    }
    if (event.type !== "thought") addEvent(task, { ...event, data: redact(String(event.data || event.message || "")) });
  } catch {
    addEvent(task, { type: "log", data: redact(line) });
  }
}

async function controlTask(task, action) {
  const child = processes.get(task.id);
  if (!child) throw new Error("This task has no active process");
  if (task.executionTarget === "remote" && action !== "cancel") throw new Error("Hosted runs can be stopped, but not paused");
  if (action === "pause") {
    child.kill("SIGSTOP");
    task.status = "paused";
    addEvent(task, { type: "status", data: "Agent paused" });
  } else if (action === "resume") {
    child.kill("SIGCONT");
    task.status = "running";
    addEvent(task, { type: "status", data: "Agent resumed" });
  } else {
    task.status = "cancelled";
    child.kill("SIGINT");
  }
}

async function refreshTask(task) {
  const [statusResult, committedNames, committedNumstat, workingNumstat] = await Promise.all([
    command("git", ["status", "--short"], task.worktree),
    command("git", ["diff", "--name-status", `${task.baseBranch}...HEAD`], task.worktree),
    command("git", ["diff", "--numstat", `${task.baseBranch}...HEAD`], task.worktree),
    command("git", ["diff", "--numstat"], task.worktree),
  ]);
  const statusLines = statusResult.stdout.split("\n").filter(Boolean);
  const files = new Map();
  for (const line of committedNames.stdout.split("\n").filter(Boolean)) {
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts.at(-1);
    if (path) files.set(path, { path, status });
  }
  for (const line of statusLines) {
    const path = line.slice(3).trim().split(" -> ").at(-1);
    if (path) files.set(path, { path, status: line.slice(0, 2).trim() || "M" });
  }
  const numstat = new Map([...committedNumstat.stdout.split("\n"), ...workingNumstat.stdout.split("\n")].filter(Boolean).map((line) => {
    const [add, del, ...path] = line.split("\t");
    return [path.join("\t"), { additions: Number(add) || 0, deletions: Number(del) || 0 }];
  }));
  task.changedFiles = await Promise.all([...files.values()].map(async (file) => {
    const { path } = file;
    let counts = numstat.get(path) || { additions: 0, deletions: 0 };
    if (file.status === "??") {
      try { counts = { additions: (await readFile(safeWorktreePath(task, path), "utf8")).split("\n").length, deletions: 0 }; } catch {}
    }
    return { ...file, ...counts };
  }));
  task.additions = task.changedFiles.reduce((sum, file) => sum + file.additions, 0);
  task.deletions = task.changedFiles.reduce((sum, file) => sum + file.deletions, 0);
  task.updatedAt = now();
}

async function gitDiff(task) {
  const result = await command("git", ["diff", "--no-ext-diff", "--unified=3", `${task.baseBranch}...HEAD`], task.worktree, { maxBuffer: 5_000_000 });
  const working = await command("git", ["diff", "--no-ext-diff", "--unified=3"], task.worktree, { maxBuffer: 5_000_000 });
  const untracked = [];
  for (const file of task.changedFiles.filter((item) => item.status === "??")) {
    const value = await command("git", ["diff", "--no-index", "--", "/dev/null", file.path], task.worktree, { maxBuffer: 5_000_000 });
    if (value.stdout) untracked.push(value.stdout);
  }
  return { patch: [result.stdout, working.stdout, ...untracked].filter(Boolean).join("\n"), files: task.changedFiles, baseBranch: task.baseBranch, branch: task.branch };
}

async function runDueAutomations() {
  const due = state.automations.filter((item) => item.enabled && item.schedule !== "manual" && item.nextRunAt && new Date(item.nextRunAt).getTime() <= Date.now());
  for (const automation of due) {
    automation.lastRunAt = now();
    automation.nextRunAt = nextAutomationRun(automation.schedule);
    try { await createTask({ prompt: automation.prompt, title: automation.name, source: "automation" }); }
    catch (error) { automation.lastError = error instanceof Error ? error.message : String(error); }
  }
  if (due.length) await saveState();
}

async function startPreview(task, providedCommand) {
  if (task.executionTarget === "remote") {
    if (!remoteRunner) throw new Error("The hosted runner is not configured");
    const previewPort = 4173;
    const detected = providedCommand || await detectPreviewCommand(task.worktree, previewPort, "0.0.0.0");
    if (!detected) throw new Error("No supported preview command was detected. Provide one explicitly.");
    task.preview = await callRemote("/v1/preview", { taskId: task.id, command: detected, port: previewPort }, { timeoutMs: 180_000 });
    task.preview.hosted = true; task.preview.logs = [];
    await saveAndBroadcast(task);
    return task.preview;
  }
  if (previewProcesses.has(task.id)) return task.preview;
  const previewPort = await openPort(4300 + Math.floor(Math.random() * 400));
  const detected = providedCommand || await detectPreviewCommand(task.worktree, previewPort, "127.0.0.1");
  if (!detected) throw new Error("No supported preview command was detected. Provide one explicitly.");
  const child = spawn("/bin/zsh", ["-lc", detected], { cwd: task.worktree, env: { ...process.env, PORT: String(previewPort) }, stdio: ["ignore", "pipe", "pipe"] });
  previewProcesses.set(task.id, child);
  task.preview = { url: `http://127.0.0.1:${previewPort}`, command: detected, status: "starting", logs: [] };
  const collect = (kind) => (chunk) => {
    task.preview.logs.push({ kind, data: redact(chunk.toString()), at: now() });
    task.preview.logs = task.preview.logs.slice(-100);
    task.preview.status = "running";
    void saveAndBroadcast(task);
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  child.on("close", (code) => {
    previewProcesses.delete(task.id);
    task.preview.status = "stopped";
    task.preview.exitCode = code;
    void saveAndBroadcast(task);
  });
  await saveAndBroadcast(task);
  return task.preview;
}

async function detectPreviewCommand(worktree, previewPort, host) {
  for (const directory of ["", "web", "frontend", "client", "app"]) {
    try {
      const pkg = JSON.parse(await readFile(join(worktree, directory, "package.json"), "utf8"));
      const prefix = directory ? `cd ${directory} && ` : "";
      if (pkg.scripts?.dev) return `${prefix}npm install && npm run dev -- --host ${host} --port ${previewPort}`;
      if (pkg.scripts?.start) return `${prefix}npm install && PORT=${previewPort} npm start`;
    } catch {}
  }
  return null;
}

async function openPullRequest(task, input) {
  if (!task.changedFiles.length) throw new Error("There are no changes to publish");
  if (processes.has(task.id)) throw new Error("Stop or finish the agent before publishing changes");
  const commitMessage = input.commitMessage || task.title;
  let result = await command("git", ["add", "-A"], task.worktree);
  if (!result.ok) throw new Error(result.stderr);
  result = await command("git", ["commit", "-m", commitMessage], task.worktree, { timeoutMs: 120_000 });
  if (!result.ok && !result.stderr.includes("nothing to commit")) throw new Error(result.stderr || result.stdout);
  result = await command("git", ["push", "-u", "origin", task.branch], task.worktree, { timeoutMs: 120_000 });
  if (!result.ok) throw new Error(`Push failed: ${result.stderr || result.stdout}`);
  const body = redact(input.body || `Created by Grok Build Web.\n\nTask: ${task.prompt}\n\nReview the diff and checks before merging.`);
  result = await command("gh", ["pr", "create", "--base", task.baseBranch, "--head", task.branch, "--title", input.title || task.title, "--body", body], task.worktree, { timeoutMs: 120_000 });
  if (!result.ok) throw new Error(`Pull request creation failed: ${result.stderr || result.stdout}`);
  task.pr = { url: result.stdout.trim(), title: input.title || task.title, state: "open", createdAt: now() };
  task.status = "published";
  await saveAndBroadcast(task);
  return task.pr;
}

async function discoverSkills() {
  const roots = [join(repoRoot, ".agents", "skills"), join(repoRoot, ".grok", "skills")];
  const skills = [];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.push({ name: entry.name, path: join(root, entry.name) });
      }
    } catch {}
  }
  return skills;
}

function addEvent(task, event) {
  const previous = task.events.at(-1);
  if (["text", "thought"].includes(event.type) && previous?.type === event.type && previous?.messageId === event.messageId && previous?.protocol === event.protocol) {
    previous.data = `${previous.data || ""}${event.data || ""}`;
    previous.at = now();
    task.updatedAt = previous.at;
    broadcast(task);
    return;
  }
  task.events.push({ id: randomUUID(), at: now(), ...event });
  task.events = task.events.slice(-1000);
  task.updatedAt = now();
  broadcast(task);
}

function broadcast(task) {
  const payload = `event: task\ndata: ${JSON.stringify(publicTask(task, true))}\n\n`;
  for (const client of eventClients.get(task.id) || []) client.write(payload);
}

async function saveAndBroadcast(task) {
  await saveState();
  broadcast(task);
}

function publicTask(task, detailed = false) {
  const base = {
    id: task.id, title: task.title, prompt: task.prompt, source: task.source, status: task.status,
    branch: task.branch, baseBranch: task.baseBranch, model: task.model, permissionMode: task.permissionMode, executionTarget: task.executionTarget || "local",
    createdAt: task.createdAt, updatedAt: task.updatedAt, sessionId: task.sessionId, stopReason: task.stopReason,
    error: task.error, additions: task.additions, deletions: task.deletions, changedFiles: task.changedFiles,
    pr: task.pr, preview: task.preview ? { ...task.preview, logs: detailed ? task.preview.logs : undefined } : null,
    usage: task.usage || null, cost: task.cost ?? null,
  };
  return detailed ? { ...base, messages: task.messages, events: task.events, terminalRuns: task.terminalRuns } : base;
}

function requireTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("Task not found");
  return task;
}

function safeWorktreePath(task, requested) {
  const candidate = resolve(task.worktree, requested);
  if (candidate !== task.worktree && !candidate.startsWith(`${task.worktree}${sep}`)) throw new Error("Path escapes the task worktree");
  return candidate;
}

async function loadState() {
  try { return normalizeState(JSON.parse(await readFile(stateFile, "utf8"))); }
  catch { return normalizeState({}); }
}

async function loadRemoteConfig() {
  try {
    const value = JSON.parse(await readFile(remoteConfigFile, "utf8"));
    return value.url && value.token ? { url: String(value.url).replace(/\/$/, ""), token: String(value.token) } : null;
  } catch { return null; }
}

async function probeRemoteRunner() {
  if (!remoteRunner) return { available: false, authenticated: false, authStatus: "not-configured", status: "not-configured" };
  try {
    const value = await callRemote("/v1/health", {}, { timeoutMs: 150_000 });
    return { available: Boolean(value.ok), authenticated: Boolean(value.subscription?.authenticated), authStatus: value.subscription?.status || "unknown", status: value.ok ? "ready" : "unavailable", compute: value.compute || "Cloudflare Sandbox" };
  } catch (error) {
    return { available: false, authenticated: false, authStatus: "unavailable", status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

async function callRemote(path, payload, options = {}) {
  if (!remoteRunner) throw new Error("The hosted runner is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);
  if (options.signal) options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(`${remoteRunner.url}${path}`, { method: options.method || "POST", headers: { Authorization: `Bearer ${remoteRunner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Hosted runner failed (${response.status})`);
    return value;
  } finally { clearTimeout(timer); }
}

function normalizeState(value) {
  const tasks = Array.isArray(value.tasks) ? value.tasks.map((task) => ({ ...task, model: ["grok-build", "grok-build-0.1"].includes(task.model) ? "grok-4.5" : task.model })) : [];
  const settings = { model: "grok-4.5", permissionMode: "isolated-write", baseBranch: "main", theme: "dark", ...value.settings };
  if (["grok-build", "grok-build-0.1"].includes(settings.model)) settings.model = "grok-4.5";
  return {
    version: 1,
    tasks,
    automations: Array.isArray(value.automations) ? value.automations.map((item) => ({ ...item, nextRunAt: item.nextRunAt || nextAutomationRun(item.schedule) })) : [],
    settings,
  };
}

async function saveState() {
  saveChain = saveChain.catch(() => {}).then(async () => {
    await mkdir(dataRoot, { recursive: true });
    const temp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2));
    await rename(temp, stateFile);
  });
  return saveChain;
}

function command(bin, args, cwd, options = {}) {
  return new Promise((resolveCommand) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const max = options.maxBuffer || 1_000_000;
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-max); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-max); });
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : null;
    if (options.input !== undefined) child.stdin.end(options.input);
    child.on("error", (error) => resolveCommand({ ok: false, code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveCommand({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function serveStatic(res, pathname) {
  const dist = join(webRoot, "dist");
  let path = resolve(dist, `.${pathname}`);
  if (!path.startsWith(dist)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    await access(path);
  } catch { path = join(dist, "index.html"); }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
  res.writeHead(200, { "Content-Type": `${types[extname(path)] || "application/octet-stream"}; charset=utf-8` });
  createReadStream(path).pipe(res);
}

function repoName(value) {
  const cleaned = String(value || "").trim().replace(/\.git$/, "");
  return cleaned.split(/[/:]/).filter(Boolean).slice(-2).join("/");
}

function isAuthorized(req) {
  if (!authToken) return true;
  const cookie = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith("grok_web_session="));
  const cookieValue = cookie?.slice("grok_web_session=".length) || "";
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return safeEqual(cookieValue, authCookie) || safeEqual(bearer, authToken);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 34) || "task"; }
function nextAutomationRun(schedule) { const delay = schedule === "hourly" ? 3_600_000 : schedule === "daily" ? 86_400_000 : 0; return delay ? new Date(Date.now() + delay).toISOString() : null; }
function parseMaybeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function parseModels(value) { return [...value.matchAll(/^\s*[-*]\s+([^\s(]+)(?:\s+\(default\))?/gm)].map((match) => match[1]); }
function redact(value) { return value.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "").replace(/(gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]+)/g, "[REDACTED]"); }
function now() { return new Date().toISOString(); }

async function openPort(start) {
  const { createServer: createNetServer } = await import("node:net");
  for (let candidate = start; candidate < start + 100; candidate += 1) {
    const free = await new Promise((resolveFree) => {
      const probe = createNetServer();
      probe.once("error", () => resolveFree(false));
      probe.once("listening", () => probe.close(() => resolveFree(true)));
      probe.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
  }
  throw new Error("No preview port is available");
}
