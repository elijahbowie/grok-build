// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  SubagentValidationError,
  canTransitionSubagent,
  evaluateHandoffCollection,
  validatePrBabysitInput,
  validateSubagentHandoffInput,
  validateSubagentSpawnInput,
  type SubagentHandoff,
} from "./subagents";

const baseSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const otherSha = "c".repeat(40);

function handoff(id: string, paths: string[], overrides: Partial<SubagentHandoff> = {}): SubagentHandoff {
  return {
    id,
    subagentId: `sub_${id}`,
    parentTaskId: "task_parent",
    projectId: "project_1",
    ownerSub: "owner_1",
    baseSha,
    commitSha: id === "one" ? nextSha : otherSha,
    changedPaths: paths,
    result: { summary: "Implemented" },
    evidence: [{ kind: "test", ref: "npm test" }],
    createdAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("subagent spawn contract", () => {
  it("normalizes bounded task input and unique dependency edges", () => {
    expect(validateSubagentSpawnInput({
      title: "  Implement API  ",
      prompt: "Build the scoped API.",
      model: "grok-4.5",
      dependsOnSubagentIds: ["sub_schema", "sub_security"],
    })).toEqual({
      title: "Implement API",
      prompt: "Build the scoped API.",
      model: "grok-4.5",
      dependsOnSubagentIds: ["sub_schema", "sub_security"],
    });
    expect(() => validateSubagentSpawnInput({ title: "x", prompt: "y", dependsOnSubagentIds: ["sub_a", "sub_a"] })).toThrow(/unique/);
    expect(() => validateSubagentSpawnInput({ title: "x", prompt: "y", dependsOnSubagentIds: ["../other"] })).toThrow(SubagentValidationError);
  });

  it("permits only explicit active-state transitions and reserves completion for a handoff", () => {
    expect(canTransitionSubagent("queued", "running")).toBe(true);
    expect(canTransitionSubagent("running", "blocked")).toBe(true);
    expect(canTransitionSubagent("blocked", "queued")).toBe(true);
    expect(canTransitionSubagent("running", "completed")).toBe(false);
    expect(canTransitionSubagent("completed", "running")).toBe(false);
    expect(canTransitionSubagent("failed", "queued")).toBe(false);
  });
});

describe("immutable handoff contract", () => {
  it("requires exact commits, normalized changed paths, JSON results, and evidence", () => {
    expect(validateSubagentHandoffInput({
      baseSha,
      commitSha: nextSha,
      changedPaths: ["./web/src/App.tsx", "web/src/styles.css"],
      result: { summary: "Done", tests: { passed: 12 } },
      evidence: [{ kind: "test", ref: "npm test", digest: otherSha, label: "Unit tests" }],
    })).toEqual({
      baseSha,
      commitSha: nextSha,
      changedPaths: ["web/src/App.tsx", "web/src/styles.css"],
      result: { summary: "Done", tests: { passed: 12 } },
      evidence: [{ kind: "test", ref: "npm test", digest: otherSha, label: "Unit tests" }],
    });
    expect(() => validateSubagentHandoffInput({ baseSha, commitSha: baseSha, changedPaths: [], result: {}, evidence: [] })).toThrow(/must differ/);
    expect(() => validateSubagentHandoffInput({ baseSha, commitSha: nextSha, changedPaths: ["../secret"], result: {}, evidence: [] })).toThrow(/Invalid/);
    expect(() => validateSubagentHandoffInput({ baseSha, commitSha: nextSha, changedPaths: ["a", "./a"], result: {}, evidence: [] })).toThrow(/unique/);
  });
});

describe("merge and collect gate", () => {
  it("accepts handoffs only for the exact unchanged parent head", () => {
    expect(evaluateHandoffCollection({
      mode: "merge",
      expectedParentHeadSha: baseSha,
      currentParentHeadSha: baseSha,
      handoffs: [handoff("one", ["web/src/App.tsx"]), handoff("two", ["web/src/styles.css"])],
    })).toEqual({
      allowed: true,
      reasons: [],
      expectedParentHeadSha: baseSha,
      changedPaths: ["web/src/App.tsx", "web/src/styles.css"],
    });
  });

  it("reports stale parent and child heads independently", () => {
    const result = evaluateHandoffCollection({
      mode: "collect",
      expectedParentHeadSha: baseSha,
      currentParentHeadSha: otherSha,
      handoffs: [handoff("one", ["web/src/App.tsx"], { baseSha: nextSha })],
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual([
      "Parent head changed after the collection decision was prepared",
      "Handoff one is stale for the expected parent head",
    ]);
  });

  it("rejects overlapping files, duplicate selections, and duplicate commits", () => {
    const result = evaluateHandoffCollection({
      mode: "merge",
      expectedParentHeadSha: baseSha,
      currentParentHeadSha: baseSha,
      handoffs: [handoff("one", ["shared.ts"]), handoff("two", ["shared.ts"], { commitSha: nextSha }), handoff("two", ["other.ts"])],
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "Overlapping change to shared.ts in handoffs one and two",
      "Handoff two was selected more than once",
      `Commit ${nextSha} was supplied by more than one handoff`,
    ]));
  });
});

describe("PR babysit metadata", () => {
  it("keeps monitoring and bounded repair states explicit", () => {
    expect(validatePrBabysitInput({
      repositoryFullName: "elijahbowie/grok-build",
      prNumber: 42,
      mode: "repair",
      status: "repairing",
      repairAttempts: 1,
      maxRepairAttempts: 3,
      lastHeadSha: nextSha,
    })).toMatchObject({ repositoryFullName: "elijahbowie/grok-build", prNumber: 42, mode: "repair", status: "repairing", repairAttempts: 1, maxRepairAttempts: 3 });
    expect(() => validatePrBabysitInput({ repositoryFullName: "not-a-repo", prNumber: 1, mode: "monitor", status: "watching" })).toThrow(/owner\/name/);
    expect(() => validatePrBabysitInput({ repositoryFullName: "owner/repo", prNumber: 1, mode: "monitor", status: "repairing" })).toThrow(/repair mode/);
    expect(() => validatePrBabysitInput({ repositoryFullName: "owner/repo", prNumber: 1, mode: "repair", status: "failed", repairAttempts: 4, maxRepairAttempts: 3 })).toThrow(/exceed/);
  });
});
