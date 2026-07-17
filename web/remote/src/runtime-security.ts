import type { SecurityPolicy } from "./security-policy";

export type NativePermissionConfig = {
  mode: "dontAsk" | "plan";
  allow: string[];
  deny: string[];
};

const directTools = new Map([
  ["bash", "Bash"], ["read", "Read"], ["edit", "Edit"], ["write", "Write"],
  ["grep", "Grep"], ["glob", "Glob"], ["webfetch", "WebFetch"], ["websearch", "WebSearch"],
]);

const semanticDenyRules: Record<string, string[]> = {
  "git.push": ["Bash(git push*)", "Bash(* git push*)"],
  "github.cli": ["Bash(gh *)", "Bash(* gh *)"],
  "shell.environment.dump": ["Bash(env*)", "Bash(printenv*)", "Bash(set*)", "Bash(export*)"],
  "shell.privilege": ["Bash(sudo*)", "Bash(su *)", "Bash(doas*)"],
  ssh: ["Bash(ssh*)", "Bash(scp*)", "Bash(sftp*)", "Bash(rsync *:*)"],
};

const developmentShellRules = [
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)", "Bash(git rev-parse*)",
  "Bash(npm test*)", "Bash(npm run *)", "Bash(npx vitest*)", "Bash(pnpm test*)", "Bash(pnpm run *)", "Bash(yarn test*)", "Bash(yarn run *)",
  "Bash(cargo check*)", "Bash(cargo test*)", "Bash(cargo fmt*)", "Bash(go test*)", "Bash(make*)", "Bash(cmake*)",
  "Bash(node --check*)", "Bash(tsc *)", "Bash(rg *)", "Bash(find *)", "Bash(ls*)", "Bash(pwd)",
];

function unique(values: string[]) { return [...new Set(values)]; }

export function nativeToolRule(value: string) {
  if (/^Bash\(.*\)$/.test(value)) return value === "Bash(*)" ? null : value;
  if (/^(?:Read|Edit|Write|Grep|Glob|MCPTool|WebFetch|WebSearch)(?:\(.*\))?$/.test(value)) return value;
  const direct = directTools.get(value.toLowerCase());
  if (direct) return direct === "Bash" ? null : direct;
  if (value.startsWith("mcp:")) return `MCPTool(${value.slice(4)})`;
  return null;
}

function toolFamily(rule:string) { return rule.match(/^[A-Za-z]+/)?.[0] || rule; }

function ruleCovers(base:string,requested:string) {
  if (base===requested) return true;
  if (base===toolFamily(base)) return toolFamily(base)===toolFamily(requested);
  if (base.endsWith("/**)")) return requested.startsWith(base.slice(0,-3));
  if (base.endsWith("*)")) return requested.startsWith(base.slice(0,-2));
  return false;
}

export function applyJobToolContract(config:NativePermissionConfig, allowedTools:string[], deniedTools:string[], webSearch:"off"|"allow"|"require") {
  const allowed = allowedTools.map((tool) => nativeToolRule(tool));
  const denied = deniedTools.map((tool) => nativeToolRule(tool));
  if (allowed.some((value)=>!value) || denied.some((value)=>!value)) throw new Error("Tool contracts contain an unknown or overbroad native tool rule");
  const validAllowed=allowed as string[]; const validDenied=denied as string[];
  let compiledAllow = [...config.allow];
  const compiledDeny = [...config.deny, ...validDenied];
  if (validAllowed.length) {
    const families = new Set(validAllowed.map(toolFamily));
    const narrowed:string[]=[];
    for (const requested of validAllowed) {
      if (requested===toolFamily(requested)) narrowed.push(...compiledAllow.filter((rule)=>toolFamily(rule)===requested));
      else if (compiledAllow.some((base)=>ruleCovers(base,requested))) narrowed.push(requested);
      else throw new Error(`Tool rule ${requested} is not permitted by the pinned task policy`);
    }
    compiledAllow=unique(narrowed);
    for (const family of ["Bash","Read","Edit","Write","Grep","Glob","MCPTool","WebFetch","WebSearch"]) if (!families.has(family)) compiledDeny.push(family === "Bash" ? "Bash(*)" : family);
  }
  if (webSearch === "off") compiledDeny.push("WebSearch", "WebFetch");
  return { ...config, allow:unique(compiledAllow), deny:unique(compiledDeny) };
}

function pathRules(tool: "Read" | "Edit", roots: string[]) {
  return roots.flatMap((root) => [
    `${tool}(${root === "/" ? "/**" : `${root}/**`})`,
    ...(root.startsWith("/workspace/") ? [`${tool}(${root.slice("/workspace/".length)}/**)`] : []),
  ]);
}

export function nativePermissionConfig(policy: SecurityPolicy, reviewOnly = false): NativePermissionConfig {
  const deny = policy.tools.denied.flatMap((tool) => semanticDenyRules[tool] ?? [nativeToolRule(tool)].filter((value): value is string => Boolean(value)));
  deny.push(...pathRules("Read", policy.filesystem.deniedPaths), ...pathRules("Edit", policy.filesystem.deniedPaths));

  if (reviewOnly) {
    deny.push("Edit", "Write", "NotebookEdit", "Bash(*)");
    return { mode: "plan", allow: ["Read", "Grep", "Glob", "WebSearch"], deny: unique(deny) };
  }

  const allow = [
    ...pathRules("Read", policy.filesystem.readRoots),
    ...pathRules("Edit", policy.filesystem.writeRoots),
    "Grep", "Glob", ...developmentShellRules, "WebSearch",
    ...policy.network.allowedHosts.map((host) => `WebFetch(domain:${host.replace(/^\*\./, "")})`),
    ...policy.tools.allowed.map(nativeToolRule).filter((value): value is string => Boolean(value)),
  ];
  if (policy.network.mode === "allow-all") allow.push("WebFetch");
  else if (!policy.network.allowedHosts.length) deny.push("WebFetch");
  return { mode: "dontAsk", allow: unique(allow), deny: unique(deny) };
}

export function permissionCliArgs(config: NativePermissionConfig) {
  const args = ["--permission-mode", config.mode];
  for (const rule of config.allow) args.push("--allow", rule);
  for (const rule of config.deny) args.push("--deny", rule);
  return args;
}

function pathContains(root:string,path:string) { return root==="/" || path===root || path.startsWith(`${root}/`); }

export function assertStrictSandboxFilesystemPolicy(policy:SecurityPolicy,cwd:string) {
  const roots=[...policy.filesystem.readRoots,...policy.filesystem.writeRoots];
  if (!roots.length || roots.some((root)=>!pathContains(root,cwd))) throw new Error("Strict task sandboxes support only filesystem roots that contain the complete task checkout");
  if (policy.filesystem.deniedPaths.some((path)=>pathContains(cwd,path) || pathContains(path,cwd))) throw new Error("Strict task sandboxes cannot admit a denied path that intersects the task checkout");
}
