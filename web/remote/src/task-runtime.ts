import type { Identity } from "./types";
import { id, now } from "./db";
import { canonicalJson } from "./environments";
import { requireOrganizationRole, requireProjectRole } from "./organizations";

const MAX_ITEM_BYTES = 1_048_576;
const MAX_FILES = 128;
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const INSTALLED_LSP_COMMANDS = new Set(["typescript-language-server", "pyright-langserver"]);

export type ManagedPermissionRule = {
  action: "allow" | "ask" | "deny";
  tool?: "any" | "bash" | "edit" | "read" | "grep" | "mcp" | "webfetch";
  pattern?: string;
  patternMode?: "glob" | "domain";
};

export type ManagedRuntimePolicy = {
  allowedModels?: string[];
  allowedSandboxModes?: Array<"read-only" | "workspace" | "strict" | "off">;
  disableBypassPermissions?: boolean;
  permissionRules?: ManagedPermissionRule[];
  features?: Record<string, boolean>;
  lspServers?: Record<string, ManagedLspServer>;
};

export type ManagedLspServer = {
  command: string;
  args?: string[];
  transport?: "stdio" | "socket";
  env?: Record<string, string>;
  extensionToLanguage: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceFolder?: string;
  startupTimeout?: number;
  shutdownTimeout?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
};

export type MarketplaceFile = {
  path: string;
  content: string;
  sha256: string;
  executable?: boolean;
};

export type MarketplaceManifest = {
  schemaVersion: 1;
  files: MarketplaceFile[];
};

type MarketplaceRow = {
  id: string;
  kind: string;
  name: string;
  version: string;
  source: string;
  digest: string;
  manifest_json: string;
};

type ManagedLayerRow = { scope_type: "organization" | "project" | "member"; policy_json: string; digest: string };

type SandboxResult = { success: boolean; stdout: string; stderr: string };
export type TaskRuntimeSandbox = {
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<SandboxResult>;
};

export type PreparedTaskRuntime = {
  grokHome: string;
  pluginDirectories: string[];
  extensionDigests: Array<{ id: string; digest: string }>;
  policyDigest: string;
  policy: ManagedRuntimePolicy;
  lspServers: string[];
  inspect: Record<string, unknown>;
};

function fail(message: string): never { throw new Error(message); }

function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function marketplaceManifestDigest(manifest: unknown) {
  return base64url(await sha256Bytes(JSON.stringify(manifest)));
}

export async function managedPolicyDigest(policy: ManagedRuntimePolicy) {
  return base64url(await sha256Bytes(canonicalJson(policy)));
}

async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 500 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) fail("Extension file path is invalid");
  const parts = value.split("/");
  if (parts.some((part) => !SAFE_SEGMENT.test(part) || part === "." || part === "..")) fail(`Extension file path is invalid: ${value}`);
  return parts.join("/");
}

function cleanStrings(value: unknown, field: string, allowed?: Set<string>) {
  if (!Array.isArray(value) || value.length > 100) fail(`${field} must be an array with at most 100 entries`);
  const cleaned = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 200 || entry.includes("\0")) fail(`${field} contains an invalid entry`);
    const result = entry.trim();
    if (allowed && !allowed.has(result)) fail(`${field} contains an unsupported entry: ${result}`);
    return result;
  });
  return [...new Set(cleaned)];
}

