// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyPwaRequest, isSafeCacheResponse, safePushPayload } from "../public/pwa-policy.mjs";

const origin = "https://build.example.com";

describe("PWA cache boundary", () => {
  it("caches only same-origin static assets and uses a dedicated navigation fallback", () => {
    expect(classifyPwaRequest({ url: `${origin}/assets/app.123.js`, method: "GET" }, origin)).toBe("cache-first-static");
    expect(classifyPwaRequest({ url: `${origin}/projects/one`, method: "GET", mode: "navigate" }, origin)).toBe("navigation-fallback");
    expect(classifyPwaRequest({ url: "https://cdn.example.com/app.js", method: "GET" }, origin)).toBe("network-only");
  });

  it.each(["/api/tasks", "/desktop/task", "/evidence/run", "/secrets/key", "/terminal/task", "/preview/task", "/artifacts/file", "/mcp-proxy/server"])("never caches sensitive path %s", (path) => {
    expect(classifyPwaRequest({ url: `${origin}${path}`, method: "GET" }, origin)).toBe("network-only");
  });

  it("never caches authenticated requests, mutations, or private responses", () => {
    expect(classifyPwaRequest({ url: `${origin}/assets/app.js`, method: "GET", headers: { Authorization: "Bearer secret" } }, origin)).toBe("network-only");
    expect(classifyPwaRequest({ url: `${origin}/assets/app.js`, method: "POST" }, origin)).toBe("network-only");
    expect(isSafeCacheResponse(new Response("private", { headers: { "cache-control": "private, no-store" } }))).toBe(false);
    expect(isSafeCacheResponse(new Response("public", { headers: { "cache-control": "public, max-age=3600" } }))).toBe(true);
  });
});

describe("service worker notification privacy", () => {
  it("accepts only the exact identifier-only payload", () => {
    const payload = { version: 1, eventId: "attention_1", taskId: "task_1", kind: "task-completed", createdAt: "2026-07-16T12:00:00Z" };
    expect(safePushPayload(payload)).toEqual({ ...payload, createdAt: "2026-07-16T12:00:00.000Z" });
    expect(safePushPayload({ ...payload, prompt: "secret prompt" })).toBeNull();
    expect(safePushPayload({ ...payload, diff: "private code" })).toBeNull();
  });
});
