import type { ControlEnv } from "./types";

type TelemetryAttributes = {
  taskId?:string; projectId?:string; organizationId?:string; status?:string; modelProfileId?:string;
  modelBackend?:string; permissionMode?:string; automation?:boolean; durationMs?:number; inputTokens?:number;
  outputTokens?:number; costMicros?:number; errorClass?:string;
};

export type TaskTelemetryEvent = {
  name:string;
  timestamp?:Date;
  level?:"INFO"|"WARN"|"ERROR";
  attributes?:TelemetryAttributes;
  metrics?:Array<{name:string;value:number;unit?:string}>;
};

const attributeNames = new Set<keyof TelemetryAttributes>([
  "taskId", "projectId", "organizationId", "status", "modelProfileId", "modelBackend", "permissionMode",
  "automation", "durationMs", "inputTokens", "outputTokens", "costMicros", "errorClass",
]);

function safeText(value: unknown) {
  return typeof value === "string" ? value.replace(/[\r\n\0]/g, " ").slice(0, 200) : undefined;
}

export function sanitizeTelemetryAttributes(value: Record<string, unknown> = {}) {
  const result:Record<string, string|number|boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!attributeNames.has(key as keyof TelemetryAttributes)) continue;
    if (typeof raw === "string") { const text = safeText(raw); if (text) result[key] = text; }
    else if (typeof raw === "boolean") result[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) result[key] = raw;
  }
  return result;
}

function anyValue(value:string|number|boolean) {
  if (typeof value === "string") return { stringValue:value };
  if (typeof value === "boolean") return { boolValue:value };
  return Number.isInteger(value) ? { intValue:String(value) } : { doubleValue:value };
}

function otlpAttributes(attributes:Record<string, string|number|boolean>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value:anyValue(value) }));
}

function unixNanos(date:Date) { return `${date.getTime()}000000`; }

export function buildOtlpPayloads(event: TaskTelemetryEvent) {
  const timestamp = event.timestamp ?? new Date(); const attributes = sanitizeTelemetryAttributes(event.attributes as Record<string, unknown> ?? {});
  const resource = { attributes:[{ key:"service.name", value:{ stringValue:"grok-build" } }] };
  const scope = { name:"grok-build.control-plane", version:"1" };
  const log = {
    resourceLogs:[{ resource, scopeLogs:[{ scope, logRecords:[{
      timeUnixNano:unixNanos(timestamp), severityText:event.level ?? "INFO", body:{ stringValue:safeText(event.name) || "task.event" }, attributes:otlpAttributes(attributes),
    }] }] }],
  };
  const metricValues = (event.metrics ?? []).filter((metric) => /^[a-z][a-z0-9_.]{0,119}$/.test(metric.name) && Number.isFinite(metric.value));
  const metrics = metricValues.length ? {
    resourceMetrics:[{ resource, scopeMetrics:[{ scope, metrics:metricValues.map((metric) => ({
      name:metric.name, unit:metric.unit?.slice(0, 40) || "1", gauge:{ dataPoints:[{ timeUnixNano:unixNanos(timestamp), asDouble:metric.value, attributes:otlpAttributes(attributes) }] },
    })) }] }],
  } : null;
  return { log, metrics };
}

function collectorUrl(endpoint:string, signal:"logs"|"metrics") {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("OTLP endpoint must use HTTPS");
  url.username = ""; url.password = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/${signal}`;
  return url.toString();
}

async function post(env: ControlEnv, signal:"logs"|"metrics", body:unknown) {
  if (!env.OTLP_ENDPOINT) return true;
  const headers = new Headers({ "content-type":"application/json" });
  if (env.OTLP_AUTH_TOKEN) headers.set("authorization", `Bearer ${env.OTLP_AUTH_TOKEN}`);
  const response = await fetch(collectorUrl(env.OTLP_ENDPOINT, signal), { method:"POST", headers, body:JSON.stringify(body), signal:AbortSignal.timeout(5_000) });
  return response.ok;
}

// Telemetry is deliberately best-effort: observability must never change task outcome.
export async function emitTaskTelemetry(env: ControlEnv, event: TaskTelemetryEvent) {
  if (!env.OTLP_ENDPOINT) return true;
  try {
    const payloads = buildOtlpPayloads(event);
    const results = await Promise.all([post(env, "logs", payloads.log), ...(payloads.metrics ? [post(env, "metrics", payloads.metrics)] : [])]);
    return results.every(Boolean);
  } catch { return false; }
}
