import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { now } from "./db";
import { loadSubscription, persistSubscription, sandboxFor, shell } from "./sandbox-runtime";
import type { ControlEnv, Project, Task } from "./types";
import {
  assertGitSha,
  buildReviewerPrompt,
  completeReview,
  discoverReviewRules,
  failReview,
  getReviewRun,
  isBlockingFinding,
  markReviewRunning,
  parseReviewOutput,
  reviewRuleCandidate,
  sha256,
  type ReviewRuleSource,
  type ReviewRunRow,
} from "./review";
import { createTaskAttentionEvent } from "./notifications";
import { publishReviewToScm } from "./review-publication";
import { runHardenedAgent } from "./hardened-agent";
import { redactSecurityText } from "./security-policy";

export type ReviewWorkflowInput = { reviewRunId: string; taskId: string; ownerSub: string };

export type ReviewContext = { run: ReviewRunRow; task: Task; project: Project };
export type ReviewExecutionResult = { output: ReturnType<typeof parseReviewOutput>; outputKey: string; patchDigest: string; rulesDigest: string };

async function reviewContext(env: ControlEnv, input: ReviewWorkflowInput): Promise<ReviewContext> {
  const run = await getReviewRun(env.CONTROL_DB, input.reviewRunId);
  const task = await env.CONTROL_DB.prepare("SELECT * FROM tasks WHERE id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<Task>();
  if (!run || run.task_id !== input.taskId || run.owner_sub !== input.ownerSub) throw new Error("Review run no longer exists");
  if (!task || !task.task_repo || !task.base_sha || !task.head_sha) throw new Error("Task is not ready for independent review");
  if (assertGitSha(task.base_sha) !== run.base_sha || assertGitSha(task.head_sha) !== run.head_sha) throw new Error("Review run is stale for the task head");
  const project = await env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id=? AND owner_sub=?").bind(task.project_id, input.ownerSub).first<Project>();
  if (!project) throw new Error("Project no longer exists");
  return { run, task, project };
}

async function readRules(sandbox: ReturnType<typeof sandboxFor>, cwd: string): Promise<ReviewRuleSource[]> {
  const listed = await sandbox.exec("find . -type f \\( -name 'BUGBOT.md' -o -name 'AGENTS.md' -o -path './.grok/review.md' -o -path './.grok/review/*.md' \\) -print | sort | head -100", { cwd });
  if (!listed.success) return [];
  const files: Array<{path:string;content:string}> = [];
  for (const raw of listed.stdout.split("\n").filter(Boolean)) {
    const path = raw.replace(/^\.\//, "");
    if (!reviewRuleCandidate(path)) continue;
    const result = await sandbox.readFile(`${cwd}/${path}`);
    if (result.success) files.push({ path, content: result.content });
  }
  return discoverReviewRules(files);
}

async function verificationEvidence(env: ControlEnv, task: Task) {
  if (!task.verification_key) return "No verification evidence was retained.";
  const stored = await env.EVIDENCE_BUCKET.get(task.verification_key);
  return stored ? (await stored.text()).slice(-24_000) : "Verification evidence is unavailable.";
}

export async function executeIndependentReview(env: ControlEnv, item: ReviewContext): Promise<ReviewExecutionResult> {
  const taskRepository = await env.ARTIFACTS.get(item.task.task_repo!);
  const canonicalRepository = await env.ARTIFACTS.get(item.project.artifact_repo);
  const [taskToken, canonicalToken] = await Promise.all([taskRepository.createToken("read", 7200), canonicalRepository.createToken("read", 7200)]);
  const sandbox = sandboxFor(env, `${item.task.id}-review-${item.run.id.slice(-12)}`);
  const cwd = "/workspace/review";
  try {
    if (!await loadSubscription(env, sandbox)) throw new Error("Cloud Grok subscription is signed out");
    const clone = await sandbox.exec(`rm -rf ${shell(cwd)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${taskToken.plaintext}`)} clone --no-checkout ${shell(taskRepository.remote)} ${shell(cwd)}`, { timeout: 180_000 });
    if (!clone.success) throw new Error(`Review clone failed: ${clone.stderr.slice(-1200)}`);
    const fetched = await sandbox.exec(`git -c http.extraHeader=${shell(`Authorization: Bearer ${canonicalToken.plaintext}`)} fetch ${shell(canonicalRepository.remote)} ${shell(item.run.base_sha)} && git checkout --detach ${shell(item.run.head_sha)}`, { cwd, timeout: 180_000 });
    if (!fetched.success) throw new Error(`Review refs failed: ${fetched.stderr.slice(-1200)}`);
    const checkedHead = (await sandbox.exec("git rev-parse HEAD", { cwd })).stdout.trim();
    if (checkedHead !== item.run.head_sha) throw new Error("Task fork head changed before review started");
    const diffResult = await sandbox.exec(`git diff --no-ext-diff --unified=80 ${shell(item.run.base_sha)}..${shell(item.run.head_sha)}`, { cwd, timeout: 180_000 });
    if (!diffResult.success) throw new Error(`Review diff failed: ${diffResult.stderr.slice(-1200)}`);
    if (new TextEncoder().encode(diffResult.stdout).byteLength > 2_000_000) throw new Error("Review diff exceeds the 2 MB independent-review limit");
    const rules = await readRules(sandbox, cwd);
    const [patchDigest, rulesDigest] = await Promise.all([sha256(diffResult.stdout), sha256(JSON.stringify(rules))]);
    await env.CONTROL_DB.prepare("UPDATE review_runs SET patch_digest=?, rules_digest=?, updated_at=? WHERE id=? AND status='running'").bind(patchDigest, rulesDigest, now(), item.run.id).run();
    const prompt = buildReviewerPrompt({
      taskTitle: item.task.title, taskPrompt: item.task.prompt, baseSha: item.run.base_sha, headSha: item.run.head_sha,
      diff: diffResult.stdout, verification: await verificationEvidence(env, item.task), rules,
    });
    const {acp,secrets}=await runHardenedAgent({env,sandbox,task:item.task,projectId:item.project.id,cwd,prompt,runtimeId:`review-${item.run.id}`,reviewOnly:true,includeRuntimeSecrets:false});
    await persistSubscription(env, sandbox);
    const logBody = [...acp.events.map((event)=>JSON.stringify(event)),JSON.stringify({type:"agent_result",data:{stopReason:acp.stopReason,finalText:acp.finalText}}),acp.stderr ? JSON.stringify({type:"stderr",data:acp.stderr}) : ""].filter(Boolean).join("\n");
    const outputKey = `tasks/${item.task.id}/reviews/${item.run.id}.jsonl`;
    await env.EVIDENCE_BUCKET.put(outputKey, redactSecurityText(logBody,secrets), { httpMetadata: { contentType: "application/x-ndjson" } });
    if (!acp.ok) throw new Error(`Independent reviewer failed (${acp.stopReason}): ${redactSecurityText(acp.stderr.slice(-4000),secrets)}`);
    const current = await env.CONTROL_DB.prepare("SELECT head_sha FROM tasks WHERE id=? AND owner_sub=?").bind(item.task.id, item.run.owner_sub).first<{head_sha:string|null}>();
    if (!current?.head_sha || assertGitSha(current.head_sha) !== item.run.head_sha) throw new Error("Task head changed while independent review was running");
    return { output: parseReviewOutput(acp.finalText), outputKey, patchDigest, rulesDigest };
  } finally {
    await Promise.allSettled([taskRepository.revokeToken(taskToken.id), canonicalRepository.revokeToken(canonicalToken.id)]);
  }
}

export class ReviewWorkflow extends WorkflowEntrypoint<ControlEnv, ReviewWorkflowInput> {
  async run(event: Readonly<WorkflowEvent<ReviewWorkflowInput>>, step: WorkflowStep) {
    const input = event.payload;
    try {
      const item = await step.do("load immutable review context", () => reviewContext(this.env, input));
      await step.do("mark review running", () => markReviewRunning(this.env.CONTROL_DB, input.reviewRunId));
      const result = await step.do("run independent reviewer", { retries: { limit: 1, delay: "10 seconds" }, timeout: "70 minutes", sensitive: "output" }, () => executeIndependentReview(this.env, item));
      await step.do("persist validated findings", () => completeReview(this.env.CONTROL_DB, input.reviewRunId, input.taskId, result.output, result.outputKey));
      await step.do("publish SCM-neutral review", { timeout:"15 minutes" }, () => publishReviewToScm(this.env, input));
      await step.do("notify user when approval is available", async () => {
        if (result.output.findings.some(isBlockingFinding)) return;
        const child = await this.env.CONTROL_DB.prepare("SELECT id FROM subagent_runs WHERE child_task_id=?").bind(input.taskId).first<{id:string}>();
        if (!child) await createTaskAttentionEvent(this.env.CONTROL_DB, { ownerSub: input.ownerSub, taskId: input.taskId, kind: "approval-needed", dedupKey: `approval:${input.taskId}:${item.run.head_sha}` });
      });
      await step.do("notify task workflow", async () => {
        await (await this.env.TASK_WORKFLOW.get(item.task.workflow_id)).sendEvent({ type: "review-finished", payload: { reviewRunId: input.reviewRunId, headSha: item.run.head_sha, status: "completed", blockingCount: result.output.findings.filter(isBlockingFinding).length } }).catch(() => undefined);
      });
      return { reviewRunId: input.reviewRunId, taskId: input.taskId, status: "completed", risk: result.output.findings.length };
    } catch (error) {
      await step.do("record review failure", () => failReview(this.env.CONTROL_DB, input.reviewRunId, error));
      await step.do("notify task workflow of review failure", async () => {
        const task = await this.env.CONTROL_DB.prepare("SELECT workflow_id, head_sha FROM tasks WHERE id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<{workflow_id:string;head_sha:string|null}>();
        if (task) await (await this.env.TASK_WORKFLOW.get(task.workflow_id)).sendEvent({ type: "review-finished", payload: { reviewRunId: input.reviewRunId, headSha: task.head_sha, status: "failed", blockingCount: 0 } }).catch(() => undefined);
      });
      throw error;
    }
  }
}
