import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { appendEvent, now, updateTask, workflowTask } from "./db";
import { broadcast } from "./api";
import { ensureDesktop, grokHome, loadSubscription, persistSubscription, sandboxFor, shell } from "./sandbox-runtime";
import type { ControlEnv, Project, Task, TaskWorkflowInput } from "./types";
import { connectorProxyToken, type Connector } from "./connectors";
import { ciRepairInstructions } from "./github";
import { createReviewRun } from "./review";
import { closeContainerSession, containerCostMicros, extractAgentUsage, openContainerSession, recordUsageEvent } from "./usage";
import { resolveTaskEnvironment, type ResolvedTaskEnvironment } from "./environments";
import { acknowledgePlanMessages, completePlanExecution, deliverQueuedPlanMessages, getTaskPlan, releasePlanMessages, requirePlanRecovery, transitionPlanStep } from "./plan-mode";
import { acknowledgeSubagentSteers, blockSubagent, claimPendingSubagentSteers, completeSubagentWithHandoff, failSubagent, releaseSubagentSteers, startReadySubagents } from "./subagents";
import { createTaskAttentionEvent } from "./notifications";
import { discoverRepositoryRules, resolvePromptContext } from "./rules-memory";
import { updateAutomationRun } from "./cloud-automations";
import { resolveEnvironmentSecretValues, secretValues } from "./environment-secrets";
import { getTaskSecurityPolicy, redactSecurityText } from "./security-policy";
import { applyJobToolContract, assertStrictSandboxFilesystemPolicy, nativePermissionConfig, permissionCliArgs } from "./runtime-security";
import { drainAutomationQueue } from "./automation-runtime";
import { deliverAutomationEvent } from "./automation-delivery";
import { indexTaskForSearch } from "./knowledge-collaboration";
import { deliverAgentWebhookEvent } from "./agent-webhooks";
import { runAcpPrompt } from "./acp-runtime";
import { prepareTaskRuntime } from "./task-runtime";
import { resolveModelProfile } from "./model-profiles";
import { resolveTaskInputAttachments } from "./agent-jobs";
import { emitTaskTelemetry } from "./telemetry";

type TaskContext = { task: Task; project: Project; environment: ResolvedTaskEnvironment };
type RunResult = { ok: boolean; exitCode: number; sessionId: string | null; stderr: string; evidenceKey: string; finalText:string; structuredOutput?:unknown };

const browserEvidenceTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", json: "application/json", txt: "text/plain",
};

function artifactCode(error: unknown) {
  return error instanceof Error && "code" in error ? String((error as ArtifactsError).code) : null;
}

async function context(env: ControlEnv, input: TaskWorkflowInput): Promise<TaskContext> {
  const task = await workflowTask(env.CONTROL_DB, input.taskId, input.ownerSub);
  if (!task) throw new Error("Task no longer exists");
  const project = await env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_sub = ?").bind(task.project_id, input.ownerSub).first<Project>();
  if (!project) throw new Error("Project no longer exists");
  const environment = await resolveTaskEnvironment(env.CONTROL_DB, input.ownerSub, task.id);
  return { task, project, environment };
}

async function taskFork(env: ControlEnv, item: TaskContext, sourceArtifactRepo = item.project.artifact_repo, sourceHeadSha?:string) {
  const name = `task-${item.task.id.replace(/^tsk_/, "").slice(0, 40)}`;
  let remote: string;
  let token: string;
  try {
    const forked = await (await env.ARTIFACTS.get(sourceArtifactRepo)).fork(name, { description: `Task: ${item.task.title}` });
    remote = forked.remote;
    token = forked.token;
  } catch (error) {
    if (artifactCode(error) !== "ALREADY_EXISTS") throw error;
    const repo = await env.ARTIFACTS.get(name);
    const minted = await repo.createToken("write", 7200);
    remote = repo.remote;
    token = minted.plaintext;
  }
  return { name, remote, token, branch:sourceHeadSha ? `session-${item.task.id.replace(/^tsk_/, "").slice(0, 40)}` : item.project.default_branch, sourceHeadSha };
}

function tomlString(value:string) { return JSON.stringify(value); }

async function runtimeDigest(value:unknown) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

function modelConfig(profile:Awaited<ReturnType<typeof resolveModelProfile>>, alias:string) {
  const backend = profile.backend === "openai-responses" ? "responses" : profile.backend === "anthropic" ? "messages" : "chat_completions";
  const lines = [`[model.${tomlString(alias)}]`, `model = ${tomlString(profile.modelId)}`, `name = ${tomlString(profile.name)}`, `base_url = ${tomlString(profile.baseUrl!)}`, `api_backend = ${tomlString(backend)}`];
  if (profile.contextWindow) lines.push(`context_window = ${profile.contextWindow}`);
  if (profile.backend === "anthropic" && profile.credential) lines.push(`extra_headers = { "x-api-key" = ${tomlString(profile.credential)}, "anthropic-version" = "2023-06-01" }`);
  else if (profile.credential) lines.push('env_key = "GROK_BUILD_MODEL_API_KEY"');
  return `${lines.join("\n")}\n`;
}

function bytesToBase64(bytes:Uint8Array) {
  let binary = "";
  for (let index=0; index<bytes.length; index+=0x8000) binary += String.fromCharCode(...bytes.subarray(index, index+0x8000));
  return btoa(binary);
}

async function attachmentPromptBlocks(env:ControlEnv, task:Task, sandbox:ReturnType<typeof sandboxFor>, prompt:string) {
  const attachments = await resolveTaskInputAttachments(env.CONTROL_DB, task.owner_sub, task.id);
  const blocks:Array<Record<string,unknown>> = [{type:"text",text:prompt}];
  for (const attachment of attachments) {
    const object = await env.EVIDENCE_BUCKET.get(attachment.r2Key);
    if (!object) throw new Error(`Task input ${attachment.id} is unavailable`);
    const data = bytesToBase64(new Uint8Array(await object.arrayBuffer()));
    if (attachment.kind === "image") blocks.push({type:"image",data,mimeType:attachment.contentType,uri:`grok-build-input:${attachment.id}`});
    else blocks.push({type:"resource",resource:{blob:data,mimeType:attachment.contentType,uri:`grok-build-input:${attachment.id}`}});
  }
  return blocks;
}

function taskDirectory(item: TaskContext) {
  const target = item.environment.repositories.find((repository) => repository.id === item.environment.targetRepositoryId);
  if (!target) throw new Error("Pinned task environment has no target repository");
  return `/workspace/${target.checkoutPath}`;
}

