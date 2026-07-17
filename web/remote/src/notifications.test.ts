// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  backgroundRefreshPolicy,
  buildLiveTaskActivity,
  createPrivateNotificationPayload,
  notificationText,
  sealPushSubscription,
  validateNotificationPreferences,
  validatePrivateNotificationPayload,
  withUnsealedPushSubscription,
} from "./notifications";

describe("private task notifications", () => {
  it("produces an exact identifier-only payload with generic copy", () => {
    const payload = createPrivateNotificationPayload({ eventId: "attention_1", taskId: "task_1", kind: "approval-needed", createdAt: "2026-07-16T12:00:00.000Z" });
    expect(payload).toEqual({ version: 1, eventId: "attention_1", taskId: "task_1", kind: "approval-needed", createdAt: "2026-07-16T12:00:00.000Z" });
    expect(JSON.stringify({ payload, ...notificationText(payload.kind) })).not.toMatch(/prompt|code|diff|secret|repository/i);
  });

  it("rejects extra fields that could leak prompts, code, or errors", () => {
    const base = { version: 1, eventId: "attention_1", taskId: "task_1", kind: "task-failed", createdAt: "2026-07-16T12:00:00.000Z" };
    expect(() => validatePrivateNotificationPayload({ ...base, prompt: "private task request" })).toThrow(/sensitive fields/);
    expect(() => validatePrivateNotificationPayload({ ...base, error: "Bearer secret" })).toThrow(/sensitive fields/);
    expect(() => validatePrivateNotificationPayload({ ...base, code: "source" })).toThrow(/sensitive fields/);
  });

  it("validates preferences and encrypts the complete push capability", async () => {
    expect(validateNotificationPreferences({ taskCompleted: false, approvalNeeded: true })).toEqual({ taskCompleted: false, taskFailed: true, approvalNeeded: true });
    expect(() => validateNotificationPreferences({ taskFailed: "yes" })).toThrow(/boolean/);
    const key = Buffer.alloc(32, 7).toString("base64url");
    const sealed = await sealPushSubscription({ endpoint: "https://push.example.test/subscription/private", keys: { p256dh: "a".repeat(65), auth: "b".repeat(24) }, expirationTime: null }, key, { ownerSub: "owner_1", subscriptionId: "push_1" });
    expect(sealed.envelope).not.toContain("push.example.test");
    expect(sealed.envelope).not.toContain("a".repeat(65));
    expect(sealed.endpointHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(withUnsealedPushSubscription(sealed.envelope, key, { ownerSub: "owner_1", subscriptionId: "push_1" }, (subscription) => subscription.endpoint)).resolves.toBe("https://push.example.test/subscription/private");
    await expect(withUnsealedPushSubscription(sealed.envelope, key, { ownerSub: "another_owner", subscriptionId: "push_1" }, () => null)).rejects.toThrow(/context mismatch/);
  });
});

describe("mobile live state and background refresh", () => {
  it("reports semantic phases without fake progress or sensitive task fields", () => {
    expect(buildLiveTaskActivity({ id: "task_1", status: "review", updatedAt: "2026-07-16T12:00:00Z" }, "approval-needed")).toEqual({ taskId: "task_1", state: "attention", phase: "Ready for review", updatedAt: "2026-07-16T12:00:00.000Z", attention: "approval-needed", terminal: false });
  });

  it("allows only read-only refreshes in background sync", () => {
    expect(backgroundRefreshPolicy("GET", "/api/tasks/task_1")).toEqual({ allowed: true, reason: "read-only-refresh" });
    expect(backgroundRefreshPolicy("POST", "/api/tasks/task_1/promote")).toEqual({ allowed: false, reason: "background-sync-is-read-only" });
    expect(backgroundRefreshPolicy("DELETE", "/api/tasks/task_1").allowed).toBe(false);
  });
});