function validateLspServers(value: unknown): Record<string, ManagedLspServer> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("lspServers must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) fail("lspServers must contain at most 32 servers");
  const output: Record<string, ManagedLspServer> = {};
  for (const [name, raw] of entries) {
    if (!SAFE_SEGMENT.test(name)) fail(`LSP server name is invalid: ${name}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`LSP server ${name} must be an object`);
    const item = raw as Record<string, unknown>;
    const allowed = new Set(["command", "args", "transport", "env", "extensionToLanguage", "initializationOptions", "settings", "workspaceFolder", "startupTimeout", "shutdownTimeout", "restartOnCrash", "maxRestarts"]);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`LSP server ${name} has an unknown field: ${key}`);
    if (typeof item.command !== "string" || !INSTALLED_LSP_COMMANDS.has(item.command.trim())) fail(`LSP server ${name} command is not an installed managed language server`);
    const server: ManagedLspServer = { command:item.command.trim(), extensionToLanguage:{} };
    if (item.args !== undefined) {
      if (!Array.isArray(item.args) || item.args.length > 100) fail(`LSP server ${name} args must be an array with at most 100 entries`);
      server.args = item.args.map((argument) => {
        if (typeof argument !== "string" || argument.length > 1_000 || argument.includes("\0")) fail(`LSP server ${name} args contains an invalid entry`);
        return argument;
      });
    }
    if (item.transport !== undefined) {
      if (item.transport !== "stdio" && item.transport !== "socket") fail(`LSP server ${name} transport is invalid`);
      server.transport = item.transport;
    }
    if (item.env !== undefined) {
      if (!item.env || typeof item.env !== "object" || Array.isArray(item.env)) fail(`LSP server ${name} env must be an object`);
      server.env = {};
      for (const [key, rawValue] of Object.entries(item.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof rawValue !== "string" || rawValue.length > 2_000 || rawValue.includes("\0")) fail(`LSP server ${name} env contains an invalid entry`);
        server.env[key] = rawValue;
      }
    }
    if (!item.extensionToLanguage || typeof item.extensionToLanguage !== "object" || Array.isArray(item.extensionToLanguage)) fail(`LSP server ${name} extensionToLanguage must be an object`);
    const extensions = Object.entries(item.extensionToLanguage as Record<string, unknown>);
    if (!extensions.length || extensions.length > 100) fail(`LSP server ${name} extensionToLanguage must contain 1 to 100 entries`);
    for (const [extension, language] of extensions) {
      if (!/^\.[A-Za-z0-9][A-Za-z0-9+_-]{0,31}$/.test(extension) || typeof language !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(language)) fail(`LSP server ${name} extensionToLanguage contains an invalid entry`);
      server.extensionToLanguage[extension] = language;
    }
    for (const key of ["initializationOptions", "settings"] as const) {
      if (item[key] !== undefined) {
        let encoded: string;
        try { encoded = JSON.stringify(item[key]); } catch { fail(`LSP server ${name} ${key} must be JSON serializable`); }
        if (encoded === undefined || encoded.length > 65_536) fail(`LSP server ${name} ${key} is too large`);
        server[key] = item[key];
      }
    }
    if (item.workspaceFolder !== undefined) {
      if (typeof item.workspaceFolder !== "string" || !item.workspaceFolder || item.workspaceFolder.length > 1_000 || item.workspaceFolder.includes("\0")) fail(`LSP server ${name} workspaceFolder is invalid`);
      server.workspaceFolder = item.workspaceFolder;
    }
    for (const [key, min, max] of [["startupTimeout", 100, 120_000], ["shutdownTimeout", 100, 30_000], ["maxRestarts", 0, 10]] as const) {
      if (item[key] !== undefined) {
        if (!Number.isInteger(item[key]) || (item[key] as number) < min || (item[key] as number) > max) fail(`LSP server ${name} ${key} is invalid`);
        server[key] = item[key] as number;
      }
    }
    if (item.restartOnCrash !== undefined) {
      if (typeof item.restartOnCrash !== "boolean") fail(`LSP server ${name} restartOnCrash must be a boolean`);
      server.restartOnCrash = item.restartOnCrash;
    }
    output[name] = server;
  }
  return output;
}

export function validateManagedRuntimePolicy(value: unknown): ManagedRuntimePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Managed runtime policy must be an object");
  const input = value as Record<string, unknown>;
  const allowedFields = new Set(["allowedModels", "allowedSandboxModes", "disableBypassPermissions", "permissionRules", "features", "lspServers"]);
  for (const key of Object.keys(input)) if (!allowedFields.has(key)) fail(`Unknown managed runtime policy field: ${key}`);
  const output: ManagedRuntimePolicy = {};
  if (input.allowedModels !== undefined) output.allowedModels = cleanStrings(input.allowedModels, "allowedModels");
  if (input.allowedSandboxModes !== undefined) output.allowedSandboxModes = cleanStrings(input.allowedSandboxModes, "allowedSandboxModes", new Set(["read-only", "workspace", "strict", "off"])) as ManagedRuntimePolicy["allowedSandboxModes"];
  if (input.disableBypassPermissions !== undefined) {
    if (typeof input.disableBypassPermissions !== "boolean") fail("disableBypassPermissions must be a boolean");
    output.disableBypassPermissions = input.disableBypassPermissions;
  }
  if (input.permissionRules !== undefined) {
    if (!Array.isArray(input.permissionRules) || input.permissionRules.length > 200) fail("permissionRules must be an array with at most 200 rules");
    output.permissionRules = input.permissionRules.map((rule, index) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) fail(`permissionRules[${index}] is invalid`);
      const item = rule as Record<string, unknown>;
      for (const key of Object.keys(item)) if (!new Set(["action", "tool", "pattern", "patternMode"]).has(key)) fail(`permissionRules[${index}] has an unknown field: ${key}`);
      if (!new Set(["allow", "ask", "deny"]).has(String(item.action))) fail(`permissionRules[${index}].action is invalid`);
      if (item.tool !== undefined && !new Set(["any", "bash", "edit", "read", "grep", "mcp", "webfetch"]).has(String(item.tool))) fail(`permissionRules[${index}].tool is invalid`);
      if (item.pattern !== undefined && (typeof item.pattern !== "string" || item.pattern.length > 1_000 || item.pattern.includes("\0"))) fail(`permissionRules[${index}].pattern is invalid`);
      if (item.patternMode !== undefined && !new Set(["glob", "domain"]).has(String(item.patternMode))) fail(`permissionRules[${index}].patternMode is invalid`);
      return { action:item.action, ...(item.tool ? {tool:item.tool} : {}), ...(item.pattern !== undefined ? {pattern:item.pattern} : {}), ...(item.patternMode ? {patternMode:item.patternMode} : {}) } as ManagedPermissionRule;
    });
  }
  if (input.features !== undefined) {
    if (!input.features || typeof input.features !== "object" || Array.isArray(input.features)) fail("features must be an object");
    output.features = {};
    for (const [key, enabled] of Object.entries(input.features as Record<string, unknown>)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key) || typeof enabled !== "boolean") fail(`Feature ${key} is invalid`);
      output.features[key] = enabled;
    }
  }
  if (input.lspServers !== undefined) output.lspServers = validateLspServers(input.lspServers);
  return output;
}

function intersection(left: string[] | undefined, right: string[] | undefined) {
  if (!left) return right;
  if (!right) return left;
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

export function compileManagedRuntimePolicy(layers: unknown[]): ManagedRuntimePolicy {
  let effective: ManagedRuntimePolicy = {};
  for (const raw of layers) {
    const layer = validateManagedRuntimePolicy(raw);
    effective = {
      allowedModels: intersection(effective.allowedModels, layer.allowedModels),
      allowedSandboxModes: intersection(effective.allowedSandboxModes, layer.allowedSandboxModes) as ManagedRuntimePolicy["allowedSandboxModes"],
      disableBypassPermissions: Boolean(effective.disableBypassPermissions || layer.disableBypassPermissions),
      permissionRules: [...(effective.permissionRules || []), ...(layer.permissionRules || [])],
      features: { ...(effective.features || {}), ...(layer.features || {}) },
      lspServers: { ...(effective.lspServers || {}), ...(layer.lspServers || {}) },
    };
  }
  return validateManagedRuntimePolicy(effective);
}

function tomlString(value: string) { return JSON.stringify(value); }
function tomlArray(values: string[]) { return `[${values.map(tomlString).join(", ")}]`; }

export function renderManagedConfig(policy: ManagedRuntimePolicy, pluginDirectories: string[]) {
  const lines = ["# Generated by Grok Build. Do not edit."];
  if (policy.allowedModels) lines.push("", "[models]", `allowed_models = ${tomlArray(policy.allowedModels)}`);
  const features = { ...(policy.features || {}) };
  if (policy.lspServers && Object.keys(policy.lspServers).length && features.lsp_tools === undefined) features.lsp_tools = true;
  if (Object.keys(features).length) {
    lines.push("", "[features]");
    for (const [name, enabled] of Object.entries(features).sort(([a], [b]) => a.localeCompare(b))) lines.push(`${name} = ${enabled}`);
  }
  if (pluginDirectories.length) lines.push("", "[plugins]", `paths = ${tomlArray(pluginDirectories)}`);
  for (const rule of policy.permissionRules || []) {
    lines.push("", "[[permission.rules]]", `action = ${tomlString(rule.action)}`);
    if (rule.tool) lines.push(`tool = ${tomlString(rule.tool)}`);
    if (rule.pattern !== undefined) lines.push(`pattern = ${tomlString(rule.pattern)}`);
    if (rule.patternMode) lines.push(`pattern_mode = ${tomlString(rule.patternMode)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRequirements(policy: ManagedRuntimePolicy) {
  const lines = ["# Generated by Grok Build. Do not edit.", "fail_closed = true"];
  if (policy.allowedSandboxModes && !policy.allowedSandboxModes.includes("strict")) fail("Managed runtime policy does not permit the required strict sandbox");
  if (policy.allowedSandboxModes) lines.push(`allowed_sandbox_modes = ${tomlArray(policy.allowedSandboxModes)}`);
  if (policy.disableBypassPermissions) lines.push("", "[ui]", "disable_bypass_permissions_mode = true");
  return `${lines.join("\n")}\n`;
}

export async function validateMarketplaceManifest(row: MarketplaceRow): Promise<MarketplaceManifest> {
  let raw: unknown;
  try { raw = JSON.parse(row.manifest_json); } catch { fail(`Marketplace item ${row.id} has malformed manifest JSON`); }
  if (await marketplaceManifestDigest(raw) !== row.digest) fail(`Marketplace item ${row.id} manifest digest does not match its approval`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`Marketplace item ${row.id} manifest is invalid`);
  const manifest = raw as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) fail(`Marketplace item ${row.id} must use an embedded schemaVersion 1 manifest`);
  let bytes = 0;
  const paths = new Set<string>();
  const files: MarketplaceFile[] = [];
  for (const [index, rawFile] of manifest.files.entries()) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) fail(`Marketplace item ${row.id} file ${index} is invalid`);
    const file = rawFile as Record<string, unknown>;
    for (const key of Object.keys(file)) if (!new Set(["path", "content", "sha256", "executable"]).has(key)) fail(`Marketplace item ${row.id} file ${index} has an unknown field: ${key}`);
    const path = safePath(file.path);
    if (paths.has(path)) fail(`Marketplace item ${row.id} contains duplicate path ${path}`);
    if (typeof file.content !== "string") fail(`Marketplace item ${row.id} file ${path} has invalid content`);
    if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256) || await sha256Hex(file.content) !== file.sha256.toLowerCase()) fail(`Marketplace item ${row.id} file ${path} digest does not match`);
    if (file.executable !== undefined && typeof file.executable !== "boolean") fail(`Marketplace item ${row.id} file ${path} executable flag is invalid`);
    bytes += new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_ITEM_BYTES) fail(`Marketplace item ${row.id} exceeds ${MAX_ITEM_BYTES} bytes`);
    paths.add(path);
    files.push({ path, content:file.content, sha256:file.sha256.toLowerCase(), executable:Boolean(file.executable) });
  }
  const kindPrefix: Record<string, RegExp> = {
    skill:/^skills\/[a-zA-Z0-9._-]+\/SKILL\.md$/,
    hook:/^hooks\/hooks\.json$/,
    mcp:/^\.mcp\.json$/,
    command:/^commands\/.+\.md$/,
    subagent:/^agents\/.+\.md$/,
    rule:/^skills\/[a-zA-Z0-9._-]+\/SKILL\.md$/,
  };
  if (kindPrefix[row.kind] && !files.some((file) => kindPrefix[row.kind].test(file.path))) fail(`Marketplace ${row.kind} item ${row.id} does not contain its required native Grok component`);
  return { schemaVersion:1, files };
}

