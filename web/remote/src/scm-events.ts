import { dispatchAutomation } from "./automation-runtime";
import { id, now } from "./db";
import { findProjectForScmRepository, markScmEventProcessed, normalizeArtifactsEvent, recordScmEvent, scmEventMatches, type NormalizedScmEvent, type ScmProvider } from "./scm";
import type { ControlEnv } from "./types";

type TriggerRow = {trigger_id:string;automation_id:string;owner_sub:string;provider:ScmProvider;event_types_json:string;repositories_json:string;refs_json:string};

export async function createScmAutomationTrigger(db: D1Database, input: {ownerSub:string;automationId:string;provider:ScmProvider;eventTypes:string[];repositories?:string[];refs?:string[]}) {
  if (!input.eventTypes.length || input.eventTypes.length > 50 || input.eventTypes.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))) throw new Error("SCM event types are invalid");
  const automation = await db.prepare("SELECT id,project_id FROM cloud_automations WHERE id=? AND owner_sub=?").bind(input.automationId, input.ownerSub).first<{id:string;project_id:string}>();
  if (!automation) throw new Error("Automation not found");
  let repositories = [...new Set(input.repositories ?? [])]; const refs = [...new Set(input.refs ?? [])];
  if (!repositories.length) repositories = (await db.prepare("SELECT repository FROM project_scm_targets WHERE project_id=? AND provider=? AND enabled=1").bind(automation.project_id, input.provider).all<{repository:string}>()).results.map((target) => target.repository);
  if (!repositories.length) throw new Error(`This project has no enabled ${input.provider} SCM target`);
  if (repositories.some((value) => !value || value.length > 300) || refs.some((value) => !value.startsWith("refs/") || value.length > 500)) throw new Error("SCM repository or ref filter is invalid");
  const triggerId = id("atr"); const timestamp = now();
  await db.batch([
    db.prepare("INSERT INTO cloud_automation_triggers (id, automation_id, type, config_json, enabled, created_at, updated_at) VALUES (?, ?, 'manual', ?, 1, ?, ?)").bind(triggerId, input.automationId, JSON.stringify({ type:"manual", source:"scm" }), timestamp, timestamp),
    db.prepare("INSERT INTO automation_scm_triggers (trigger_id, provider, event_types_json, repositories_json, refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(triggerId, input.provider, JSON.stringify([...new Set(input.eventTypes)]), JSON.stringify(repositories), JSON.stringify(refs), timestamp, timestamp),
  ]);
  return { id:triggerId, automationId:input.automationId, provider:input.provider, eventTypes:[...new Set(input.eventTypes)], repositories, refs, enabled:true };
}

export async function listScmAutomationTriggers(db: D1Database, ownerSub: string, automationId: string) {
  const rows = await db.prepare(`SELECT s.*, t.enabled FROM automation_scm_triggers s JOIN cloud_automation_triggers t ON t.id=s.trigger_id JOIN cloud_automations a ON a.id=t.automation_id
    WHERE a.id=? AND a.owner_sub=? ORDER BY s.created_at`).bind(automationId, ownerSub).all<{trigger_id:string;provider:ScmProvider;event_types_json:string;repositories_json:string;refs_json:string;enabled:number}>();
  return rows.results.map((row) => ({ id:row.trigger_id, provider:row.provider, eventTypes:JSON.parse(row.event_types_json), repositories:JSON.parse(row.repositories_json), refs:JSON.parse(row.refs_json), enabled:Boolean(row.enabled) }));
}

export async function processScmEvent(env: ControlEnv, event: NormalizedScmEvent) {
  const project = await findProjectForScmRepository(env.CONTROL_DB, event.provider, event.repository);
  const stored = await recordScmEvent(env.CONTROL_DB, event, project ? { projectId:project.project_id, ownerSub:project.owner_sub } : null) as {id:string;processed_at?:string|null};
  if (!stored || stored.processed_at) return { duplicate:true, eventId:stored?.id ?? null, dispatches:[] };
  const dispatches: unknown[] = [];
  try {
    if (project && event.afterSha && (event.eventType === "repo.pushed" || event.eventType === "push")) {
      if (event.provider === "artifacts") await env.CONTROL_DB.prepare("UPDATE sync_state SET artifact_sha=?, updated_at=? WHERE project_id=?").bind(event.afterSha, now(), project.project_id).run();
      else await env.CONTROL_DB.prepare("UPDATE sync_state SET github_sha=?, updated_at=? WHERE project_id=?").bind(event.afterSha, now(), project.project_id).run();
    }
    const triggers = await env.CONTROL_DB.prepare(`SELECT s.trigger_id, t.automation_id, a.owner_sub, s.provider, s.event_types_json, s.repositories_json, s.refs_json
      FROM automation_scm_triggers s JOIN cloud_automation_triggers t ON t.id=s.trigger_id JOIN cloud_automations a ON a.id=t.automation_id
      WHERE s.provider=? AND t.enabled=1 AND a.status='enabled'`).bind(event.provider).all<TriggerRow>();
    for (const trigger of triggers.results) {
      if (!scmEventMatches({ event, provider:trigger.provider, eventTypes:JSON.parse(trigger.event_types_json), repositories:JSON.parse(trigger.repositories_json), refs:JSON.parse(trigger.refs_json) })) continue;
      const result = await dispatchAutomation(env, { ownerSub:trigger.owner_sub, automationId:trigger.automation_id, triggerType:"webhook", idempotencyKey:`scm:${stored.id}:${trigger.trigger_id}`, provenance:{ source:event.provider, scmEventId:stored.id, eventType:event.eventType, repository:event.repository, ref:event.ref, beforeSha:event.beforeSha, afterSha:event.afterSha }, triggerPayload:event.payload, webhookVerified:true });
      if (result.run?.id) await env.CONTROL_DB.prepare("UPDATE cloud_automation_runs SET scm_provider=?, scm_event_id=? WHERE id=? AND owner_sub=?").bind(event.provider, stored.id, result.run.id, trigger.owner_sub).run();
      dispatches.push(result);
    }
    await markScmEventProcessed(env.CONTROL_DB, stored.id);
    return { duplicate:false, eventId:stored.id, dispatches };
  } catch (error) {
    await markScmEventProcessed(env.CONTROL_DB, stored.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function processArtifactsEvent(env: ControlEnv, value: unknown) {
  return processScmEvent(env, normalizeArtifactsEvent(value));
}