async function prepareEnvironment(env: ControlEnv, item: TaskContext, fork: {remote:string;token:string;branch:string;sourceHeadSha?:string}) {
  const sandbox = sandboxFor(env, item.task.id);
  const targetDirectory = taskDirectory(item);
  const marker = `/workspace/.grok-environment-${item.environment.manifestHash}`;
  if ((await sandbox.exec(`test -f ${shell(marker)} && test -d ${shell(`${targetDirectory}/.git`)}`)).success) return targetDirectory;
  await sandbox.exec("mkdir -p /workspace", { timeout: 30_000 });
  for (const repository of item.environment.repositories) {
    const directory = `/workspace/${repository.checkoutPath}`;
    if (repository.id === item.environment.targetRepositoryId) {
      const clone = await sandbox.exec(`rm -rf ${shell(directory)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${fork.token}`)} clone ${fork.sourceHeadSha ? "" : `--branch ${shell(repository.ref)} --single-branch `}${shell(fork.remote)} ${shell(directory)}`, { timeout: 180_000 });
      if (!clone.success) throw new Error(`Writable environment repository failed to clone: ${clone.stderr.slice(-1200)}`);
      if (fork.sourceHeadSha) {
        const checkout = await sandbox.exec(`git cat-file -e ${shell(`${fork.sourceHeadSha}^{commit}`)} && git checkout -B ${shell(fork.branch)} ${shell(fork.sourceHeadSha)} && test "$(git rev-parse HEAD)" = ${shell(fork.sourceHeadSha)}`, { cwd:directory,timeout:120_000 });
        if (!checkout.success) throw new Error("Retained session source SHA is unavailable in the source task repository");
      }
    } else if (repository.sourceType === "github") {
      const clone = await sandbox.exec(`rm -rf ${shell(directory)} && git clone --branch ${shell(repository.ref)} --single-branch ${shell(repository.sourceUrl!)} ${shell(directory)}`, { timeout: 180_000 });
      if (!clone.success) throw new Error(`Environment repository ${repository.name} failed to clone: ${clone.stderr.slice(-1200)}`);
    } else {
      const source = await env.ARTIFACTS.get(repository.name);
      const token = await source.createToken("read", 1800);
      try {
        const clone = await sandbox.exec(`rm -rf ${shell(directory)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${token.plaintext}`)} clone --branch ${shell(repository.ref)} --single-branch ${shell(source.remote)} ${shell(directory)}`, { timeout: 180_000 });
        if (!clone.success) throw new Error(`Environment repository ${repository.name} failed to clone: ${clone.stderr.slice(-1200)}`);
      } finally { await source.revokeToken(token.id).catch(() => false); }
    }
    if (repository.pinnedSha) {
      const checkout = await sandbox.exec(`git checkout --detach ${shell(repository.pinnedSha)} && test "$(git rev-parse HEAD)" = ${shell(repository.pinnedSha)}`, { cwd: directory, timeout: 120_000 });
      if (!checkout.success) throw new Error(`Environment repository ${repository.name} did not resolve to its pinned SHA`);
    }
    if (!repository.writable) await sandbox.exec("chmod -R a-w .", { cwd: directory, timeout: 120_000 });
  }
  await sandbox.exec("git config user.name 'Grok Build' && git config user.email 'grok-build@users.noreply.github.com'", { cwd: targetDirectory });
  const setupOutput: string[] = [];
  const setupSecrets = await resolveEnvironmentSecretValues(env, item.environment.secrets, "setup");
  for (const command of item.environment.manifest.setup) {
    const result = await sandbox.exec(command, { cwd: targetDirectory, timeout: 900_000, env: { CI: "1", NO_COLOR: "1", ...setupSecrets } });
    setupOutput.push(redactSecurityText(`$ ${command}\n${result.stdout}\n${result.stderr}`, secretValues(setupSecrets)));
    if (!result.success) throw new Error(`Environment setup failed: ${redactSecurityText(result.stderr.slice(-1200) || result.stdout.slice(-1200), secretValues(setupSecrets))}`);
  }
  const setupBody = setupOutput.join("\n");
  await env.EVIDENCE_BUCKET.put(`tasks/${item.task.id}/environment-setup.txt`, setupBody, { httpMetadata: { contentType: "text/plain" } });
  await sandbox.writeFile(marker, `${item.environment.environmentVersionId}\n${item.environment.manifestHash}\n`);
  return targetDirectory;
}