function sh(value: string) { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }
function runtimeName(row: MarketplaceRow) { return `${row.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || row.id}-${row.id.slice(-8)}`; }

function pluginName(row: MarketplaceRow, manifest: MarketplaceManifest) {
  const pluginFile = manifest.files.find((file) => file.path === "plugin.json");
  if (!pluginFile) return runtimeName(row);
  try {
    const name = (JSON.parse(pluginFile.content) as {name?:unknown}).name;
    if (typeof name !== "string" || !SAFE_SEGMENT.test(name)) fail(`Marketplace item ${row.id} plugin.json has an invalid name`);
    return name;
  } catch (error) {
    if (error instanceof Error && error.message.includes("plugin.json has an invalid name")) throw error;
    return fail(`Marketplace item ${row.id} plugin.json is malformed`);
  }
}

function modelMatches(pattern: string, model: string) {
  const escaped = [...pattern].map((character) => character === "*" ? ".*" : character === "?" ? "." : /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character).join("");
  return new RegExp(`^${escaped}$`).test(model);
}

export function validateInspectReport(raw: unknown, expected: Array<{ name: string; directory: string }>, expectedLsp: string[] = []) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("grok inspect returned an invalid JSON report");
  const report = raw as Record<string, unknown>;
  if (!Array.isArray(report.plugins) || !report.configSources || typeof report.configSources !== "object") fail("grok inspect JSON is missing plugins or configSources");
  const plugins = report.plugins as Array<Record<string, unknown>>;
  for (const item of expected) {
    const plugin = plugins.find((entry) => entry.name === item.name || entry.path === item.directory);
    if (!plugin || plugin.enabled !== true) fail(`grok inspect did not load approved extension ${item.name}`);
  }
  const lspServers = report.lspServers;
  if (expectedLsp.length && !Array.isArray(lspServers)) fail("grok inspect JSON is missing lspServers");
  for (const name of expectedLsp) {
    const server = (lspServers as Array<Record<string, unknown>>).find((entry) => entry.name === name);
    if (!server || server.untrusted === true) fail(`grok inspect did not load managed LSP server ${name}`);
  }
  const layers = (report.configSources as {layers?: unknown}).layers;
  if (!Array.isArray(layers)) fail("grok inspect did not report effective configuration layers");
  return report;
}

