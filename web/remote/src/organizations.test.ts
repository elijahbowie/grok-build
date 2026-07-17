import { describe, expect, it } from "vitest";
import { organizationRoleAllows, projectRoleAllows } from "./organizations";

describe("organization role boundaries", () => {
  it("keeps review access below write and administration access", () => {
    expect(organizationRoleAllows("reviewer", "viewer")).toBe(true);
    expect(organizationRoleAllows("reviewer", "developer")).toBe(false);
    expect(projectRoleAllows("reviewer", "reviewer")).toBe(true);
    expect(projectRoleAllows("reviewer", "developer")).toBe(false);
  });
});
