import { describe, expect, it } from "vitest";
import { normalizeArtifactsEvent, normalizeGithubEvent, scmEventMatches } from "./scm";

const before = "a".repeat(40);
const after = "b".repeat(40);

describe("SCM normalization", () => {
  it("normalizes an Artifacts push as the canonical event shape", () => {
    const event = normalizeArtifactsEvent({
      type:"cf.artifacts.repo.pushed",
      source:{ type:"artifacts.repo", namespace:"grok-build", repoName:"app" },
      payload:{ ref:"refs/heads/main", before, after, commits:[] },
      metadata:{ eventSubscriptionId:"subscription-1", eventTimestamp:"2026-07-16T12:00:00Z" },
    });
    expect(event).toMatchObject({ provider:"artifacts", eventType:"repo.pushed", repository:"app", ref:"refs/heads/main", beforeSha:before, afterSha:after, actor:{namespace:"grok-build"} });
    expect(scmEventMatches({ event, provider:"artifacts", eventTypes:["repo.pushed"], repositories:["app"], refs:["refs/heads/main"] })).toBe(true);
  });

  it("normalizes GitHub into the same event contract", () => {
    const event = normalizeGithubEvent({ event:"push", delivery:"delivery-1", payload:{ repository:{full_name:"acme/app"}, ref:"refs/heads/main", before, after, sender:{login:"octocat"} } });
    expect(event).toMatchObject({ provider:"github", eventType:"push", repository:"acme/app", ref:"refs/heads/main", beforeSha:before, afterSha:after });
    expect(scmEventMatches({ event, provider:"artifacts", eventTypes:["push"] })).toBe(false);
  });
});