export async function saveManagedRuntimePolicy(db: D1Database, identity: Identity, input: { scopeType:"organization"|"project"|"member"; scopeId:string; policy:unknown }) {
  if (input.scopeType === "organization") await requireOrganizationRole(db, identity, input.scopeId, "admin");
  else if (input.scopeType === "project") await requireProjectRole(db, identity, input.scopeId, "maintainer");
  else if (input.scopeId !== identity.sub) throw new Error("Only the current member can manage a member policy");
  const policy = validateManagedRuntimePolicy(input.policy);
  const digest = await managedPolicyDigest(policy);
  const current = await db.prepare("SELECT COALESCE(MAX(revision), 0) revision FROM managed_runtime_config_revisions WHERE scope_type=? AND scope_id=?").bind(input.scopeType, input.scopeId).first<{revision:number}>();
  const revision = Number(current?.revision || 0) + 1;
  const revisionId = id("mrc");
  await db.batch([
    db.prepare("UPDATE managed_runtime_config_revisions SET active=0 WHERE scope_type=? AND scope_id=? AND active=1").bind(input.scopeType, input.scopeId),
    db.prepare("INSERT INTO managed_runtime_config_revisions (id, scope_type, scope_id, revision, policy_json, digest, created_by_sub, created_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)").bind(revisionId, input.scopeType, input.scopeId, revision, canonicalJson(policy), digest, identity.sub, now()),
  ]);
  return { id:revisionId, revision, digest, policy };
}

