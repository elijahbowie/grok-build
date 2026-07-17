import { describe, expect, it } from "vitest";
import { defaultSecurityPolicy } from "./security-policy";
import { applyJobToolContract, assertStrictSandboxFilesystemPolicy, nativePermissionConfig, permissionCliArgs } from "./runtime-security";

describe("native Grok runtime security", () => {
  it("uses native dontAsk rules without bypassing permissions", () => {
    const config = nativePermissionConfig(defaultSecurityPolicy());
    expect(config.mode).toBe("dontAsk");
    expect(config.allow).toContain("Bash(npm test*)");
    expect(config.allow).not.toContain("Bash(*)");
    expect(config.deny).toContain("Bash(git push*)");
    expect(config.deny).toContain("Bash(sudo*)");
    expect(config.deny).toContain("WebFetch");
    expect(permissionCliArgs(config)).not.toContain("bypassPermissions");
  });

  it("turns policy roots, hosts, and MCP tools into native rules", () => {
    const policy = defaultSecurityPolicy();
    policy.network.allowedHosts = ["api.example.com", "*.cdn.example.com"];
    policy.filesystem.deniedPaths.push("/workspace/private");
    policy.tools.allowed.push("mcp:linear__issues_create");
    const config = nativePermissionConfig(policy);
    expect(config.allow).toContain("WebFetch(domain:api.example.com)");
    expect(config.allow).toContain("WebFetch(domain:cdn.example.com)");
    expect(config.allow).toContain("MCPTool(linear__issues_create)");
    expect(config.deny).toContain("Read(/workspace/private/**)");
    expect(config.deny).toContain("Edit(private/**)");
    expect(config.deny).not.toContain("WebFetch");
  });

  it("makes review-only sessions native plan sessions with no writes or shell", () => {
    const config = nativePermissionConfig(defaultSecurityPolicy(), true);
    expect(config.mode).toBe("plan");
    expect(config.deny).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(*)"]));
  });

  it("intersects a structured job allowlist with the pinned policy", () => {
    const config=applyJobToolContract(nativePermissionConfig(defaultSecurityPolicy()),["Read","Grep"],["Read(.env)"],"off");
    expect(config.allow.some((rule)=>rule.startsWith("Edit"))).toBe(false);
    expect(config.deny).toEqual(expect.arrayContaining(["Bash(*)","Edit","WebSearch","WebFetch","Read(.env)"]));
  });

  it("rejects unknown and overbroad structured tool rules", () => {
    const config=nativePermissionConfig(defaultSecurityPolicy());
    expect(()=>applyJobToolContract(config,["Bash(*)"],[],"allow")).toThrow(/overbroad/);
    expect(()=>applyJobToolContract(config,["MadeUpTool"],[],"allow")).toThrow(/unknown/);
    expect(()=>applyJobToolContract(config,["Read(\/etc\/**)"],[],"allow")).toThrow(/not permitted/);
    expect(()=>applyJobToolContract(config,["Bash(curl *)"],[],"allow")).toThrow(/not permitted/);
  });

  it("rejects filesystem policy a repository shell command could bypass", () => {
    const policy=defaultSecurityPolicy();
    assertStrictSandboxFilesystemPolicy(policy,"/workspace/repository");
    policy.filesystem.deniedPaths.push("/workspace/repository/future-secret");
    expect(()=>assertStrictSandboxFilesystemPolicy(policy,"/workspace/repository")).toThrow(/intersects the task checkout/);
    policy.filesystem.deniedPaths.pop();
    policy.filesystem.writeRoots=["/workspace/repository/src"];
    expect(()=>assertStrictSandboxFilesystemPolicy(policy,"/workspace/repository")).toThrow(/complete task checkout/);
  });

});
