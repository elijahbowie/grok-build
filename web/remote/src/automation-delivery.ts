import { connectorFetch } from "./connectors";
import { id, now } from "./db";
import type { ControlEnv } from "./types";

type DestinationRow = {
  id:string; automation_id:string; kind:"in_app"|"webhook"|"email"|"slack"; label:string;
  destination_ref:string; event_types_json:string;
};

export type AutomationDeliveryEvent = "run.review" | "run.completed" | "run.failed" | "run.cancelled";

export async function deliverAutomationEvent(env: ControlEnv, input: { ownerSub:string; runId:string; eventType:AutomationDeliveryEvent }) {
  const run = await env.CONTROL_DB.prepare(`SELECT r.*, a.name automation_name, p.name project_name, p.artifact_repo
    FROM cloud_automation_runs r JOIN cloud_automations a ON a.id=r.automation_id
    JOIN projects p ON p.id=r.project_id WHERE r.id=? AND r.owner_sub=?`).bind(input.runId, input.ownerSub).first<Record<string, unknown>>();
  if (!run) return [];
  const destinations = await env.CONTROL_DB.prepare(`SELECT d.* FROM cloud_automation_destinations d
    JOIN cloud_automations a ON a.id=d.automation_id
    WHERE d.automation_id=? AND a.owner_sub=? AND d.enabled=1`).bind(run.automation_id, input.ownerSub).all<DestinationRow>();
  const results: Array<{destinationId:string;status:"delivered"|"failed";error?:string}> = [];
  for (const destination of destinations.results) {
    const events = JSON.parse(destination.event_types_json) as string[];
    if (!events.includes(input.eventType) && !events.includes("*")) continue;
    const attemptId = id("adel"); const timestamp = now();
    await env.CONTROL_DB.prepare(`INSERT OR IGNORE INTO automation_delivery_attempts
      (id, run_id, destination_id, event_type, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'delivering', 1, ?, ?)`).bind(attemptId, input.runId, destination.id, input.eventType, timestamp, timestamp).run();
    const current = await env.CONTROL_DB.prepare("SELECT id, status FROM automation_delivery_attempts WHERE run_id=? AND destination_id=? AND event_type=?")
      .bind(input.runId, destination.id, input.eventType).first<{id:string;status:string}>();
    if (!current || current.status === "delivered") continue;
    if (current.status === "failed") await env.CONTROL_DB.prepare("UPDATE automation_delivery_attempts SET status='delivering',attempts=attempts+1,error=NULL,updated_at=? WHERE id=?").bind(now(),current.id).run();
    try {
      if (destination.kind !== "in_app") {
        const payload = {
          event: input.eventType,
          run: { id:run.id, status:run.status, taskId:run.task_id, reason:run.reason, error:run.error },
          automation: { id:run.automation_id, name:run.automation_name },
          project: { id:run.project_id, name:run.project_name, canonicalScm:"artifacts", repository:run.artifact_repo },
        };
        const body = destination.kind === "slack"
          ? { text:`Grok Build ${input.eventType}: ${String(run.automation_name)}`, blocks:[{ type:"section", text:{ type:"mrkdwn", text:`*${String(run.automation_name)}* — ${input.eventType}\nCanonical repository: \`${String(run.artifact_repo)}\`` } }] }
          : destination.kind === "email"
            ? { subject:`Grok Build: ${String(run.automation_name)} ${input.eventType}`, text:JSON.stringify(payload, null, 2), event:payload }
            : payload;
        const response = await connectorFetch(env, destination.destination_ref, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body) });
        if (!response.ok) throw new Error(`Delivery endpoint returned ${response.status}`);
        await env.CONTROL_DB.prepare("UPDATE automation_delivery_attempts SET status='delivered', response_status=?, delivered_at=?, updated_at=? WHERE id=?")
          .bind(response.status, now(), now(), current.id).run();
      } else {
        await env.CONTROL_DB.prepare("UPDATE automation_delivery_attempts SET status='delivered', response_status=204, delivered_at=?, updated_at=? WHERE id=?")
          .bind(now(), now(), current.id).run();
      }
      results.push({ destinationId:destination.id, status:"delivered" });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Delivery failed";
      await env.CONTROL_DB.prepare("UPDATE automation_delivery_attempts SET status='failed', error=?, updated_at=? WHERE id=?").bind(message, now(), current.id).run();
      results.push({ destinationId:destination.id, status:"failed", error:message });
    }
  }
  return results;
}

export async function retryAutomationDeliveries(env:ControlEnv) {
  const rows = await env.CONTROL_DB.prepare(`SELECT da.run_id,da.event_type,r.owner_sub FROM automation_delivery_attempts da
    JOIN cloud_automation_runs r ON r.id=da.run_id WHERE da.status='failed' AND da.attempts<5 GROUP BY da.run_id,da.event_type,r.owner_sub ORDER BY MIN(da.updated_at) LIMIT 100`)
    .all<{run_id:string;event_type:AutomationDeliveryEvent;owner_sub:string}>();
  for (const row of rows.results) await deliverAutomationEvent(env, { ownerSub:row.owner_sub, runId:row.run_id, eventType:row.event_type });
  return rows.results.length;
}

export async function listAutomationDeliveries(db: D1Database, ownerSub: string, automationId: string) {
  const rows = await db.prepare(`SELECT da.*, d.kind, d.label FROM automation_delivery_attempts da
    JOIN cloud_automation_destinations d ON d.id=da.destination_id
    JOIN cloud_automations a ON a.id=d.automation_id
    WHERE a.id=? AND a.owner_sub=? ORDER BY da.created_at DESC LIMIT 200`).bind(automationId, ownerSub).all();
  return rows.results;
}