export async function getManagedRuntimePolicy(db:D1Database, identity:Identity, input:{scopeType:"organization"|"project"|"member";scopeId:string}) {
  if (input.scopeType === "organization") await requireOrganizationRole(db, identity, input.scopeId, "viewer");
  else if (input.scopeType === "project") await requireProjectRole(db, identity, input.scopeId, "viewer");
  else if (input.scopeId !== identity.sub) throw new Error("Only the current member policy is visible");
  const row=await db.prepare("SELECT id,revision,policy_json,digest,created_by_sub,created_at FROM managed_runtime_config_revisions WHERE scope_type=? AND scope_id=? AND active=1").bind(input.scopeType,input.scopeId).first<{id:string;revision:number;policy_json:string;digest:string;created_by_sub:string;created_at:string}>();
  return row ? {id:row.id,revision:row.revision,policy:validateManagedRuntimePolicy(JSON.parse(row.policy_json)),digest:row.digest,createdBySub:row.created_by_sub,createdAt:row.created_at} : null;
}

async function loadManagedLayers(db: D1Database, projectId: string, ownerSub: string) {
  const result = await db.prepare(`SELECT r.scope_type, r.policy_json, r.digest FROM managed_runtime_config_revisions r
    JOIN projects p ON p.id=?
    WHERE r.active=1 AND ((r.scope_type='organization' AND r.scope_id=p.organization_id)
      OR (r.scope_type='project' AND r.scope_id=p.id)
      OR (r.scope_type='member' AND r.scope_id=?))
    ORDER BY CASE r.scope_type WHEN 'organization' THEN 1 WHEN 'project' THEN 2 ELSE 3 END`).bind(projectId, ownerSub).all<ManagedLayerRow>();
  return result.results;
}

