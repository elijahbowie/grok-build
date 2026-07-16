import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

export async function runAcpTurn({ grokBin, task, prompt, resume, onEvent, onChild }) {
  const child = spawn(grokBin, ["--model", task.model, "agent", "stdio"], {
    cwd: task.worktree,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  onChild(child);
  child.stderr.on("data", (chunk) => onEvent({ type: "stderr", data: chunk.toString() }));

  const client = {
    async requestPermission(params) {
      const detail = JSON.stringify(params.toolCall.rawInput || "");
      const title = params.toolCall.title || "Tool permission";
      const dangerous = /\bgit\s+push\b|\bgh\s+|pull request|publish/i.test(`${title} ${detail}`);
      const desired = dangerous ? ["reject_once", "reject_always"] : ["allow_once", "allow_always"];
      const selected = desired.map((kind) => params.options.find((option) => option.kind === kind)).find(Boolean);
      onEvent({
        type: "permission",
        data: title,
        toolCallId: params.toolCall.toolCallId,
        status: selected && !dangerous ? "approved" : "rejected",
        options: params.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      });
      return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      onEvent(mapAcpUpdate(params.update));
    },
  };

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new ClientSideConnection(() => client, stream);
  try {
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { terminal: false, plan: {} },
      clientInfo: { name: "Grok Build Web", version: "0.2.0" },
      _meta: { startupHints: { nonInteractive: true }, clientType: "grok-build-web" },
    });
    const auth = initialized.authMethods?.find((method) => method.id === "xai.api_key")
      || initialized.authMethods?.find((method) => method.id === "cached_token");
    if (auth) await connection.authenticate({ methodId: auth.id, _meta: { headless: true } });

    let sessionId = task.sessionId;
    if (resume && sessionId && initialized.agentCapabilities?.loadSession) {
      await connection.loadSession({ sessionId, cwd: task.worktree, mcpServers: [] });
    } else {
      const created = await connection.newSession({ cwd: task.worktree, mcpServers: [], _meta: { modelId: task.model } });
      sessionId = created.sessionId;
    }
    if (task.permissionMode === "review-only") await connection.setSessionMode({ sessionId, modeId: "plan" });
    const response = await connection.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
    return { sessionId, stopReason: response.stopReason, response, child };
  } finally {
    child.kill("SIGTERM");
  }
}

export function mapAcpUpdate(update) {
  const base = { protocol: "acp", acpUpdate: update.sessionUpdate };
  if (update.sessionUpdate === "agent_message_chunk") {
    return { ...base, type: "text", data: update.content?.type === "text" ? update.content.text : `[${update.content?.type || "content"}]`, messageId: update.messageId };
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    return { ...base, type: "thought", data: update.content?.type === "text" ? update.content.text : "Reasoning update", messageId: update.messageId };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return {
      ...base,
      type: "tool_call",
      data: update.title || "Tool call updated",
      toolCallId: update.toolCallId,
      status: update.status || (update.sessionUpdate === "tool_call" ? "pending" : "in_progress"),
      kind: update.kind || "other",
      locations: update.locations || [],
      content: sanitizeToolContent(update.content),
    };
  }
  if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
    return { ...base, type: "plan", data: "Plan updated", entries: update.entries || update.plan || [] };
  }
  if (update.sessionUpdate === "usage_update") {
    return { ...base, type: "usage", data: "Usage updated", usage: update };
  }
  if (update.sessionUpdate === "available_commands_update") {
    return { ...base, type: "capabilities", data: `${update.availableCommands?.length || 0} commands available`, commands: (update.availableCommands || []).map(({ name, description }) => ({ name, description })) };
  }
  return { ...base, type: "acp", data: update.sessionUpdate, update };
}

function sanitizeToolContent(content) {
  if (!Array.isArray(content)) return [];
  return content.slice(-20).map((item) => {
    if (item?.type === "content" && item.content?.type === "text") return { type: "text", text: item.content.text };
    if (item?.type === "diff") return { type: "diff", path: item.path };
    if (item?.type === "terminal") return { type: "terminal", terminalId: item.terminalId };
    return { type: item?.type || "content" };
  });
}
