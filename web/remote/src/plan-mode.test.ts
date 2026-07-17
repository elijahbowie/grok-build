// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PlanValidationError,
  decidePlanCapability,
  evaluateBuildGate,
  planDigest,
  validateStepTransition,
  validateStructuredPlan,
} from "./plan-mode";

function validPlan() {
  return {
    goal: "Ship an independently verified feature",
    assumptions: ["The repository is available"],
    steps: [
      { id: "inspect", title: "Inspect", description: "Inspect the current implementation.", dependencies: [], acceptanceChecks: ["Relevant files identified"] },
      { id: "implement", title: "Implement", description: "Implement the requested behavior.", dependencies: ["inspect"], acceptanceChecks: ["Focused tests pass"] },
      { id: "verify", title: "Verify", description: "Run the complete verification suite.", dependencies: ["implement"], acceptanceChecks: ["Production build passes"] },
    ],
    acceptanceChecks: ["All required behavior is proven"],
  };
}

describe("structured Plan Mode", () => {
  it("validates ordered steps and normalizes plan text", () => {
    const plan = validPlan();
    plan.goal = `  ${plan.goal}  `;
    expect(validateStructuredPlan(plan)).toMatchObject({ goal: "Ship an independently verified feature", steps: [{ id: "inspect" }, { id: "implement" }, { id: "verify" }] });
    expect(() => validateStructuredPlan({ ...validPlan(), steps: [validPlan().steps[1], validPlan().steps[0]] })).toThrow(/earlier step/);
    expect(() => validateStructuredPlan({ ...validPlan(), acceptanceChecks: [] })).toThrow(/cannot be empty/);
  });

  it("rejects duplicate, malformed, and uncheckable plans", () => {
    const duplicate = validPlan();
    duplicate.steps[1].id = "inspect";
    expect(() => validateStructuredPlan(duplicate)).toThrow(/duplicate/);
    const malformed = validPlan() as any;
    malformed.steps[0].id = "Bad Step";
    expect(() => validateStructuredPlan(malformed)).toThrow(/lowercase/);
    const missingChecks = validPlan() as any;
    missingChecks.steps[0].acceptanceChecks = [];
    expect(() => validateStructuredPlan(missingChecks)).toThrow(/cannot be empty/);
  });

  it("creates a deterministic content digest", async () => {
    const left = await planDigest(validPlan());
    const right = await planDigest(JSON.parse(JSON.stringify(validPlan())));
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(right).toBe(left);
  });

  it("keeps planning read-only while allowing steering and decisions", () => {
    expect(decidePlanCapability("planning", "read").allowed).toBe(true);
    expect(decidePlanCapability("planning", "queue_message").allowed).toBe(true);
    expect(decidePlanCapability("awaiting_approval", "plan_decision").allowed).toBe(true);
    expect(decidePlanCapability("planning", "workspace_write")).toEqual({ allowed: false, reason: "planning-is-read-only" });
    expect(decidePlanCapability("approved", "command_execute").allowed).toBe(false);
    expect(decidePlanCapability("building", "workspace_write").allowed).toBe(true);
  });

  it("requires approval of the exact current revision before build", () => {
    const approved = evaluateBuildGate({ requestedRevisionId: "pln_2", currentRevisionId: "pln_2", approvedRevisionId: "pln_2", revisionStatus: "approved", executionPhase: "approved" });
    expect(approved).toEqual({ allowed: true, reasons: [] });
    const stale = evaluateBuildGate({ requestedRevisionId: "pln_1", currentRevisionId: "pln_2", approvedRevisionId: "pln_2", revisionStatus: "approved", executionPhase: "approved" });
    expect(stale.allowed).toBe(false);
    expect(stale.reasons).toEqual(expect.arrayContaining(["Requested plan revision is not current", "Exact plan revision has not been approved"]));
  });

  it("enforces dependency-safe, forward-only step transitions", () => {
    const states = { inspect: "pending", implement: "pending", verify: "pending" } as const;
    expect(() => validateStepTransition({ from: "pending", to: "in_progress", dependencies: ["inspect"], stepStates: states })).toThrow(/unmet dependencies/);
    expect(validateStepTransition({ from: "pending", to: "in_progress", dependencies: ["inspect"], stepStates: { ...states, inspect: "completed" } })).toBe(true);
    expect(() => validateStepTransition({ from: "in_progress", to: "pending", dependencies: [], stepStates: states })).toThrow(/Invalid step transition/);
    expect(() => validateStepTransition({ from: "pending", to: "blocked", dependencies: [], stepStates: states })).toThrow(/require a reason/);
    expect(validateStepTransition({ from: "pending", to: "skipped", dependencies: [], stepStates: states, reason: "Not applicable" })).toBe(true);
    expect(() => validateStepTransition({ from: "completed", to: "in_progress", dependencies: [], stepStates: states })).toThrow(PlanValidationError);
  });
});