async function loadMarketplaceRows(db: D1Database, projectId: string, ownerSub: string) {
  const result = await db.prepare(`SELECT DISTINCT i.id, i.kind, i.name, i.version, i.source, i.digest, i.manifest_json
    FROM marketplace_items i JOIN marketplace_grants g ON g.item_id=i.id JOIN projects p ON p.id=?
    WHERE i.trust_status='approved' AND (
      (g.subject_type='project' AND g.subject_id=p.id) OR
      (g.subject_type='organization' AND g.subject_id=p.organization_id) OR
      (g.subject_type='member' AND g.subject_id=?))
    ORDER BY i.kind, i.name, i.version, i.id`).bind(projectId, ownerSub).all<MarketplaceRow>();
  return result.results;
}

type TaskRuntimePinRow={policy_layers_json:string;marketplace_items_json:string;digest:string};

export async function pinTaskRuntime(db:D1Database,input:{taskId:string;projectId:string;ownerSub:string}) {
  const [layers,rows]=await Promise.all([loadManagedLayers(db,input.projectId,input.ownerSub),loadMarketplaceRows(db,input.projectId,input.ownerSub)]);
  for (const layer of layers) if (await managedPolicyDigest(validateManagedRuntimePolicy(JSON.parse(layer.policy_json))) !== layer.digest) fail(`Managed ${layer.scope_type} policy digest does not match its approved revision`);
  for (const row of rows) await validateMarketplaceManifest(row);
  const policyLayersJson=canonicalJson(layers);
  const marketplaceItemsJson=canonicalJson(rows);
  const digest=base64url(await sha256Bytes(canonicalJson({layers,rows})));
  await db.prepare("INSERT INTO task_runtime_pins (task_id,policy_layers_json,marketplace_items_json,digest,pinned_at) VALUES (?,?,?,?,?)").bind(input.taskId,policyLayersJson,marketplaceItemsJson,digest,now()).run();
  return {digest,layers,rows};
}

async function loadTaskRuntimePin(db:D1Database,taskId:string) {
  const row=await db.prepare("SELECT policy_layers_json,marketplace_items_json,digest FROM task_runtime_pins WHERE task_id=?").bind(taskId).first<TaskRuntimePinRow>();
  if (!row) fail("Task has no pinned managed runtime");
  let layers:ManagedLayerRow[]; let rows:MarketplaceRow[];
  try { layers=JSON.parse(row.policy_layers_json) as ManagedLayerRow[]; rows=JSON.parse(row.marketplace_items_json) as MarketplaceRow[]; }
  catch { return fail("Task managed runtime pin is malformed"); }
  const digest=base64url(await sha256Bytes(canonicalJson({layers,rows})));
  if (digest !== row.digest) fail("Task managed runtime pin digest does not match its admitted snapshot");
  return {layers,rows,digest};
}

