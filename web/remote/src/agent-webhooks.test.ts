import { describe, expect, it } from "vitest";
import { signAgentWebhook } from "./agent-webhooks";

describe("Agent API webhook signatures", () => {
  it("signs the exact timestamp and raw body deterministically", async () => {
    const first = await signAgentWebhook("secret", "2026-07-16T12:00:00.000Z", '{"event":"agent.completed"}');
    const second = await signAgentWebhook("secret", "2026-07-16T12:00:00.000Z", '{"event":"agent.completed"}');
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(signAgentWebhook("secret", "2026-07-16T12:00:01.000Z", '{"event":"agent.completed"}')).resolves.not.toBe(first);
  });
});
