// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  aggregateSecurityAuditEvents,
  compileSecurityPolicy,
  credentialRuleForRequest,
  decideFilesystemAccess,
  decideOutboundRequest,
  decideToolUse,
  defaultSecurityPolicy,
  encryptBrokeredSecret,
  normalizeSecurityPolicy,
  redactSecurityValue,
  securityPolicyDigest,
  withDecryptedBrokeredSecret,
} from "./security-policy";

function policy() {
  const value = defaultSecurityPolicy();
  value.network.allowedHosts = ["registry.npmjs.org", "*.example.com"];
  value.tools.allowed = ["browser.open", "mcp.linear.read"];
  value.brokeredCredentials = [{ secretId: "npm", host: "registry.npmjs.org", pathPrefix: "/packages", methods: ["GET"], headerName: "authorization" }];
  return compileSecurityPolicy(value, ["api.x.ai"]);
}

describe("security policy", () => {
  it("normalizes deterministically and rejects unsafe host or wildcard tool rules", async () => {
    const left = defaultSecurityPolicy();
    left.network.allowedHosts = ["B.example.com", "a.example.com"];
    const right = defaultSecurityPolicy();
    right.network.allowedHosts = ["a.example.com", "b.example.com"];
    expect(await securityPolicyDigest(normalizeSecurityPolicy(left))).toBe(await securityPolicyDigest(normalizeSecurityPolicy(right)));
    expect(() => normalizeSecurityPolicy({ ...left, network: { mode: "restricted", allowedHosts: ["127.0.0.1"] } })).toThrow(/Private/);
    expect(() => normalizeSecurityPolicy({ ...left, tools: { allowed: ["mcp.*"], denied: [] } })).toThrow(/exact tool/);
    expect(() => normalizeSecurityPolicy({ ...left, brokeredCredentials: [{ secretId: "bad", host: "*.example.com", pathPrefix: "/", methods: ["GET"], headerName: "authorization" }] })).toThrow(/must be exact/);
  });

  it("enforces public-host, filesystem, and exact-tool boundaries", () => {
    const compiled = policy();
    expect(decideOutboundRequest(compiled, { url: "https://api.x.ai/v1" }).allowed).toBe(true);
    expect(decideOutboundRequest(compiled, { url: "https://cdn.example.com/file" }).allowed).toBe(true);
    expect(decideOutboundRequest(compiled, { url: "https://evil.test/" }).reason).toBe("host-not-allowed");
    expect(decideOutboundRequest(compiled, { url: "https://registry.npmjs.org/", resolvedIp: "10.0.0.2" }).reason).toBe("private-local-or-raw-ip");
    expect(decideFilesystemAccess(compiled, "write", "/workspace/src/app.ts").allowed).toBe(true);
    expect(decideFilesystemAccess(compiled, "read", "/root/.ssh/id_rsa").reason).toBe("denied-path");
    expect(decideFilesystemAccess(compiled, "write", "/etc/hosts").allowed).toBe(false);
    expect(decideToolUse(compiled, "browser.open").allowed).toBe(true);
    expect(decideToolUse(compiled, "git.push").reason).toBe("tool-denied");
    expect(decideToolUse(compiled, "browser.eval").reason).toBe("tool-not-granted");
  });

  it("matches credential injection rules by exact host, path, method, and HTTPS", () => {
    const compiled = policy();
    expect(credentialRuleForRequest(compiled, "npm", { url: "https://registry.npmjs.org/packages/react", method: "GET" })?.secretId).toBe("npm");
    expect(credentialRuleForRequest(compiled, "npm", { url: "https://registry.npmjs.org/packages/react", method: "POST" })).toBeNull();
    expect(credentialRuleForRequest(compiled, "npm", { url: "https://registry.npmjs.org/package/react", method: "GET" })).toBeNull();
    expect(credentialRuleForRequest(compiled, "npm", { url: "http://registry.npmjs.org/packages/react", method: "GET" })).toBeNull();
  });

  it("encrypts with bound context and zeroes transient decrypted bytes", async () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const context = { secretId: "npm", projectId: "project_1", keyVersion: 1 };
    const envelope = await encryptBrokeredSecret("Bearer top-secret", key, context);
    expect(JSON.stringify(envelope)).not.toContain("top-secret");
    let transient: Uint8Array | undefined;
    const length = await withDecryptedBrokeredSecret(envelope, key, context, (plaintext) => {
      transient = plaintext;
      expect(new TextDecoder().decode(plaintext)).toBe("Bearer top-secret");
      return plaintext.byteLength;
    });
    expect(length).toBe(17);
    expect([...transient!].every((byte) => byte === 0)).toBe(true);
    await expect(withDecryptedBrokeredSecret(envelope, key, { ...context, projectId: "other" }, () => undefined)).rejects.toThrow(/context mismatch/);
  });

  it("redacts nested secrets and aggregates decisions", () => {
    expect(redactSecurityValue({ authorization: "Bearer visible", output: "token cfpat_testvalue00000000" })).toEqual({ authorization: "[REDACTED]", output: "token [REDACTED]" });
    const events = [
      { ownerSub: "owner", category: "network" as const, action: "fetch", decision: "denied" as const, target: "evil.test" },
      { ownerSub: "owner", category: "network" as const, action: "fetch", decision: "denied" as const, target: "evil.test" },
      { ownerSub: "owner", category: "tool" as const, action: "invoke", decision: "allowed" as const, target: "browser.open" },
    ];
    expect(aggregateSecurityAuditEvents(events)).toMatchObject({ total: 3, byDecision: { allowed: 1, denied: 2, observed: 0, error: 0 }, deniedTargets: [{ target: "evil.test", count: 2 }] });
  });
});