export async function prepareTaskRuntime(input: { db:D1Database; sandbox:TaskRuntimeSandbox; taskId:string; projectId:string; ownerSub:string; cwd:string; baseGrokHome:string; model:string }) : Promise<PreparedTaskRuntime> {
  const { db, sandbox } = input;
  const taskGrokHome = `${input.baseGrokHome}/tasks/${input.taskId}`;
  const {layers,rows}=await loadTaskRuntimePin(db,input.taskId);
  for (const layer of layers) if (await managedPolicyDigest(validateManagedRuntimePolicy(JSON.parse(layer.policy_json))) !== layer.digest) fail(`Managed ${layer.scope_type} policy digest does not match its approved revision`);
  const policy = compileManagedRuntimePolicy(layers.map((layer) => JSON.parse(layer.policy_json)));
  if (policy.allowedModels?.length && !policy.allowedModels.some((pattern) => modelMatches(pattern, input.model))) fail(`Task model ${input.model} is not permitted by managed policy`);
  const pluginDirectories: string[] = [];
  const expected: Array<{name:string;directory:string}> = [];
  await sandbox.exec(`mkdir -p ${sh(taskGrokHome)} && rm -rf ${sh(`${taskGrokHome}/plugins`)} && rm -f ${sh(`${taskGrokHome}/managed_config.toml`)} ${sh(`${taskGrokHome}/requirements.toml`)} ${sh(`${taskGrokHome}/lsp.json`)} && mkdir -p ${sh(`${taskGrokHome}/plugins`)} && if test -s ${sh(`${input.baseGrokHome}/auth.json`)}; then cp ${sh(`${input.baseGrokHome}/auth.json`)} ${sh(`${taskGrokHome}/auth.json`)}; chmod 600 ${sh(`${taskGrokHome}/auth.json`)}; fi`);
  for (const row of rows) {
    const manifest = await validateMarketplaceManifest(row);
    const directory = `${taskGrokHome}/plugins/${runtimeName(row)}`;
    const name = pluginName(row, manifest);
    await sandbox.exec(`mkdir -p ${sh(directory)}`);
    for (const file of manifest.files) {
      const path = `${directory}/${file.path}`;
      await sandbox.exec(`mkdir -p ${sh(path.slice(0, path.lastIndexOf("/")))}`);
      await sandbox.writeFile(path, file.content);
      await sandbox.exec(`chmod ${file.executable ? "700" : "600"} ${sh(path)}`);
    }
    if (!manifest.files.some((file) => file.path === "plugin.json")) {
      await sandbox.writeFile(`${directory}/plugin.json`, JSON.stringify({ name, version:row.version, description:`Managed ${row.kind} from ${row.source}` }, null, 2));
      await sandbox.exec(`chmod 600 ${sh(`${directory}/plugin.json`)}`);
    }
    pluginDirectories.push(directory);
    expected.push({ name, directory });
  }
  const managedConfig = renderManagedConfig(policy, pluginDirectories);
  const requirements = renderRequirements(policy);
  const lspServers = Object.keys(policy.lspServers || {}).sort();
  await sandbox.writeFile(`${taskGrokHome}/managed_config.toml`, managedConfig);
  await sandbox.writeFile(`${taskGrokHome}/requirements.toml`, requirements);
  if (lspServers.length) await sandbox.writeFile(`${taskGrokHome}/lsp.json`, canonicalJson(policy.lspServers));
  await sandbox.exec(`chmod 700 ${sh(taskGrokHome)} && chmod 400 ${sh(`${taskGrokHome}/managed_config.toml`)} ${sh(`${taskGrokHome}/requirements.toml`)}${lspServers.length ? ` ${sh(`${taskGrokHome}/lsp.json`)}` : ""}`);
  const inspected = await sandbox.exec("grok inspect --json", { cwd:input.cwd, env:{ GROK_HOME:taskGrokHome, NO_COLOR:"1", GROK_MANAGED_CONFIG_FAIL_CLOSED:"true" }, timeout:60_000 });
  if (!inspected.success) fail(`grok inspect rejected the task runtime: ${(inspected.stderr || inspected.stdout).slice(-1_200)}`);
  let inspectJson: unknown;
  try { inspectJson = JSON.parse(inspected.stdout); } catch { fail("grok inspect returned malformed JSON"); }
  const inspect = validateInspectReport(inspectJson, expected, lspServers);
  for (const name of lspServers) {
    const server=policy.lspServers![name];
    const args=(server.args || []).map(sh).join(" ");
    const health=await sandbox.exec(`command -v ${sh(server.command)} >/dev/null && timeout 3s sh -c 'tail -f /dev/null | "$@"' _ ${sh(server.command)}${args ? ` ${args}` : ""}; status=$?; test "$status" -eq 124`,{cwd:input.cwd,env:{...server.env,GROK_HOME:taskGrokHome,NO_COLOR:"1"},timeout:10_000});
    if (!health.success) fail(`Managed LSP server ${name} is installed but failed its startup health check: ${(health.stderr || health.stdout).slice(-800)}`);
  }
  return { grokHome:taskGrokHome, pluginDirectories, extensionDigests:rows.map((row) => ({id:row.id,digest:row.digest})), policyDigest:await managedPolicyDigest(policy), policy, lspServers, inspect };
}