async function repositoryRuleContext(sandbox: ReturnType<typeof sandboxFor>, cwd: string) {
  const listed = await sandbox.exec("find . -type f \\( -name AGENTS.md -o -path './.grok/rules/*.md' \\) -print | sort | head -100", { cwd, timeout: 30_000 });
  if (!listed.success) return "";
  const files: Array<{path:string;content:string}> = [];
  for (const rawPath of listed.stdout.split("\n").filter(Boolean)) {
    const path = rawPath.replace(/^\.\//, "");
    const value = await sandbox.readFile(`${cwd}/${path}`);
    if (value.success) files.push({ path, content: value.content });
  }
  const repositoryRules = discoverRepositoryRules(files);
  return resolvePromptContext({ rules: [], repositoryRules: repositoryRules.rules, repositoryPath: "repository", privacyMode: true }).content;
}

async function persistAcpConversation(db:D1Database, taskId:string, attempt:number, acp:{events:Array<Record<string,unknown>>;finalText:string;structuredOutput?:unknown;stopReason:string}, secrets:string[]) {
  const messages:Array<{role:"tool"|"assistant";body:string}> = [];
  for (const event of acp.events) {
    if (event.type!=="session_update" || !event.data || typeof event.data!=="object") continue;
    const update=(event.data as {update?:{sessionUpdate?:string}}).update;
    if (update?.sessionUpdate!=="tool_call" && update?.sessionUpdate!=="tool_call_update") continue;
    messages.push({role:"tool",body:redactSecurityText(JSON.stringify(update).slice(0,20_000),secrets)});
  }
  const structured=acp.structuredOutput===undefined ? null : JSON.stringify(acp.structuredOutput);
  const finalText=redactSecurityText((acp.finalText || structured || "").trim().slice(0,100_000),secrets);
  if (finalText) messages.push({role:"assistant",body:finalText});
  const base=Date.now();
  for (const [index,message] of messages.entries()) {
    const digest=await runtimeDigest({taskId,attempt,index,role:message.role,body:message.body});
    await db.prepare("INSERT OR IGNORE INTO messages (id,task_id,role,body,created_at) VALUES (?,?,?,?,?)")
      .bind(`msg_acp_${digest.slice(0,32)}`,taskId,message.role,message.body,new Date(base+index).toISOString()).run();
  }
  await db.prepare("UPDATE tasks SET final_response=?,structured_output_json=?,final_stop_reason=?,updated_at=? WHERE id=?")
    .bind(finalText || null,structured ? redactSecurityText(structured,secrets) : null,acp.stopReason,now(),taskId).run();
}

async function runAgent(env: ControlEnv, item: TaskContext, fork: {name:string;remote:string;token:string;branch:string;sourceHeadSha?:string}, prompt: string, attempt: number, sessionId: string | null): Promise<RunResult> {
  const sandbox = sandboxFor(env, item.task.id);
  if (!await loadSubscription(env, sandbox)) throw new Error("Cloud Grok subscription is signed out");
  const cwd = await prepareEnvironment(env, item, fork);
  const desktop = await ensureDesktop(sandbox, item.task.id);
  const activeStarted = Date.now();
  const runtimeSecrets = await resolveEnvironmentSecretValues(env, item.environment.secrets, "runtime");
  const policy = await getTaskSecurityPolicy(env.CONTROL_DB, item.task.owner_sub, item.task.id);
  if (!policy) throw new Error("Task has no pinned security policy");
  assertStrictSandboxFilesystemPolicy(policy.policy,cwd);
  const containerSessionId = await openContainerSession(env.CONTROL_DB, { ownerSub:item.task.owner_sub, projectId:item.project.id, taskId:item.task.id, sandboxId:`grok-${item.task.id}`, instanceType:"standard-3", wakeReason:`agent-attempt-${attempt}` });
  let result:{success:boolean;exitCode:number;stdout:string;stderr:string;sessionId:string|null;finalText:string;structuredOutput?:unknown};
  let permissions = nativePermissionConfig(policy.policy, item.task.permission_mode === "review-only");
  const deniedTools = JSON.parse(item.task.denied_tools_json || "[]") as string[];
  const allowedTools = JSON.parse(item.task.allowed_tools_json || "[]") as string[];
  permissions = applyJobToolContract(permissions, allowedTools, deniedTools, item.task.web_search_mode);
  let sensitiveModelConfig:string|null = null;
  try {
    const profile = item.task.model_profile_id ? await resolveModelProfile(env, item.task.owner_sub, item.project.id, item.task.model_profile_id) : null;
    const runtimeModel = profile ? `managed-${profile.id.replace(/[^A-Za-z0-9_-]/g, "-")}` : item.task.model;
    const prepared = await prepareTaskRuntime({ db:env.CONTROL_DB, sandbox, taskId:item.task.id, projectId:item.project.id, ownerSub:item.task.owner_sub, cwd, baseGrokHome:grokHome, model:item.task.model });
    if (profile) {
      sensitiveModelConfig = `${prepared.grokHome}/config.toml`;
      await sandbox.writeFile(sensitiveModelConfig, modelConfig(profile, runtimeModel));
      await sandbox.exec(`chmod 400 ${shell(sensitiveModelConfig)}`);
      const inspected = await sandbox.exec("grok inspect --json", {cwd,timeout:60_000,env:{GROK_HOME:prepared.grokHome,NO_COLOR:"1"}});
      if (!inspected.success) throw new Error(`Managed model profile is invalid: ${(inspected.stderr || inspected.stdout).slice(-1200)}`);
    }
    await appendEvent(env.CONTROL_DB, item.task.id, "runtime.prepared", { policyDigest:prepared.policyDigest, extensionDigests:prepared.extensionDigests, modelProfileId:item.task.model_profile_id });
    const mcp = await sandbox.exec("grok mcp add --transport http --scope user playwright http://127.0.0.1:8931/mcp", { cwd, env: { GROK_HOME: prepared.grokHome, NO_COLOR: "1" } });
    if (!mcp.success) throw new Error(`Playwright MCP setup failed: ${mcp.stderr.slice(-800)}`);
    const connectors = (await env.CONTROL_DB.prepare("SELECT c.* FROM connectors c JOIN project_connectors pc ON pc.connector_id = c.id WHERE pc.project_id = ? AND c.enabled = 1 AND pc.read_allowed = 1").bind(item.project.id).all<Connector>()).results;
    for (const connector of connectors) {
      const proxyToken = await connectorProxyToken(env, connector.id, item.task.id);
      const name = connector.label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || connector.id;
      const command = `grok mcp add --transport ${shell(connector.kind)} --scope user ${shell(name)} ${shell(`${env.MACHINE_ORIGIN}/mcp-proxy/${connector.id}`)} --header ${shell(`Authorization: Bearer ${proxyToken}`)}`;
      const configured = await sandbox.exec(command, { cwd, env: { GROK_HOME: prepared.grokHome, NO_COLOR: "1" } });
      if (!configured.success) throw new Error(`MCP connector ${connector.label} failed to configure: ${configured.stderr.slice(-800)}`);
    }
    const promptPath = `/workspace/task-${attempt}.txt`;
    const repositoryContext = item.environment.repositories.map((repository) => `- ${repository.checkoutPath}: ${repository.writable ? "writable task target" : "read-only context"}${repository.pinnedSha ? ` at ${repository.pinnedSha}` : ""}`).join("\n");
    const repositoryRules = await repositoryRuleContext(sandbox, cwd);
    const contract = `${item.task.max_turns ? `\nMaximum agent turns: ${item.task.max_turns}.` : ""}${item.task.output_schema_json ? `\nReturn the final result in this required JSON Schema: ${item.task.output_schema_json}` : ""}${item.task.web_search_mode === "require" ? "\nUse web search and cite the sources used." : ""}`;
    const verificationPrompt = `${prompt}${contract}${repositoryRules ? `\n\nRepository rules discovered from the pinned checkout:\n${repositoryRules}` : ""}${await ciRepairInstructions(env, item.task.id)}\n\nPinned environment ${item.environment.environmentVersionId}:\n${repositoryContext}\n\nWrite only in ${cwd}. Treat sibling repositories as read-only context. Cloud verification: if this task changes a user-facing application, use the Playwright MCP server to exercise the changed flow in the headed browser. Save concise screenshots or video evidence in /workspace/playwright-evidence. Do not claim success until the relevant checks pass.`;
    await sandbox.writeFile(promptPath, verificationPrompt);
    await emitTaskTelemetry(env, {name:"agent.attempt.started",attributes:{taskId:item.task.id,projectId:item.project.id,modelProfileId:item.task.model_profile_id || undefined,modelBackend:profile?.backend || "grok-subscription",permissionMode:item.task.permission_mode}});
    const acp = await runAcpPrompt(sandbox, item.task.id, { cwd, grokHome:prepared.grokHome, model:runtimeModel, prompt:verificationPrompt, promptBlocks:await attachmentPromptBlocks(env,item.task,sandbox,verificationPrompt), permissionArgs:permissionCliArgs(permissions), sessionId, reviewOnly:item.task.permission_mode === "review-only", env:{...runtimeSecrets,...(profile?.credential && profile.backend !== "anthropic" ? {GROK_BUILD_MODEL_API_KEY:profile.credential} : {})}, maxTurns:item.task.max_turns, outputSchema:item.task.output_schema_json ? JSON.parse(item.task.output_schema_json) as Record<string,unknown> : null, runtimeIdentity:JSON.stringify({policyDigest:prepared.policyDigest,extensionDigests:prepared.extensionDigests,modelProfileDigest:profile ? await runtimeDigest(profile) : null}), deniedPaths:policy.policy.filesystem.deniedPaths });
    const resultEvent={type:"agent_result",data:{stopReason:acp.stopReason,finalText:acp.finalText,structuredOutput:acp.structuredOutput,structuredOutputError:acp.structuredOutputError}};
    const stdout = [...acp.events.map((event) => JSON.stringify(event)),JSON.stringify(resultEvent)].join("\n");
    result = { success:acp.ok, exitCode:acp.ok ? 0 : 1, stdout, stderr:acp.stderr, sessionId:acp.sessionId, finalText:acp.finalText, structuredOutput:acp.structuredOutput };
    await persistAcpConversation(env.CONTROL_DB,item.task.id,attempt,acp,secretValues(runtimeSecrets));
    await emitTaskTelemetry(env, {name:"agent.attempt.finished",level:acp.ok?"INFO":"ERROR",attributes:{taskId:item.task.id,projectId:item.project.id,status:acp.ok?"completed":"failed",modelProfileId:item.task.model_profile_id || undefined,modelBackend:profile?.backend || "grok-subscription",durationMs:Date.now()-activeStarted}});
  } finally {
    if (sensitiveModelConfig) await sandbox.exec(`rm -f ${shell(sensitiveModelConfig)}`).catch(() => undefined);
    await desktop.kill().catch(() => undefined);
    const activeMilliseconds = Date.now() - activeStarted;
    await closeContainerSession(env.CONTROL_DB, { sessionId:containerSessionId, activeMilliseconds, state:"sleeping" });
    await recordUsageEvent(env.CONTROL_DB, {
      ownerSub:item.task.owner_sub, projectId:item.project.id, taskId:item.task.id,
      category:"container", meter:"standard-3-active", quantity:activeMilliseconds, unit:"milliseconds",
      costMicros:containerCostMicros(activeMilliseconds, Number(env.STANDARD_3_COST_PER_HOUR_MICROS || 0)), source:"cloudflare-sandbox",
      idempotencyKey:`container:${item.task.id}:${attempt}`, metadata:{ sleepAfter:"30s", stateAfterRun:"sleeping" },
    });
  }
  await persistSubscription(env, sandbox);
  const evidenceKey = `tasks/${item.task.id}/agent-attempt-${attempt}.jsonl`;
  const evidenceBody = redactSecurityText(`${result.stdout}\n${result.stderr ? JSON.stringify({ type: "stderr", data: result.stderr }) : ""}`, secretValues(runtimeSecrets));
  await env.EVIDENCE_BUCKET.put(evidenceKey, evidenceBody, { httpMetadata: { contentType: "application/x-ndjson" } });
  const createdAt = now();
  const expiresAt = new Date(Date.now() + Number(env.TASK_RETENTION_DAYS) * 86_400_000).toISOString();
  await env.CONTROL_DB.prepare("INSERT OR REPLACE INTO evidence (id, task_id, kind, r2_key, content_type, size_bytes, metadata_json, created_at, expires_at) VALUES (?, ?, 'agent-log', ?, 'application/x-ndjson', ?, ?, ?, ?)")
    .bind(`ev_${item.task.id}_${attempt}`, item.task.id, evidenceKey, new TextEncoder().encode(evidenceBody).byteLength, JSON.stringify({ attempt, exitCode: result.exitCode }), createdAt, expiresAt).run();
  const usage = extractAgentUsage(result.stdout);
  if (usage.totalTokens || usage.costMicros) await recordUsageEvent(env.CONTROL_DB, {
    ownerSub:item.task.owner_sub, projectId:item.project.id, taskId:item.task.id,
    category:"model", meter:"tokens", quantity:usage.totalTokens, unit:"tokens", costMicros:usage.costMicros, model:item.task.model,
    source:"grok-streaming-json", idempotencyKey:`model:${item.task.id}:${attempt}`,
    metadata:{ inputTokens:usage.inputTokens, outputTokens:usage.outputTokens },
  });
  return { ok: result.success, exitCode: result.exitCode, sessionId: result.sessionId ?? sessionId, stderr: redactSecurityText(result.stderr.slice(-4000), secretValues(runtimeSecrets)), evidenceKey, finalText:result.finalText, structuredOutput:result.structuredOutput };
}

async function checkpointLatestUserMessage(db:D1Database,taskId:string,headSha:string,sessionId:string|null,executionPrompt:string) {
  if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new Error("Task result has no valid conversation checkpoint SHA");
  const message=await db.prepare("SELECT id FROM messages WHERE task_id=? AND role='user' ORDER BY created_at DESC,id DESC LIMIT 1").bind(taskId).first<{id:string}>();
  if (!message) throw new Error("Task has no user message to checkpoint");
  await db.prepare(`INSERT INTO task_message_checkpoints (message_id,task_id,head_sha,acp_session_id,execution_prompt,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET head_sha=excluded.head_sha,acp_session_id=excluded.acp_session_id,execution_prompt=excluded.execution_prompt,created_at=excluded.created_at`)
    .bind(message.id,taskId,headSha,sessionId,executionPrompt,now()).run();
}

async function harvestBrowserEvidence(env: ControlEnv, item: TaskContext) {
  const sandbox = sandboxFor(env, item.task.id);
  const listed = await sandbox.listFiles("/workspace/playwright-evidence", { recursive: true, includeHidden: false });
  if (!listed.success) return [];
  const files = listed.files
    .filter((file) => file.type === "file" && file.size > 0 && file.size <= 50_000_000)
    .map((file) => ({ ...file, extension: file.name.split(".").pop()?.toLowerCase() || "" }))
    .filter((file) => browserEvidenceTypes[file.extension])
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .slice(0, 20);
  const timestamp = now();
  const expiresAt = new Date(Date.now() + Number(env.TASK_RETENTION_DAYS) * 86_400_000).toISOString();
  const indexed: {id:string;name:string;kind:string;contentType:string;size:number}[] = [];
  for (const [index, file] of files.entries()) {
    const safeName = file.relativePath.replace(/^\/+/, "").replace(/[^a-zA-Z0-9._/-]/g, "_");
    const evidenceId = `ev_${item.task.id}_browser_${index}`;
    const key = `tasks/${item.task.id}/browser/${safeName}`;
    const contentType = browserEvidenceTypes[file.extension];
    await env.EVIDENCE_BUCKET.put(key, await sandbox.readFileStream(file.absolutePath), { httpMetadata: { contentType } });
    await env.CONTROL_DB.prepare("INSERT OR REPLACE INTO evidence (id, task_id, kind, r2_key, content_type, size_bytes, metadata_json, created_at, expires_at) VALUES (?, ?, 'browser-artifact', ?, ?, ?, ?, ?, ?)")
      .bind(evidenceId, item.task.id, key, contentType, file.size, JSON.stringify({ name: safeName }), timestamp, expiresAt).run();
    indexed.push({ id: evidenceId, name: safeName, kind: "browser-artifact", contentType, size: file.size });
  }
  return indexed;
}

async function verify(env: ControlEnv, item: TaskContext) {
  const sandbox = sandboxFor(env, item.task.id);
  let config: { verifyCommand?: string } = {};
  try { config = JSON.parse(item.project.config_json) as { verifyCommand?: string }; } catch { /* invalid optional config falls back safely */ }
  const commands = item.environment.manifest.validation.length ? item.environment.manifest.validation : [config.verifyCommand?.trim() || "git diff --check"];
  const outputs: string[] = [];
  const runtimeSecrets = await resolveEnvironmentSecretValues(env, item.environment.secrets, "runtime");
  let successful = true;
  for (const itemCommand of commands) {
    const result = await sandbox.exec(itemCommand, { cwd: taskDirectory(item), timeout: 900_000, env: { CI: "1", NO_COLOR: "1", ...runtimeSecrets } });
    outputs.push(redactSecurityText(`$ ${itemCommand}\n${result.stdout}\n${result.stderr}`, secretValues(runtimeSecrets)));
    if (!result.success) { successful = false; break; }
  }
  const command = commands.join(" && ");
  const key = `tasks/${item.task.id}/verification.txt`;
  const body = outputs.join("\n");
  await env.EVIDENCE_BUCKET.put(key, body, { httpMetadata: { contentType: "text/plain" } });
  return { ok: successful, command, output: body.slice(-12_000), evidenceKey: key };
}

async function pushAndBackup(env: ControlEnv, item: TaskContext, fork: {name:string;remote:string;token:string;branch:string;sourceHeadSha?:string}) {
  const sandbox = sandboxFor(env, item.task.id);
  const cwd = taskDirectory(item);
  const changed = await sandbox.exec("test -n \"$(git status --porcelain)\"", { cwd });
  const base = await sandbox.exec("git rev-parse HEAD", { cwd });
  if (!base.success) throw new Error(`Task base SHA lookup failed: ${base.stderr.slice(-800)}`);
  await sandbox.exec("git add -N .", { cwd });
  const [patch, numstat, names] = await Promise.all([
    sandbox.exec("git diff --binary --no-ext-diff HEAD", { cwd, timeout: 120_000 }),
    sandbox.exec("git diff --numstat HEAD", { cwd }),
    sandbox.exec("git diff --name-status HEAD", { cwd }),
  ]);
  const patchKey = `tasks/${item.task.id}/changes.patch`;
  await env.EVIDENCE_BUCKET.put(patchKey, patch.stdout, { httpMetadata: { contentType: "text/x-diff" } });
  const stats = new Map(numstat.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [add, del, ...path] = line.split("\t");
    return [path.join("\t"), { additions: Number(add) || 0, deletions: Number(del) || 0 }] as const;
  }));
  const changedFiles = names.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [status, ...path] = line.split("\t");
    const filePath = path.at(-1) || "";
    return { path: filePath, status, additions: stats.get(filePath)?.additions ?? 0, deletions: stats.get(filePath)?.deletions ?? 0 };
  });
  const additions = changedFiles.reduce((total, file) => total + file.additions, 0);
  const deletions = changedFiles.reduce((total, file) => total + file.deletions, 0);
  if (changed.success) {
    const pushed = await sandbox.exec(`git add -A && git commit -m ${shell(`Grok Build: ${item.task.title}`)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${fork.token}`)} push origin HEAD:${shell(fork.branch)}`, { cwd, timeout: 180_000 });
    if (!pushed.success) throw new Error(`Task fork push failed: ${pushed.stderr.slice(-1200)}`);
  }
  const sha = await sandbox.exec("git rev-parse HEAD", { cwd });
  const readable = await sandbox.exec("chmod -R a+rX /workspace", { timeout: 120_000 });
  if (!readable.success) throw new Error(`Workspace backup preparation failed: ${readable.stderr.slice(-800)}`);
  const backup = await sandbox.createBackup({ dir: "/workspace", name: item.task.id, ttl: Number(env.TASK_RETENTION_DAYS) * 86_400, gitignore: true, excludes: item.environment.repositories.map((repository) => `${repository.checkoutPath}/node_modules`).concat("*.log") });
  const timestamp = now();
  const expiresAt = new Date(Date.now() + Number(env.TASK_RETENTION_DAYS) * 86_400_000).toISOString();
  await env.CONTROL_DB.prepare("INSERT OR REPLACE INTO evidence (id, task_id, kind, r2_key, content_type, metadata_json, created_at, expires_at) VALUES (?, ?, 'sandbox-backup', ?, 'application/vnd.cloudflare.sandbox-backup', ?, ?, ?)")
    .bind(`ev_${item.task.id}_backup`, item.task.id, `backups/${backup.id}`, JSON.stringify({ id: backup.id, dir: backup.dir }), timestamp, expiresAt).run();
  await env.CONTROL_DB.prepare("UPDATE tasks SET additions = ?, deletions = ?, changed_files_json = ?, patch_key = ?, verification_key = ?, backup_id = ?, updated_at = ? WHERE id = ?")
    .bind(additions, deletions, JSON.stringify(changedFiles), patchKey, `tasks/${item.task.id}/verification.txt`, backup.id, timestamp, item.task.id).run();
  return { baseSha: base.stdout.trim(), headSha: sha.stdout.trim(), changedFiles };
}

async function promoteFastForward(env: ControlEnv, item: TaskContext, taskRepo: string, taskBranch:string, expectedBaseSha: string, expectedHeadSha: string) {
  const [canonical, taskFork] = await Promise.all([env.ARTIFACTS.get(item.project.artifact_repo), env.ARTIFACTS.get(taskRepo)]);
  const [targetToken, sourceToken] = await Promise.all([canonical.createToken("write", 3600), taskFork.createToken("read", 3600)]);
  const sandbox = sandboxFor(env, `${item.task.id}-promotion`);
  const cwd = "/workspace/promotion";
  try {
    const clone = await sandbox.exec(`rm -rf ${shell(cwd)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${targetToken.plaintext}`)} clone --branch ${shell(item.project.default_branch)} --single-branch ${shell(canonical.remote)} ${shell(cwd)}`, { timeout: 180_000 });
    if (!clone.success) throw new Error(`Canonical clone failed: ${clone.stderr.slice(-1200)}`);
    const fetched = await sandbox.exec(`git -c http.extraHeader=${shell(`Authorization: Bearer ${sourceToken.plaintext}`)} fetch ${shell(taskFork.remote)} ${shell(taskBranch)}:refs/remotes/task/result`, { cwd, timeout: 180_000 });
    if (!fetched.success) throw new Error(`Task result fetch failed: ${fetched.stderr.slice(-1200)}`);
    const refs = await sandbox.exec("printf '%s\\n%s' \"$(git rev-parse HEAD)\" \"$(git rev-parse refs/remotes/task/result)\"", { cwd });
    const [canonicalSha, taskSha] = refs.stdout.trim().split("\n");
    if (canonicalSha !== expectedBaseSha) throw new Error("Canonical repository changed after review; promotion requires a fresh task");
    if (taskSha !== expectedHeadSha) throw new Error("Task fork changed after review; promotion requires a fresh independent review");
    const safe = await sandbox.exec("git merge-base --is-ancestor HEAD refs/remotes/task/result", { cwd });
    if (!safe.success) throw new Error("Canonical repository diverged; promotion requires review and cannot force-push");
    const pushed = await sandbox.exec(`git merge --ff-only refs/remotes/task/result && git -c http.extraHeader=${shell(`Authorization: Bearer ${targetToken.plaintext}`)} push origin HEAD:${shell(item.project.default_branch)}`, { cwd, timeout: 180_000 });
    if (!pushed.success) throw new Error(`Fast-forward promotion failed: ${pushed.stderr.slice(-1200)}`);
    const sha = await sandbox.exec("git rev-parse HEAD", { cwd });
    return sha.stdout.trim();
  } finally {
    await Promise.allSettled([canonical.revokeToken(targetToken.id), taskFork.revokeToken(sourceToken.id)]);
  }
}

