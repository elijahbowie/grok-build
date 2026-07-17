import type { ControlEnv } from "./types";
import { admitAutomationRun, claimAutomationRunForLaunch, createAutomationTaskForRun, releaseAutomationLaunchClaim, type AutomationTriggerType } from "./cloud-automations";

async function launchRun(env: ControlEnv, ownerSub: string, run: {id:string}) {
  const claimToken = await claimAutomationRunForLaunch(env.CONTROL_DB, { ownerSub, runId: run.id });
  if (!claimToken) return null;
  const workflowId = `automation-${run.id}`;
  let launch;
  try {
    launch = await createAutomationTaskForRun(env.CONTROL_DB, { ownerSub, runId: run.id, workflowId, claimToken });
  } catch (error) {
    await releaseAutomationLaunchClaim(env.CONTROL_DB, { ownerSub, runId: run.id, claimToken });
    throw error;
  }
  try {
    await env.TASK_WORKFLOW.create({ id: workflowId, params: { taskId: launch.taskId, ownerSub, automationRunId: run.id }, retention: { successRetention: "30 days", errorRetention: "30 days" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 8_000) : "Automation workflow creation failed";
    const timestamp = new Date().toISOString();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("UPDATE tasks SET status='failed', error=?, completed_at=?, updated_at=? WHERE id=? AND owner_sub=?").bind(message, timestamp, timestamp, launch.taskId, ownerSub),
      env.CONTROL_DB.prepare("UPDATE cloud_automation_runs SET status='failed', error=?, completed_at=?, updated_at=? WHERE id=? AND owner_sub=?").bind(message, timestamp, timestamp, run.id, ownerSub),
    ]);
    throw error;
  }
  return launch;
}

export async function dispatchAutomation(env: ControlEnv, input: {
  ownerSub:string; automationId:string; triggerId?:string|null; triggerType:AutomationTriggerType;
  idempotencyKey:string; provenance:Record<string, unknown>; triggerPayload?:Record<string, unknown>; webhookVerified?:boolean;
}) {
  const admission = await admitAutomationRun(env.CONTROL_DB, input);
  if (!admission.admitted || !admission.run) return admission;
  const launch = await launchRun(env, input.ownerSub, admission.run);
  return launch ? { ...admission, launch } : { ...admission, reason: "queued-for-capacity" as const };
}

export async function drainAutomationQueue(env: ControlEnv, ownerSub?: string) {
  const queued = ownerSub
    ? await env.CONTROL_DB.prepare("SELECT id, automation_id, owner_sub FROM cloud_automation_runs WHERE owner_sub=? AND status='queued' AND task_id IS NULL ORDER BY created_at LIMIT 100").bind(ownerSub).all<{id:string;automation_id:string;owner_sub:string}>()
    : await env.CONTROL_DB.prepare("SELECT id, automation_id, owner_sub FROM cloud_automation_runs WHERE status='queued' AND task_id IS NULL ORDER BY created_at LIMIT 100").all<{id:string;automation_id:string;owner_sub:string}>();
  const launched: string[] = [];
  for (const run of queued.results) {
    if (await launchRun(env, run.owner_sub, run)) launched.push(run.id);
  }
  return launched;
}
