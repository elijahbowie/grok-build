import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(process.env.ACP_SDK_PATH || "/usr/local/lib/node_modules/@agentclientprotocol/sdk/dist/acp.js");

const port = 2419;
const config = JSON.parse(await readFile(requiredEnv("GROK_BUILD_ACP_CONFIG"), "utf8"));
const token = (await readFile(requiredEnv("GROK_BUILD_ACP_TOKEN_FILE"), "utf8")).trim();
if (process.getuid?.() === 0) {
  process.setgroups([]);
  process.setgid(10001);
  process.setuid(10001);
}
let runtime = null;
let activePrompt = null;
let events = [];
let finalText = "";
let lastStderr = "";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function authorized(request) {
  return token.length >= 32 && request.headers.authorization === `Bearer ${token}`;
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error("ACP request exceeds 2 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item));
}

async function connect() {
  if (runtime?.child.exitCode === null) return runtime;
  const args = ["--model", config.model, "--sandbox", config.sandboxProfile, ...(config.permissionArgs || [])];
  args.push("agent", "stdio");
  const child = spawn("grok", args, {
    cwd: config.cwd,
    uid: 10001,
    gid: 10001,
    env: { PATH: process.env.PATH, HOME: "/home/grok-agent", ...(config.env || {}), GROK_HOME: config.grokHome, NO_COLOR: "1", GROK_SANDBOX: config.sandboxProfile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16000); lastStderr = stderr; });
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new ClientSideConnection(() => ({
    async requestPermission(params) {
      events.push({ type: "permission", status: "denied", request: serializable(params), at: new Date().toISOString() });
      return { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      const value = serializable(params);
      events.push({ type: "session_update", data: value, at: new Date().toISOString() });
      const update = params.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") finalText += update.content.text;
    },
    async readTextFile() { throw new Error("Client-side ACP file reads are disabled; use the sandboxed Grok file tools"); },
    async writeTextFile() { throw new Error("Client-side ACP file writes are disabled; use the sandboxed Grok file tools"); },
  }), stream);
  const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "grok-build", version: "1" } });
  runtime = { child, connection, initialized, sessionId: null, stderr: () => stderr };
  return runtime;
}

async function run(input) {
  const current = await connect();
  events = [];
  finalText = "";
  if (input.sessionId && current.initialized.agentCapabilities?.loadSession) {
    await current.connection.loadSession({ sessionId: input.sessionId, cwd: config.cwd, mcpServers: [] });
    current.sessionId = input.sessionId;
  } else if (!current.sessionId) {
    current.sessionId = (await current.connection.newSession({ cwd: config.cwd, mcpServers: [], ...(config.maxTurns ? { _meta:{ agentProfile:{ name:"grok-build-bounded", description:"Grok Build task agent", maxTurns:config.maxTurns } } } : {}) })).sessionId;
  }
  if (input.reviewOnly && current.initialized.agentCapabilities?.sessionCapabilities?.modes) {
    await current.connection.setSessionMode({ sessionId: current.sessionId, modeId: "plan" }).catch(() => undefined);
  }
  activePrompt = current.connection.prompt({ sessionId: current.sessionId, prompt: input.promptBlocks || [{ type: "text", text: input.prompt }], ...(config.outputSchema ? { _meta:{ outputSchema:config.outputSchema } } : {}) });
  const result = await activePrompt;
  activePrompt = null;
  const structuredOutput = result._meta?.structuredOutput;
  const structuredOutputError = result._meta?.structuredOutputError;
  const structuredOk = !config.outputSchema || (structuredOutput !== undefined && !structuredOutputError);
  return { ok: result.stopReason === "end_turn" && current.child.exitCode === null && structuredOk, sessionId: current.sessionId, stopReason: result.stopReason, events, finalText, structuredOutput, structuredOutputError, stderr: current.stderr() };
}

createServer(async (request, response) => {
  try {
    if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
    if (request.method === "GET" && request.url === "/healthz") return json(response, 200, { ok: true, sessionId: runtime?.sessionId || null, running: Boolean(activePrompt), runtimeIdentity: config.runtimeIdentity });
    if (request.method === "POST" && request.url === "/run") return json(response, 200, await run(await body(request)));
    if (request.method === "POST" && request.url === "/cancel") {
      if (runtime?.sessionId) await runtime.connection.cancel({ sessionId: runtime.sessionId });
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    activePrompt = null;
    return json(response, 500, { error: error instanceof Error ? error.message : String(error), stderr: runtime?.stderr() || lastStderr });
  }
}).listen(port, "0.0.0.0");
