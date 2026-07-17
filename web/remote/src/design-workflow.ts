import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { appendEvent, now } from "./db";
import { broadcast } from "./api";
import { buildDesignEditPrompt, completeDesignEditRequest, completeDesignSession, failDesignEditRequest, getDesignEditContext, startDesignEditRequest } from "./design-mode";
import { createReviewRun } from "./review";
import { loadSubscription, persistSubscription, sandboxFor, shell } from "./sandbox-runtime";
import { resolveTaskEnvironment } from "./environments";
import type { ControlEnv, Project, Task } from "./types";
import { secretValues } from "./environment-secrets";
import { redactSecurityText } from "./security-policy";
import { runHardenedAgent } from "./hardened-agent";

export type DesignWorkflowInput = { editRequestId:string; sessionId:string; taskId:string; ownerSub:string; expectedRevision:string };

export class DesignWorkflow extends WorkflowEntrypoint<ControlEnv, DesignWorkflowInput> {
  async run(event: Readonly<WorkflowEvent<DesignWorkflowInput>>, step: WorkflowStep) {
    const input = event.payload;
    let claimed = false;
    try {
      const item = await step.do("load exact design edit context", async () => {
        const [context, task] = await Promise.all([
          getDesignEditContext(this.env.CONTROL_DB, input.ownerSub, input.editRequestId),
          this.env.CONTROL_DB.prepare("SELECT * FROM tasks WHERE id=? AND owner_sub=?").bind(input.taskId, input.ownerSub).first<Task>(),
        ]);
        if (!context || context.session.id !== input.sessionId || context.session.task_id !== input.taskId || context.session.preview_revision !== input.expectedRevision) throw new Error("Design edit context is stale or unauthorized");
        if (!task?.task_repo || task.head_sha !== input.expectedRevision || task.status !== "review") throw new Error("Task preview revision changed before design editing started");
        const project = await this.env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id=? AND owner_sub=?").bind(task.project_id, input.ownerSub).first<Project>();
        if (!project) throw new Error("Design project no longer exists");
        const environment = await resolveTaskEnvironment(this.env.CONTROL_DB, input.ownerSub, task.id);
        return { context, task, project, environment };
      });
      await step.do("claim task and design edit", async () => {
        const updated = await this.env.CONTROL_DB.prepare("UPDATE tasks SET status='repairing', error=NULL, updated_at=? WHERE id=? AND owner_sub=? AND head_sha=? AND status='review'").bind(now(), input.taskId, input.ownerSub, input.expectedRevision).run();
        if (!updated.meta.changes) throw new Error("Task changed before design edit could start");
        claimed = true;
        await startDesignEditRequest(this.env.CONTROL_DB, { editRequestId: input.editRequestId, ownerSub: input.ownerSub, actorSub: "design-workflow", currentRevision: input.expectedRevision });
        await broadcast(this.env, input.ownerSub, await appendEvent(this.env.CONTROL_DB, input.taskId, "design.edit-running", { sessionId: input.sessionId, editRequestId: input.editRequestId }));
      });
      const result = await step.do("apply bounded design edit", { timeout: "70 minutes", sensitive: "output" }, async () => {
        const repository = await this.env.ARTIFACTS.get(item.task.task_repo!);
        const token = await repository.createToken("write", 7200);
        const sandbox = sandboxFor(this.env, `${input.taskId}-design`);
        const cwd = "/workspace/design";
        try {
          if (!await loadSubscription(this.env, sandbox)) throw new Error("Cloud Grok subscription is signed out");
          const clone = await sandbox.exec(`rm -rf ${shell(cwd)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${token.plaintext}`)} clone --branch ${shell(item.project.default_branch)} --single-branch ${shell(repository.remote)} ${shell(cwd)}`, { timeout: 180_000 });
          if (!clone.success) throw new Error(`Design repository clone failed: ${clone.stderr.slice(-1200)}`);
          const head = await sandbox.exec("git rev-parse HEAD", { cwd });
          if (!head.success || head.stdout.trim() !== input.expectedRevision) throw new Error("Design repository head changed before editing");
          const prompt = buildDesignEditPrompt({ session: item.context.session, edit: item.context.edit, elements: item.context.elements, relationships: item.context.selection?.relationships, annotations: item.context.annotations });
          const {acp,runtimeSecrets,secrets}=await runHardenedAgent({env:this.env,sandbox,task:item.task,projectId:item.project.id,cwd,prompt,runtimeId:`design-${input.editRequestId}`,reviewOnly:false});
          await persistSubscription(this.env, sandbox);
          const logKey = `tasks/${input.taskId}/design/${input.editRequestId}.jsonl`;
          const log=[...acp.events.map((event)=>JSON.stringify(event)),JSON.stringify({type:"agent_result",data:{stopReason:acp.stopReason,finalText:acp.finalText}}),acp.stderr ? JSON.stringify({type:"stderr",data:acp.stderr}) : ""].filter(Boolean).join("\n");
          await this.env.EVIDENCE_BUCKET.put(logKey, redactSecurityText(log, secrets), { httpMetadata: { contentType: "application/x-ndjson" } });
          if (!acp.ok) throw new Error(`Design agent failed (${acp.stopReason}): ${redactSecurityText(acp.stderr.slice(-4000), secrets)}`);
          const validationOutput: string[] = [];
          for (const validation of item.environment.manifest.validation.length ? item.environment.manifest.validation : ["git diff --check"]) {
            const checked = await sandbox.exec(validation, { cwd, timeout: 900_000, env: { CI: "1", NO_COLOR: "1", ...runtimeSecrets } });
            validationOutput.push(redactSecurityText(`$ ${validation}\n${checked.stdout}\n${checked.stderr}`, secretValues(runtimeSecrets)));
            if (!checked.success) throw new Error(`Design edit validation failed: ${checked.stderr.slice(-2000) || checked.stdout.slice(-2000)}`);
          }
          const changed = await sandbox.exec("git status --porcelain", { cwd });
          if (!changed.stdout.trim()) throw new Error("Design edit produced no file changes");
          await sandbox.exec("git config user.name 'Grok Build' && git config user.email 'grok-build@users.noreply.github.com'", { cwd });
          const pushed = await sandbox.exec(`git add -A && git commit -m ${shell(`Grok Build design: ${item.task.title}`)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${token.plaintext}`)} push origin HEAD:${shell(item.project.default_branch)}`, { cwd, timeout: 180_000 });
          if (!pushed.success) throw new Error(`Design edit push failed: ${pushed.stderr.slice(-1200)}`);
          const resultingHeadSha = (await sandbox.exec("git rev-parse HEAD", { cwd })).stdout.trim();
          const [patch, numstat, names] = await Promise.all([
            sandbox.exec(`git diff --binary --no-ext-diff ${shell(item.task.base_sha!)}..HEAD`, { cwd }),
            sandbox.exec(`git diff --numstat ${shell(item.task.base_sha!)}..HEAD`, { cwd }),
            sandbox.exec(`git diff --name-status ${shell(item.task.base_sha!)}..HEAD`, { cwd }),
          ]);
          const patchKey = `tasks/${input.taskId}/design/${input.editRequestId}.patch`;
          const verificationKey = `tasks/${input.taskId}/design/${input.editRequestId}-verification.txt`;
          await Promise.all([
            this.env.EVIDENCE_BUCKET.put(patchKey, patch.stdout, { httpMetadata: { contentType: "text/x-diff" } }),
            this.env.EVIDENCE_BUCKET.put(verificationKey, validationOutput.join("\n"), { httpMetadata: { contentType: "text/plain" } }),
          ]);
          const stats = new Map(numstat.stdout.trim().split("\n").filter(Boolean).map((line) => { const [add, del, ...path] = line.split("\t"); return [path.join("\t"), { additions:Number(add)||0, deletions:Number(del)||0 }] as const; }));
          const changedFiles = names.stdout.trim().split("\n").filter(Boolean).map((line) => { const [status, ...parts] = line.split("\t"); const path = parts.at(-1) || ""; return { path, status, additions:stats.get(path)?.additions||0, deletions:stats.get(path)?.deletions||0 }; });
          return { resultingHeadSha, changedFiles, patchKey, verificationKey, logKey };
        } finally {
          await repository.revokeToken(token.id).catch(() => false);
          await sandbox.killAllProcesses().catch(() => undefined);
        }
      });
      await step.do("publish design edit for review", async () => {
        await completeDesignEditRequest(this.env.CONTROL_DB, { editRequestId: input.editRequestId, ownerSub: input.ownerSub, actorSub: "design-workflow", currentRevision: input.expectedRevision, evidence: [
          { kind:"diff", label:"Design edit diff", ref:result.patchKey }, { kind:"test", label:"Design edit verification", ref:result.verificationKey }, { kind:"log", label:"Design agent log", ref:result.logKey },
        ] });
        await completeDesignSession(this.env.CONTROL_DB, { sessionId: input.sessionId, ownerSub: input.ownerSub, actorSub: "design-workflow", currentRevision: input.expectedRevision });
        const additions = result.changedFiles.reduce((total, file) => total + file.additions, 0); const deletions = result.changedFiles.reduce((total, file) => total + file.deletions, 0);
        const updated = await this.env.CONTROL_DB.prepare("UPDATE tasks SET status='review', head_sha=?, additions=?, deletions=?, changed_files_json=?, patch_key=?, verification_key=?, error=NULL, updated_at=? WHERE id=? AND owner_sub=? AND head_sha=? AND status='repairing'")
          .bind(result.resultingHeadSha, additions, deletions, JSON.stringify(result.changedFiles), result.patchKey, result.verificationKey, now(), input.taskId, input.ownerSub, input.expectedRevision).run();
        if (!updated.meta.changes) throw new Error("Task changed after design edit was pushed");
        const workflowId = `review-${input.taskId}-${result.resultingHeadSha.slice(0, 12)}`;
        const review = await createReviewRun(this.env.CONTROL_DB, { taskId: input.taskId, ownerSub: input.ownerSub, baseSha: item.task.base_sha!, headSha: result.resultingHeadSha, trigger: "manual", workflowId });
        await this.env.REVIEW_WORKFLOW.create({ id: workflowId, params: { reviewRunId: review!.id, taskId: input.taskId, ownerSub: input.ownerSub }, retention: { successRetention: "30 days", errorRetention: "30 days" } });
        await broadcast(this.env, input.ownerSub, await appendEvent(this.env.CONTROL_DB, input.taskId, "design.edit-review", { editRequestId: input.editRequestId, headSha: result.resultingHeadSha, reviewRunId: review!.id }));
      });
      return { taskId: input.taskId, editRequestId: input.editRequestId, status: "review" };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 8_000) : "Design edit failed";
      await step.do("record design edit failure", async () => {
        await failDesignEditRequest(this.env.CONTROL_DB, { editRequestId: input.editRequestId, ownerSub: input.ownerSub, actorSub: "design-workflow", currentRevision: input.expectedRevision, error: message }).catch(() => undefined);
        if (claimed) await this.env.CONTROL_DB.prepare("UPDATE tasks SET status='review', error=?, updated_at=? WHERE id=? AND owner_sub=? AND head_sha=? AND status='repairing'").bind(message, now(), input.taskId, input.ownerSub, input.expectedRevision).run();
        await broadcast(this.env, input.ownerSub, await appendEvent(this.env.CONTROL_DB, input.taskId, "design.edit-failed", { editRequestId: input.editRequestId, error: message }));
      });
      throw error;
    }
  }
}
