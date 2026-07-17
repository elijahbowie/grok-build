import { describe, expect, it } from "vitest";
import { agentApiProjectAllowed, requireAgentApiScope } from "./agent-api-auth";

const identity = { keyId:"key", ownerSub:"owner", organizationId:null, scopes:["agents:read" as const], projectIds:["prj_one"] };

describe("agent API authorization", () => {
  it("requires exact scopes and project grants", () => {
    expect(() => requireAgentApiScope(identity, "agents:read")).not.toThrow();
    expect(() => requireAgentApiScope(identity, "agents:write")).toThrow(/scope/);
    expect(agentApiProjectAllowed(identity, "prj_one")).toBe(true);
    expect(agentApiProjectAllowed(identity, "prj_two")).toBe(false);
  });
});
