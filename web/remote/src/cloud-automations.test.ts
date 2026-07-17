import { describe, expect, it } from "vitest";
import {
  AutomationValidationError,
  decideAutomationAdmission,
  matchesGithubTrigger,
  matchesWebhookTrigger,
  nextScheduledTime,
  signWebhookBody,
  validateSafeSchedule,
  validateTriggerConfig,
  verifyWebhookHmac,
} from "./cloud-automations";

describe("safe automation schedules", () => {
  it("calculates interval, daily, and weekly occurrences in UTC", () => {
    expect(nextScheduledTime({ kind:"interval", minutes:15, anchor:"2026-01-01T00:00:00.000Z" }, "2026-01-01T00:16:00.000Z")).toBe("2026-01-01T00:30:00.000Z");
    expect(nextScheduledTime({ kind:"daily", hour:9, minute:30 }, "2026-01-01T09:30:00.000Z")).toBe("2026-01-02T09:30:00.000Z");
    expect(nextScheduledTime({ kind:"weekly", weekdays:[1], hour:10, minute:0 }, "2026-01-02T12:00:00.000Z")).toBe("2026-01-05T10:00:00.000Z");
  });

  it("rejects schedules that are too frequent or ambiguous", () => {
    expect(() => validateSafeSchedule({ kind:"interval", minutes:1, anchor:"2026-01-01T00:00:00Z" })).toThrow(AutomationValidationError);
    expect(() => validateSafeSchedule({ kind:"weekly", weekdays:[1,1], hour:1, minute:0 })).toThrow(/duplicates/);
    expect(() => validateSafeSchedule({ kind:"cron", expression:"* * * * *" })).toThrow(/kind/);
  });
});

describe("strict trigger filters", () => {
  it("requires every generic webhook filter to match exactly", () => {
    const config = { filters:[{ path:"repository.full_name", value:"acme/app" }, { path:"action", value:"deploy" }] };
    expect(matchesWebhookTrigger(config, { repository:{ full_name:"acme/app" }, action:"deploy" })).toBe(true);
    expect(matchesWebhookTrigger(config, { repository:{ full_name:"acme/app" }, action:"DEPLOY" })).toBe(false);
    expect(matchesWebhookTrigger(config, { repository:{ full_name:"acme/app" } })).toBe(false);
  });

  it("matches only configured GitHub events, actions, branches, and paths", () => {
    const config = { events:["pull_request"], actions:["opened","synchronize"], branches:["main"], pathPrefixes:["web/remote"] };
    expect(matchesGithubTrigger(config, { event:"pull_request", action:"opened", branch:"main", changedPaths:["web/remote/src/api.ts"] })).toBe(true);
    expect(matchesGithubTrigger(config, { event:"push", action:"opened", branch:"main", changedPaths:["web/remote/src/api.ts"] })).toBe(false);
    expect(matchesGithubTrigger(config, { event:"pull_request", action:"opened", branch:"main", changedPaths:["web/src/App.tsx"] })).toBe(false);
  });

  it("rejects wildcard and traversal-style trigger configuration", () => {
    expect(() => validateTriggerConfig("github", { events:["push"], actions:[], branches:["*"], pathPrefixes:[] })).toThrow(/invalid/);
    expect(() => validateTriggerConfig("webhook", { filters:[{ path:"__proto__.polluted", value:true }] })).toThrow(/unsafe/);
    expect(() => validateTriggerConfig("webhook", { filters:[{ path:"repo..name", value:"x" }] })).toThrow(/invalid/);
    expect(() => validateTriggerConfig("github", { events:["push"], actions:[], branches:[], pathPrefixes:[], typo:true })).toThrow(/unknown field/);
  });
});

describe("signed webhook admission", () => {
  it("verifies the exact timestamped body and rejects tampering and replay", async () => {
    const secret = "a sufficiently long webhook secret";
    const timestamp = "1784203200";
    const signature = await signWebhookBody({ secret, body:'{"ok":true}', timestamp });
    const at = new Date("2026-07-16T12:00:30.000Z");
    expect(await verifyWebhookHmac({ secret, body:'{"ok":true}', timestamp, signature, now:at })).toBe(true);
    expect(await verifyWebhookHmac({ secret, body:'{"ok":false}', timestamp, signature, now:at })).toBe(false);
    expect(await verifyWebhookHmac({ secret, body:'{"ok":true}', timestamp, signature, now:new Date("2026-07-16T12:10:00.000Z") })).toBe(false);
  });

  it("rejects malformed signatures and weak secrets", async () => {
    expect(await verifyWebhookHmac({ secret:"short", body:"x", timestamp:"1784203200", signature:`sha256=${"a".repeat(64)}`, now:new Date("2026-07-16T12:00:00Z") })).toBe(false);
    expect(await verifyWebhookHmac({ secret:"a sufficiently long secret", body:"x", timestamp:"not-time", signature:"bad" })).toBe(false);
  });
});

describe("automation run admission policy", () => {
  it("applies rate limits before concurrency and queues only admitted work", () => {
    expect(decideAutomationAdmission({ recentRuns:20, activeRuns:0, rateLimitCount:20, concurrencyLimit:1, concurrencyPolicy:"skip" })).toEqual({ status:"rate_limited", admitted:false, reason:"rate-limit-exceeded" });
    expect(decideAutomationAdmission({ recentRuns:1, activeRuns:1, rateLimitCount:20, concurrencyLimit:1, concurrencyPolicy:"skip" })).toEqual({ status:"skipped", admitted:false, reason:"concurrency-limit-reached" });
    expect(decideAutomationAdmission({ recentRuns:1, activeRuns:8, rateLimitCount:20, concurrencyLimit:1, concurrencyPolicy:"queue" })).toEqual({ status:"queued", admitted:true, reason:null });
  });
});
