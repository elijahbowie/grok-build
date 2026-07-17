const PRIVATE_PATH = /^\/(?:api|desktop|evidence|secrets|terminal|preview|artifacts|mcp-proxy)(?:\/|$)/i;
const STATIC_PATH = /^(?:\/assets\/[^?#]+\.(?:css|js|mjs|woff2?|png|jpg|jpeg|gif|webp|svg)|\/(?:design-polish\.css|manifest\.webmanifest|offline\.html|grok-build-icon\.svg|grok-build-maskable\.svg))$/i;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
export const ATTENTION_KINDS = ["task-completed", "task-failed", "approval-needed"];

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : null;
}
export function classifyPwaRequest(input, appOrigin) {
  const url = new URL(input.url, appOrigin);
  const method = String(input.method || "GET").toUpperCase();
  if (method !== "GET") return "network-only";
  if (url.origin !== appOrigin) return "network-only";
  if (PRIVATE_PATH.test(url.pathname)) return "network-only";
  if (headerValue(input.headers, "authorization") || headerValue(input.headers, "x-api-key")) return "network-only";
  if (input.mode === "navigate") return "navigation-fallback";
  if (STATIC_PATH.test(url.pathname)) return "cache-first-static";
  return "network-only";
}

export function isSafeCacheResponse(response) {
  if (!response || !response.ok || response.type === "opaque") return false;
  const cacheControl = response.headers?.get?.("cache-control") || "";
  const vary = response.headers?.get?.("vary") || "";
  return !/(?:private|no-store)/i.test(cacheControl) && !/(?:authorization|cookie)/i.test(vary) && !response.headers?.has?.("set-cookie");
}

export function safePushPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).sort().join(",") !== "createdAt,eventId,kind,taskId,version" || input.version !== 1) return null;
  if (!IDENTIFIER.test(input.eventId) || !IDENTIFIER.test(input.taskId) || !ATTENTION_KINDS.includes(input.kind)) return null;
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) return null;
  return { version: 1, eventId: input.eventId, taskId: input.taskId, kind: input.kind, createdAt: new Date(input.createdAt).toISOString() };
}

export function pushText(kind) {
  if (kind === "approval-needed") return { title: "Grok Build needs your approval", body: "Open Grok Build to review the requested action." };
  if (kind === "task-failed") return { title: "A Grok Build task needs attention", body: "Open Grok Build to inspect the failure and recovery options." };
  return { title: "A Grok Build task completed", body: "Open Grok Build to review the result and evidence." };
}
