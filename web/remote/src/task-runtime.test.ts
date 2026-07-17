import { describe, expect, it } from "vitest";
import { compileManagedRuntimePolicy, managedPolicyDigest, marketplaceManifestDigest, renderManagedConfig, renderRequirements, validateInspectReport, validateManagedRuntimePolicy, validateMarketplaceManifest } from "./task-runtime";

async function file(path:string, content:string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return { path, content, sha256:[...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("") };
}

describe("managed task runtime", () => {
  it("compiles restrictive layers without allowing a narrower scope to loosen policy", () => {
    const policy = compileManagedRuntimePolicy([
      { allowedModels:["grok-4", "grok-4.5"], allowedSandboxModes:["read-only", "workspace"], disableBypassPermissions:true, features:{telemetry:true} },
      { allowedModels:["grok-4.5"], allowedSandboxModes:["workspace", "off"], disableBypassPermissions:false, permissionRules:[{action:"deny",tool:"bash",pattern:"git push*"}] },
    ]);
    expect(policy).toMatchObject({ allowedModels:["grok-4.5"], allowedSandboxModes:["workspace"], disableBypassPermissions:true, features:{telemetry:true} });
    expect(policy.permissionRules).toEqual([{action:"deny",tool:"bash",pattern:"git push*"}]);
  });

  it("renders native Grok config and fail-closed requirements", () => {
    const policy = validateManagedRuntimePolicy({ allowedModels:["grok-4.5"], allowedSandboxModes:["strict"], disableBypassPermissions:true, permissionRules:[{action:"ask",tool:"webfetch",pattern:"example.com",patternMode:"domain"}] });
    expect(renderManagedConfig(policy, ["/home/grok/tasks/t/plugins/review"])).toContain("[models]\nallowed_models = [\"grok-4.5\"]");
    expect(renderManagedConfig(policy, ["/home/grok/tasks/t/plugins/review"])).toContain("[[permission.rules]]");
    expect(renderRequirements(policy)).toContain("fail_closed = true");
    expect(renderRequirements(policy)).toContain("disable_bypass_permissions_mode = true");
    expect(()=>renderRequirements(validateManagedRuntimePolicy({allowedSandboxModes:["read-only"]}))).toThrow(/required strict sandbox/);
  });

  it("validates and enables native Grok language servers", () => {
    const policy = validateManagedRuntimePolicy({ lspServers:{
      typescript:{ command:"typescript-language-server", args:["--stdio", "--log-level", "4", "--log-level", "4"], extensionToLanguage:{".ts":"typescript", ".tsx":"typescriptreact"}, startupTimeout:30_000 },
    } });
    expect(policy.lspServers?.typescript).toMatchObject({ command:"typescript-language-server", extensionToLanguage:{".ts":"typescript"} });
    expect(policy.lspServers?.typescript.args).toEqual(["--stdio", "--log-level", "4", "--log-level", "4"]);
    expect(renderManagedConfig(policy, [])).toContain("lsp_tools = true");
    expect(() => validateManagedRuntimePolicy({lspServers:{bad:{command:"typescript-language-server",extensionToLanguage:{ts:"typescript"}}}})).toThrow("extensionToLanguage contains an invalid entry");
    expect(() => validateManagedRuntimePolicy({lspServers:{bad:{command:"custom-language-server",extensionToLanguage:{".ts":"typescript"}}}})).toThrow("not an installed managed language server");
  });

  it("requires inspect evidence for every managed language server", () => {
    const report = { plugins:[], lspServers:[{name:"typescript",command:"typescript-language-server",untrusted:false}], configSources:{layers:[{kind:"managed"}]} };
    expect(validateInspectReport(report, [], ["typescript"])).toBe(report);
    expect(() => validateInspectReport({...report,lspServers:[]}, [], ["typescript"])).toThrow("did not load managed LSP server");
  });

  it("requires both the approved manifest digest and every embedded file digest", async () => {
    const manifest = { schemaVersion:1 as const, files:[await file("skills/review/SKILL.md", "---\nname: review\n---\nReview carefully.")] };
    const row = { id:"market_1", kind:"skill", name:"Review", version:"1.0.0", source:"embedded", digest:await marketplaceManifestDigest(manifest), manifest_json:JSON.stringify(manifest) };
    await expect(validateMarketplaceManifest(row)).resolves.toMatchObject(manifest);
    await expect(validateMarketplaceManifest({...row,digest:"tampered"})).rejects.toThrow("digest does not match");
    const tampered = structuredClone(manifest); tampered.files[0].content = "changed";
    await expect(validateMarketplaceManifest({...row,digest:await marketplaceManifestDigest(tampered),manifest_json:JSON.stringify(tampered)})).rejects.toThrow("file skills/review/SKILL.md digest does not match");
  });

  it("rejects traversal and manifests that do not provide their declared component", async () => {
    const traversal = { schemaVersion:1 as const, files:[await file("../escape", "x")] };
    await expect(validateMarketplaceManifest({id:"m",kind:"plugin",name:"x",version:"1",source:"x",digest:await marketplaceManifestDigest(traversal),manifest_json:JSON.stringify(traversal)})).rejects.toThrow("path is invalid");
    const wrongKind = { schemaVersion:1 as const, files:[await file("README.md", "x")] };
    await expect(validateMarketplaceManifest({id:"m",kind:"hook",name:"x",version:"1",source:"x",digest:await marketplaceManifestDigest(wrongKind),manifest_json:JSON.stringify(wrongKind)})).rejects.toThrow("required native Grok component");
  });

  it("validates inspect evidence for effective config and every staged extension", async () => {
    const report = { plugins:[{name:"review",path:"/plugins/review",enabled:true}], configSources:{layers:[{kind:"managed"}]} };
    expect(validateInspectReport(report,[{name:"review",directory:"/plugins/review"}])).toBe(report);
    expect(() => validateInspectReport({...report,plugins:[]},[{name:"review",directory:"/plugins/review"}])).toThrow("did not load");
    await expect(managedPolicyDigest({allowedModels:["grok-4.5"]})).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