export class TaskWorkflow extends WorkflowEntrypoint<ControlEnv, TaskWorkflowInput> {
  async run(event: Readonly<WorkflowEvent<TaskWorkflowInput>>, step: WorkflowStep) {
      const input = event.payload;
    try {
      const item = await step.do("load task", () => context(this.env, input));
      let executionPrompt = item.task.prompt;
      let approvedPlan: NonNullable<Awaited<ReturnType<typeof getTaskPlan>>>["plan"] = null;
      if (input.planRevisionId) {
        const taskPlan = await step.do("load exact approved plan", () => getTaskPlan(this.env.CONTROL_DB, input.ownerSub, input.taskId));
        if (!taskPlan?.plan || taskPlan.revision?.id !== input.planRevisionId || taskPlan.state.approved_revision_id !== input.planRevisionId || taskPlan.state.execution_phase !== "building") throw new Error("The exact approved plan is not authorized for this build");
        approvedPlan = taskPlan.plan;
        executionPrompt = `${item.task.prompt}\n\nExecute the exact approved plan below. Preserve its scope and satisfy every acceptance check.\n\n${JSON.stringify(taskPlan.plan, null, 2)}`;
      }
      await step.do("mark preparing", async () => {
        await updateTask(this.env.CONTROL_DB, input.taskId, "preparing");
        const taskEvent = await appendEvent(this.env.CONTROL_DB, input.taskId, "task.preparing", {});
        await broadcast(this.env, input.ownerSub, taskEvent);
      });
      const sourceArtifactRepo = await step.do("resolve task fork source", async () => {
        if (input.sourceTaskId || input.sourceHeadSha) {
          if (!input.sourceTaskId || !input.sourceHeadSha || !/^[a-f0-9]{40}$/i.test(input.sourceHeadSha)) throw new Error("Session tasks require an exact source task and head SHA");
          const source = await workflowTask(this.env.CONTROL_DB,input.sourceTaskId,input.ownerSub);
          if (!source?.task_repo) throw new Error("Session source task repository is unavailable");
          return source.task_repo;
        }
        if (!input.subagentId || !input.parentTaskId) return item.project.artifact_repo;
        const parent = await workflowTask(this.env.CONTROL_DB, input.parentTaskId, input.ownerSub);
        if (!parent?.task_repo || !parent.head_sha) throw new Error("Subagents require a parent task fork with an exact head SHA");
        return parent.task_repo;
      });
      const fork = await step.do("fork task source repository", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes", sensitive: "output" }, () => taskFork(this.env, item, sourceArtifactRepo,input.sourceHeadSha));
      await step.do("mark running", async () => {
        await updateTask(this.env.CONTROL_DB, input.taskId, "running", { taskRepo: fork.name });
        await this.env.CONTROL_DB.prepare("UPDATE ci_repairs SET status='running', updated_at=? WHERE task_id=?").bind(now(), input.taskId).run();
        const taskEvent = await appendEvent(this.env.CONTROL_DB, input.taskId, "task.running", { taskRepo: fork.name });
        await broadcast(this.env, input.ownerSub, taskEvent);
      });
      let run: Awaited<ReturnType<typeof runAgent>>;
      let check: Awaited<ReturnType<typeof verify>>;
      if (input.planRevisionId && approvedPlan) {
        let sessionId = item.task.session_id;
        for (let index = 0; index < approvedPlan.steps.length; index += 1) {
          const planStep = approvedPlan.steps[index];
          await step.do(`start plan step ${index + 1}`, () => transitionPlanStep(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, revisionId: input.planRevisionId!, stepId: planStep.id, to: "in_progress", actorSub: "task-workflow" }));
          const prompt = `${item.task.prompt}\n\nImplement only this approved plan step (${index + 1} of ${approvedPlan.steps.length}):\n${planStep.title}\n${planStep.description}\n\nAcceptance checks:\n${planStep.acceptanceChecks.map((value) => `- ${value}`).join("\n")}\n\nPreserve completed earlier steps and do not expand the immutable approved plan.`;
          run = await step.do(`run plan step ${index + 1}`, { timeout: "60 minutes" }, () => runAgent(this.env, item, fork, prompt, index, sessionId));
          sessionId = run.sessionId ?? sessionId;
          check = await step.do(`verify plan step ${index + 1}`, { timeout: "20 minutes" }, () => verify(this.env, item));
          if (!run.ok || !check.ok) {
            await step.do(`block plan step ${index + 1}`, () => transitionPlanStep(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, revisionId: input.planRevisionId!, stepId: planStep.id, to: "blocked", actorSub: "task-workflow", reason: check.output || run.stderr }));
            throw new Error(`Approved plan step ${index + 1} failed verification: ${check.output || run.stderr}`);
          }
          await step.do(`complete plan step ${index + 1}`, () => transitionPlanStep(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, revisionId: input.planRevisionId!, stepId: planStep.id, to: "completed", actorSub: "task-workflow" }));
        }
      } else {
        run = await step.do("run agent", { retries: { limit: 1, delay: "10 seconds" }, timeout: "60 minutes" }, () => runAgent(this.env, item, fork, executionPrompt, 0, item.task.session_id));
        check = await step.do("verify changes", { timeout: "20 minutes" }, () => verify(this.env, item));
        for (let attempt = 1; (!run.ok || !check.ok) && attempt <= 3; attempt++) {
          const repairAttempt = attempt;
          await step.do(`mark repair ${repairAttempt}`, async () => {
            await updateTask(this.env.CONTROL_DB, input.taskId, "repairing", { sessionId: run.sessionId ?? undefined, repairAttempts: repairAttempt, error: check.ok ? run.stderr : check.output });
            const taskEvent = await appendEvent(this.env.CONTROL_DB, input.taskId, "task.repairing", { attempt: repairAttempt, verifyCommand: check.command });
            await broadcast(this.env, input.ownerSub, taskEvent);
          });
          const repairPrompt = `Repair the task implementation. The previous run or verification failed.\n\nVerification command: ${check.command}\n\nFailure output:\n${check.output || run.stderr}\n\nMake the smallest correct fix, then leave the workspace ready for verification.`;
          run = await step.do(`run repair ${repairAttempt}`, { timeout: "60 minutes" }, () => runAgent(this.env, item, fork, repairPrompt, repairAttempt, run.sessionId));
          check = await step.do(`verify repair ${repairAttempt}`, { timeout: "20 minutes" }, () => verify(this.env, item));
        }
        if (!run.ok || !check.ok) throw new Error(`Task did not pass verification after three repair attempts: ${check.output || run.stderr}`);
      }
      if (input.planRevisionId) {
        for (let guidanceRound = 1; guidanceRound <= 8; guidanceRound += 1) {
          const messages = await step.do(`deliver queued plan guidance ${guidanceRound}`, () => deliverQueuedPlanMessages(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, actorSub: "task-workflow" }));
          if (!messages.length) break;
          const guidancePrompt = `Apply the following user guidance within the exact approved plan. Do not expand scope beyond that plan. Preserve completed work and rerun validation.\n\n${messages.map((message, index) => `${index + 1}. ${message.body}`).join("\n")}`;
          run = await step.do(`apply plan guidance ${guidanceRound}`, { timeout: "60 minutes" }, () => runAgent(this.env, item, fork, guidancePrompt, guidanceRound, run.sessionId));
          check = await step.do(`verify plan guidance ${guidanceRound}`, { timeout: "20 minutes" }, () => verify(this.env, item));
          const claimToken = messages[0].claimToken;
          if (!run.ok || !check.ok) {
            await step.do(`release plan guidance ${guidanceRound}`, () => releasePlanMessages(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, claimToken }));
            throw new Error(`Queued plan guidance failed validation: ${check.output || run.stderr}`);
          }
          await step.do(`acknowledge plan guidance ${guidanceRound}`, () => acknowledgePlanMessages(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, claimToken, actorSub: "task-workflow" }));
        }
      }
      if (input.subagentId && input.parentTaskId) {
        for (let steeringRound = 1; steeringRound <= 8; steeringRound += 1) {
          const steers = await step.do(`claim steering ${steeringRound}`, () => claimPendingSubagentSteers(this.env.CONTROL_DB, input.ownerSub, item.project.id, input.parentTaskId!, input.subagentId!));
          if (!steers.length) break;
          const steeringPrompt = `Apply these parent-agent steering instructions to the current subagent result. Preserve completed work, make the smallest necessary changes, and rerun the task validation.\n\n${steers.map((steer, index) => `${index + 1}. ${steer.instruction}`).join("\n")}`;
          run = await step.do(`apply steering ${steeringRound}`, { timeout: "60 minutes" }, () => runAgent(this.env, item, fork, steeringPrompt, steeringRound, run.sessionId));
          check = await step.do(`verify steering ${steeringRound}`, { timeout: "20 minutes" }, () => verify(this.env, item));
          const claimToken = steers[0].claimToken;
          if (!run.ok || !check.ok) {
            await step.do(`release steering ${steeringRound}`, () => releaseSubagentSteers(this.env.CONTROL_DB, input.ownerSub, input.parentTaskId!, input.subagentId!, claimToken));
            throw new Error(`Subagent steering failed validation: ${check.output || run.stderr}`);
          }
          await step.do(`acknowledge steering ${steeringRound}`, () => acknowledgeSubagentSteers(this.env.CONTROL_DB, input.ownerSub, input.parentTaskId!, input.subagentId!, claimToken));
        }
        const remaining = await step.do("ensure steering queue drained", () => claimPendingSubagentSteers(this.env.CONTROL_DB, input.ownerSub, item.project.id, input.parentTaskId!, input.subagentId!));
        if (remaining.length) {
          await step.do("release excess steering", () => releaseSubagentSteers(this.env.CONTROL_DB, input.ownerSub, input.parentTaskId!, input.subagentId!, remaining[0].claimToken));
          throw new Error("Subagent received more steering than the bounded execution loop could safely apply");
        }
      }
      const browserEvidence = await step.do("retain browser evidence", { timeout: "10 minutes" }, () => harvestBrowserEvidence(this.env, item));
      const revision = await step.do("push task fork and back up workspace", { timeout: "20 minutes" }, () => pushAndBackup(this.env, item, fork));
      await step.do("checkpoint conversation and code", () => checkpointLatestUserMessage(this.env.CONTROL_DB,input.taskId,revision.headSha,run.sessionId,item.task.prompt));
      await step.do("complete review autofix record", () => this.env.CONTROL_DB.prepare("UPDATE review_fix_runs SET status='completed',result_head_sha=?,completed_at=?,updated_at=? WHERE task_id=? AND workflow_id=? AND status='running'").bind(revision.headSha, now(), now(), input.taskId, item.task.workflow_id).run().then(() => undefined));
      await step.do("mark ready for review", async () => {
        await updateTask(this.env.CONTROL_DB, input.taskId, "review", { sessionId: run.sessionId ?? undefined, baseSha: revision.baseSha, headSha: revision.headSha, error: null });
        const taskEvent = await appendEvent(this.env.CONTROL_DB, input.taskId, "task.review", { taskRepo: fork.name, baseSha: revision.baseSha, headSha: revision.headSha, verification: check.evidenceKey, browserEvidence: browserEvidence.length });
        await broadcast(this.env, input.ownerSub, taskEvent);
        await indexTaskForSearch(this.env.CONTROL_DB, input.taskId);
        await deliverAgentWebhookEvent(this.env, { ownerSub:input.ownerSub, projectId:item.project.id, eventType:"agent.review", eventId:`agent.review:${input.taskId}:${revision.headSha}`, payload:{ taskId:input.taskId, status:"review", headSha:revision.headSha, canonicalRepository:item.project.artifact_repo } }).catch(() => undefined);
        await (await this.env.ARTIFACTS.get(fork.name)).revokeToken(fork.token);
        if (input.automationRunId) {
          await updateAutomationRun(this.env.CONTROL_DB, { ownerSub: input.ownerSub, runId: input.automationRunId, status: "review", reason: "Task implementation and verification completed; human review is required" });
          await deliverAutomationEvent(this.env, { ownerSub:input.ownerSub, runId:input.automationRunId, eventType:"run.review" }).catch(() => undefined);
        }
      });
      const review = await step.do("queue independent review", async () => {
        const workflowId = `review-${input.taskId}-${revision.headSha.slice(0, 12)}`;
        const reviewRun = await createReviewRun(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, baseSha: revision.baseSha, headSha: revision.headSha, trigger: "task", workflowId });
        await this.env.REVIEW_WORKFLOW.create({ id: workflowId, params: { reviewRunId: reviewRun!.id, taskId: input.taskId, ownerSub: input.ownerSub }, retention: { successRetention: "30 days", errorRetention: "30 days" } });
        return reviewRun!;
      });
      if (input.subagentId && input.parentTaskId) {
        const outcome = await step.waitForEvent<{reviewRunId:string;headSha:string|null;status:"completed"|"failed";blockingCount:number}>("wait for subagent review", { type: "review-finished", timeout: "30 days" });
        if (outcome.payload.reviewRunId !== review.id || outcome.payload.headSha !== revision.headSha) throw new Error("Subagent review result is stale");
        if (outcome.payload.status !== "completed") throw new Error("Independent subagent review failed");
        if (outcome.payload.blockingCount > 0) {
          await step.do("block subagent on review findings", () => blockSubagent(this.env.CONTROL_DB, input.ownerSub, item.project.id, input.parentTaskId!, input.subagentId!, `${outcome.payload.blockingCount} blocking independent-review findings`));
          return { taskId: input.taskId, subagentId: input.subagentId, status: "blocked", reviewRunId: review.id };
        }
        const handoffId = await step.do("complete immutable subagent handoff", async () => {
          const handoff = await completeSubagentWithHandoff(this.env.CONTROL_DB, input.ownerSub, item.project.id, input.parentTaskId!, input.subagentId!, {
            baseSha: revision.baseSha,
            commitSha: revision.headSha,
            changedPaths: revision.changedFiles.map((file) => file.path),
            result: { title: item.task.title, reviewRunId: review.id, verificationKey: check.evidenceKey },
            evidence: [{ kind: "test", ref: check.evidenceKey }, { kind: "review", ref: review.id }, ...browserEvidence.map((evidence) => ({ kind: "artifact" as const, ref: evidence.id, label: evidence.name }))],
          });
          return handoff.id;
        });
        const readySiblings = await step.do("claim dependency-ready sibling subagents", () => startReadySubagents(this.env.CONTROL_DB, input.ownerSub, item.project.id, input.parentTaskId!));
        for (const sibling of readySiblings) await step.do(`launch ready sibling ${sibling.id}`, { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, () => this.env.TASK_WORKFLOW.create({ id: sibling.workflow_identity, params: { taskId: sibling.child_task_id, ownerSub: input.ownerSub, subagentId: sibling.id, parentTaskId: input.parentTaskId! }, retention: { successRetention: "30 days", errorRetention: "30 days" } }));
        return { taskId: input.taskId, subagentId: input.subagentId, status: "completed", handoffId, headSha: revision.headSha };
      }
      const approval = await step.waitForEvent<{approvedBy:string;approvedAt:string;expectedHeadSha:string;reviewRunId:string}>("wait for promotion approval", { type: "promote", timeout: "30 days" });
      let promotionHeadSha = revision.headSha;
      if (approval.payload.expectedHeadSha !== revision.headSha || approval.payload.reviewRunId !== review.id) {
        const current = await step.do("load collected parent revision", () => workflowTask(this.env.CONTROL_DB, input.taskId, input.ownerSub));
        if (!current || current.task_repo !== fork.name || current.head_sha !== approval.payload.expectedHeadSha || current.status !== "review") throw new Error("Promotion approval is stale for the reviewed task revision");
        promotionHeadSha = current.head_sha;
      }
      const promotedSha = await step.do("promote with fast forward", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, () => promoteFastForward(this.env, item, fork.name, fork.branch, revision.baseSha, promotionHeadSha));
      await step.do("mark completed", async () => {
        await updateTask(this.env.CONTROL_DB, input.taskId, "completed", { headSha: promotedSha, error: null });
        await this.env.CONTROL_DB.prepare("UPDATE ci_repairs SET status='completed', updated_at=? WHERE task_id=?").bind(now(), input.taskId).run();
        const taskEvent = await appendEvent(this.env.CONTROL_DB, input.taskId, "task.completed", { taskRepo: fork.name, headSha: promotedSha });
        await broadcast(this.env, input.ownerSub, taskEvent);
        await indexTaskForSearch(this.env.CONTROL_DB, input.taskId);
        await deliverAgentWebhookEvent(this.env, { ownerSub:input.ownerSub, projectId:item.project.id, eventType:"agent.completed", eventId:`agent.completed:${input.taskId}:${promotedSha}`, payload:{ taskId:input.taskId, status:"completed", headSha:promotedSha, canonicalRepository:item.project.artifact_repo } }).catch(() => undefined);
        if (input.planRevisionId) await completePlanExecution(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, revisionId: input.planRevisionId, actorSub: "task-workflow" });
        if (input.automationRunId) {
          await updateAutomationRun(this.env.CONTROL_DB, { ownerSub: input.ownerSub, runId: input.automationRunId, status: "completed", reason: "Reviewed task was promoted" });
          await deliverAutomationEvent(this.env, { ownerSub:input.ownerSub, runId:input.automationRunId, eventType:"run.completed" }).catch(() => undefined);
        }
        if (input.automationRunId) await drainAutomationQueue(this.env, input.ownerSub);
        await createTaskAttentionEvent(this.env.CONTROL_DB, { ownerSub: input.ownerSub, taskId: input.taskId, kind: "task-completed", dedupKey: `completed:${input.taskId}:${promotedSha}` });
      });
      await step.do("queue optional GitHub sync", async () => {
        const linked = await this.env.CONTROL_DB.prepare("SELECT project_id FROM sync_state WHERE project_id = ? AND repository_full_name IS NOT NULL").bind(item.project.id).first<{project_id:string}>();
        if (!linked) return;
        const runId = `sync_task_${input.taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
        const timestamp = now();
        const inserted = await this.env.CONTROL_DB.prepare("INSERT OR IGNORE INTO sync_runs (id, project_id, direction, status, source_sha, created_at, updated_at) VALUES (?, ?, 'artifacts-to-github', 'queued', ?, ?, ?)").bind(runId, item.project.id, promotedSha, timestamp, timestamp).run();
        if (inserted.meta.changes) await this.env.GITHUB_SYNC_WORKFLOW.create({ id: runId, params: { projectId: item.project.id, runId, direction: "artifacts-to-github" }, retention: { successRetention: "30 days", errorRetention: "30 days" } });
      });
      return { taskId: input.taskId, status: "completed", headSha: promotedSha };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 12_000) : "Unknown workflow failure";
      await step.do("record failure", async () => {
        await updateTask(this.env.CONTROL_DB, input.taskId, "failed", { error: message });
        await this.env.CONTROL_DB.prepare("UPDATE ci_repairs SET status='failed', updated_at=? WHERE task_id=?").bind(now(), input.taskId).run();
        const taskEvent = await appendEvent(this.env.CONTROL_DB, input.taskId, "task.failed", { error: message });
        await broadcast(this.env, input.ownerSub, taskEvent);
        await indexTaskForSearch(this.env.CONTROL_DB, input.taskId).catch(() => undefined);
        const failedTask = await workflowTask(this.env.CONTROL_DB, input.taskId, input.ownerSub);
        if (failedTask) await deliverAgentWebhookEvent(this.env, { ownerSub:input.ownerSub, projectId:failedTask.project_id, eventType:"agent.failed", eventId:`agent.failed:${input.taskId}:${failedTask.workflow_id}`, payload:{ taskId:input.taskId, status:"failed", error:message } }).catch(() => undefined);
        await createTaskAttentionEvent(this.env.CONTROL_DB, { ownerSub: input.ownerSub, taskId: input.taskId, kind: "task-failed", dedupKey: `failed:${input.taskId}:${Date.now()}` }).catch(() => undefined);
        if (input.planRevisionId) await requirePlanRecovery(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, actorSub: "task-workflow", reason: message }).catch(() => undefined);
        if (input.automationRunId) {
          await updateAutomationRun(this.env.CONTROL_DB, { ownerSub: input.ownerSub, runId: input.automationRunId, status: "failed", error: message }).catch(() => undefined);
          await deliverAutomationEvent(this.env, { ownerSub:input.ownerSub, runId:input.automationRunId, eventType:"run.failed" }).catch(() => undefined);
        }
        if (input.automationRunId) await drainAutomationQueue(this.env, input.ownerSub).catch(() => undefined);
        if (input.subagentId && input.parentTaskId) {
          const task = await workflowTask(this.env.CONTROL_DB, input.taskId, input.ownerSub);
          if (task) await failSubagent(this.env.CONTROL_DB, input.ownerSub, task.project_id, input.parentTaskId, input.subagentId, message).catch(() => undefined);
        }
      });
      throw error;
    }
  }
}
