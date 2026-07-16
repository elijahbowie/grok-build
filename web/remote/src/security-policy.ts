const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SECURITY_POLICY_VERSION = 1 as const;
export const DEFAULT_PLATFORM_HOSTS = [
  "api.cloudflare.com",
  "api.x.ai",
] as const;

export type NetworkMode = "restricted" | "allowlist-only" | "allow-all";
export type FilesystemOperation = "read" | "write";
export type SecurityDecision = {
  allowed: boolean;
  reason: string;
  matchedRule?: string;
};

export type BrokeredCredentialRule = {
  secretId: string;
  host: string;
  pathPrefix: string;
  methods: string[];
  headerName: string;
};

export type SecurityPolicy = {
  version: typeof SECURITY_POLICY_VERSION;
  network: {
    mode: NetworkMode;
    allowedHosts: string[];
  };
  filesystem: {
    readRoots: string[];
    writeRoots: string[];
    deniedPaths: string[];
  };
  tools: {
    allowed: string[];
    denied: string[];
  };
  brokeredCredentials: BrokeredCredentialRule[];
};

export type CompiledSecurityPolicy = SecurityPolicy & {
  platformHosts: string[];
};

export type SecurityPolicyRevision = {
  id: string;
  projectId: string;
  revision: number;
  policy: SecurityPolicy;
  policyDigest: string;
  createdBySub: string;
  createdAt: string;
  active: boolean;
};

export type McpToolGrant = {
  id: string;
  taskId: string;
  connectorId: string;
  policyRevisionId: string;
  toolName: string;
  expiresAt: string;
  revokedAt: string | null;
  createdBySub: string;
  createdAt: string;
};

export type BrokeredSecretEnvelope = {
  v: 1;
  alg: "A256GCM";
  keyVersion: number;
  iv: string;
  ciphertext: string;
  aad: string;
};

export type SecurityAuditEvent = {
  ownerSub: string;
  projectId?: string | null;
  taskId?: string | null;
  policyRevisionId?: string | null;
  category: "network" | "filesystem" | "tool" | "secret" | "mcp" | "policy";
  action: string;
  decision: "allowed" | "denied" | "observed" | "error";
  target: string;
  detail?: unknown;
  createdAt?: string;
};

export type SecurityAuditSummary = {
  total: number;
  byDecision: Record<SecurityAuditEvent["decision"], number>;
  byCategory: Record<SecurityAuditEvent["category"], number>;
  deniedTargets: Array<{ target: string; count: number }>;
};

const DEFAULT_DENIED_PATHS = [
  "/root/.grok",
  "/root/.ssh",
  "/proc",
  "/sys",
  "/var/run/secrets",
] as const;

const DEFAULT_DENIED_TOOLS = [
  "git.push",
  "github.cli",
  "shell.environment.dump",
  "shell.privilege",
  "ssh",
] as const;

export function defaultSecurityPolicy(): SecurityPolicy {
  return {
    version: SECURITY_POLICY_VERSION,
    network: { mode: "restricted", allowedHosts: [] },
    filesystem: {
      readRoots: ["/workspace"],
      writeRoots: ["/workspace"],
      deniedPaths: [...DEFAULT_DENIED_PATHS],
    },
    tools: { allowed: [], denied: [...DEFAULT_DENIED_TOOLS] },
    brokeredCredentials: [],
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string, maximum = 128): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`);
  if (value.length > maximum) throw new Error(`${label} has too many entries`);
  return value as string[];
}

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

function normalizeHost(value: string) {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  const candidate = host.startsWith("*.") ? host.slice(2) : host;
  if (!candidate || candidate.length > 253 || candidate.includes(":") || candidate.includes("/") || candidate.includes("@") || candidate.includes("..")) throw new Error(`Invalid hostname: ${value}`);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(candidate)) throw new Error(`Invalid hostname: ${value}`);
  if (isBlockedHostname(candidate)) throw new Error(`Private, local, and raw-IP hosts are not allowed: ${value}`);
  return host.startsWith("*.") ? `*.${candidate}` : candidate;
}

function normalizePath(value: string, label: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) throw new Error(`${label} must be an absolute normalized path`);
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function normalizeTool(value: string) {
  const tool = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(tool) || tool.includes("*")) throw new Error(`Invalid exact tool name: ${value}`);
  return tool;
}

function normalizeMethod(value: string) {
  const method = value.trim().toUpperCase();
  if (!/^[A-Z]{3,12}$/.test(method)) throw new Error(`Invalid HTTP method: ${value}`);
  return method;
}

function normalizeHeader(value: string) {
  const header = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(header) || ["host", "cookie", "set-cookie"].includes(header)) throw new Error(`Invalid brokered credential header: ${value}`);
  return header;
}

export function normalizeSecurityPolicy(input: unknown): SecurityPolicy {
  const root = object(input, "Security policy");
  if (root.version !== SECURITY_POLICY_VERSION) throw new Error(`Unsupported security policy version: ${String(root.version)}`);
  const network = object(root.network, "network");
  if (!(["restricted", "allowlist-only", "allow-all"] as unknown[]).includes(network.mode)) throw new Error("Invalid network mode");
  const filesystem = object(root.filesystem, "filesystem");
  const tools = object(root.tools, "tools");
  const brokered = Array.isArray(root.brokeredCredentials) ? root.brokeredCredentials : (() => { throw new Error("brokeredCredentials must be an array"); })();
  if (brokered.length > 64) throw new Error("brokeredCredentials has too many entries");

  const readRoots = unique(strings(filesystem.readRoots, "filesystem.readRoots").map((value) => normalizePath(value, "Read root")));
  const writeRoots = unique(strings(filesystem.writeRoots, "filesystem.writeRoots").map((value) => normalizePath(value, "Write root")));
  const deniedPaths = unique([...DEFAULT_DENIED_PATHS, ...strings(filesystem.deniedPaths, "filesystem.deniedPaths")].map((value) => normalizePath(value, "Denied path")));
  const allowedTools = unique(strings(tools.allowed, "tools.allowed").map(normalizeTool));
  const deniedTools = unique([...DEFAULT_DENIED_TOOLS, ...strings(tools.denied, "tools.denied")].map(normalizeTool));
  const conflict = allowedTools.find((tool) => deniedTools.includes(tool));
  if (conflict) throw new Error(`Tool cannot be both allowed and denied: ${conflict}`);

  return {
    version: SECURITY_POLICY_VERSION,
    network: {
      mode: network.mode as NetworkMode,
      allowedHosts: unique(strings(network.allowedHosts, "network.allowedHosts").map(normalizeHost)),
    },
    filesystem: { readRoots, writeRoots, deniedPaths },
    tools: { allowed: allowedTools, denied: deniedTools },
    brokeredCredentials: brokered.map((raw, index) => {
      const rule = object(raw, `brokeredCredentials[${index}]`);
      const secretId = typeof rule.secretId === "string" ? rule.secretId.trim() : "";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(secretId)) throw new Error(`Invalid brokered credential secretId at index ${index}`);
      const pathPrefix = normalizePath(typeof rule.pathPrefix === "string" ? rule.pathPrefix : "/", "Credential path prefix");
      const methods = unique(strings(rule.methods, `brokeredCredentials[${index}].methods`, 16).map(normalizeMethod));
      if (!methods.length) throw new Error("Brokered credential methods cannot be empty");
      const host = normalizeHost(String(rule.host ?? ""));
      if (host.startsWith("*.")) throw new Error("Brokered credential hosts must be exact");
      return {
        secretId,
        host,
        pathPrefix,
        methods,
        headerName: normalizeHeader(String(rule.headerName ?? "authorization")),
      };
    }).sort((left, right) => left.secretId.localeCompare(right.secretId)),
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function securityPolicyDigest(policy: SecurityPolicy) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(stable(policy))));
}

export function compileSecurityPolicy(input: unknown, platformHosts: readonly string[] = DEFAULT_PLATFORM_HOSTS): CompiledSecurityPolicy {
  const policy = normalizeSecurityPolicy(input);
  return { ...policy, platformHosts: unique(platformHosts.map(normalizeHost)) };
}

function matchesHost(hostname: string, rule: string) {
  return rule.startsWith("*.") ? hostname.endsWith(rule.slice(1)) && hostname !== rule.slice(2) : hostname === rule;
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function isBlockedHostname(value: string) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.includes(":") || isPrivateIpv4(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname);
}

export function decideOutboundRequest(policy: CompiledSecurityPolicy, input: { url: string; resolvedIp?: string }): SecurityDecision {
  let url: URL;
  try { url = new URL(input.url); } catch { return { allowed: false, reason: "invalid-url" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { allowed: false, reason: "unsupported-or-credentialed-url" };
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(hostname) || (input.resolvedIp && isBlockedHostname(input.resolvedIp))) return { allowed: false, reason: "private-local-or-raw-ip" };
  const baseline = policy.platformHosts.find((rule) => matchesHost(hostname, rule));
  if (baseline) return { allowed: true, reason: "platform-baseline", matchedRule: baseline };
  const configured = policy.network.allowedHosts.find((rule) => matchesHost(hostname, rule));
  if (configured) return { allowed: true, reason: "project-allowlist", matchedRule: configured };
  if (policy.network.mode === "allow-all") return { allowed: true, reason: "allow-all-public-http" };
  return { allowed: false, reason: "host-not-allowed" };
}

function pathWithin(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

export function decideFilesystemAccess(policy: CompiledSecurityPolicy, operation: FilesystemOperation, rawPath: string): SecurityDecision {
  let path: string;
  try { path = normalizePath(rawPath, "Filesystem path"); } catch { return { allowed: false, reason: "invalid-path" }; }
  const denied = policy.filesystem.deniedPaths.find((root) => pathWithin(path, root));
  if (denied) return { allowed: false, reason: "denied-path", matchedRule: denied };
  const roots = operation === "read" ? policy.filesystem.readRoots : policy.filesystem.writeRoots;
  const allowed = roots.find((root) => pathWithin(path, root));
  return allowed ? { allowed: true, reason: `${operation}-root`, matchedRule: allowed } : { allowed: false, reason: `outside-${operation}-roots` };
}

export function decideToolUse(policy: CompiledSecurityPolicy, toolName: string): SecurityDecision {
  let tool: string;
  try { tool = normalizeTool(toolName); } catch { return { allowed: false, reason: "invalid-tool-name" }; }
  if (policy.tools.denied.includes(tool)) return { allowed: false, reason: "tool-denied", matchedRule: tool };
  if (policy.tools.allowed.length && !policy.tools.allowed.includes(tool)) return { allowed: false, reason: "tool-not-granted" };
  return { allowed: true, reason: policy.tools.allowed.length ? "tool-granted" : "not-denied", matchedRule: tool };
}

export function credentialRuleForRequest(policy: CompiledSecurityPolicy, secretId: string, request: { url: string; method: string }): BrokeredCredentialRule | null {
  let url: URL;
  try { url = new URL(request.url); } catch { return null; }
  if (url.protocol !== "https:" || isBlockedHostname(url.hostname)) return null;
  const method = request.method.toUpperCase();
  return policy.brokeredCredentials.find((rule) => rule.secretId === secretId && matchesHost(url.hostname.toLowerCase(), rule.host) && (url.pathname === rule.pathPrefix || url.pathname.startsWith(`${rule.pathPrefix}/`) || rule.pathPrefix === "/") && rule.methods.includes(method)) ?? null;
}

function b64url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function aesKey(encodedKey: string, usage: Array<"encrypt" | "decrypt">) {
  const bytes = fromB64url(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("Brokered secret key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage);
}

export async function encryptBrokeredSecret(value: string | Uint8Array, encodedKey: string, context: { secretId: string; projectId: string; keyVersion: number }): Promise<BrokeredSecretEnvelope> {
  if (!context.secretId || !context.projectId || !Number.isInteger(context.keyVersion) || context.keyVersion < 1) throw new Error("Invalid brokered secret encryption context");
  const plaintext = typeof value === "string" ? encoder.encode(value) : value.slice();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(stable(context));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await aesKey(encodedKey, ["encrypt"]), plaintext);
    return { v: 1, alg: "A256GCM", keyVersion: context.keyVersion, iv: b64url(iv), ciphertext: b64url(new Uint8Array(ciphertext)), aad: b64url(aad) };
  } finally {
    plaintext.fill(0);
  }
}

export async function withDecryptedBrokeredSecret<T>(envelope: BrokeredSecretEnvelope, encodedKey: string, context: { secretId: string; projectId: string; keyVersion: number }, use: (plaintext: Uint8Array) => T | Promise<T>): Promise<T> {
  if (envelope.v !== 1 || envelope.alg !== "A256GCM" || envelope.keyVersion !== context.keyVersion || envelope.aad !== b64url(encoder.encode(stable(context)))) throw new Error("Brokered secret envelope context mismatch");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(envelope.iv), additionalData: fromB64url(envelope.aad) }, await aesKey(encodedKey, ["decrypt"]), fromB64url(envelope.ciphertext)));
  try {
    return await use(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

export async function injectBrokeredCredential(policy: CompiledSecurityPolicy, request: Request, secretId: string, envelope: BrokeredSecretEnvelope, encodedKey: string, context: { projectId: string; keyVersion: number }): Promise<Request> {
  const rule = credentialRuleForRequest(policy, secretId, { url: request.url, method: request.method });
  if (!rule) throw new Error("Brokered credential is not authorized for this request");
  return withDecryptedBrokeredSecret(envelope, encodedKey, { ...context, secretId }, (plaintext) => {
    const headers = new Headers(request.headers);
    headers.set(rule.headerName, decoder.decode(plaintext));
    return new Request(request, { headers, redirect: "manual" });
  });
}

const SECRET_PATTERNS = [
  /\b(?:sk|xai|ghp|github_pat|cfpat)[_-][a-zA-Z0-9_-]{16,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}=*/gi,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
] as const;

export function redactSecurityText(value: string, sensitiveValues: readonly string[] = []) {
  let redacted = value;
  for (const secret of sensitiveValues.filter((item) => item.length >= 6).sort((left, right) => right.length - left.length)) redacted = redacted.split(secret).join("[REDACTED]");
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

export function redactSecurityValue(value: unknown, sensitiveValues: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return redactSecurityText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => redactSecurityValue(item, sensitiveValues, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /authorization|cookie|secret|token|password|private.?key/i.test(key) ? "[REDACTED]" : redactSecurityValue(item, sensitiveValues, depth + 1)]));
  }
  return value;
}

function mapRevision(row: Record<string, unknown>): SecurityPolicyRevision {
  return {
    id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision),
    policy: normalizeSecurityPolicy(JSON.parse(String(row.policy_json))), policyDigest: String(row.policy_digest),
    createdBySub: String(row.created_by_sub), createdAt: String(row.created_at), active: Boolean(row.active),
  };
}

export async function createSecurityPolicyRevision(db: D1Database, input: { projectId: string; ownerSub: string; createdBySub: string; policy: unknown; activate?: boolean }) {
  const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND owner_sub = ?").bind(input.projectId, input.ownerSub).first<{ id: string }>();
  if (!project) throw new Error("Project not found");
  const policy = normalizeSecurityPolicy(input.policy);
  const digest = await securityPolicyDigest(policy);
  const existing = await db.prepare("SELECT r.*, CASE WHEN h.revision_id = r.id THEN 1 ELSE 0 END AS active FROM security_policy_revisions r LEFT JOIN project_security_policy_heads h ON h.project_id = r.project_id WHERE r.project_id = ? AND r.policy_digest = ?").bind(input.projectId, digest).first<Record<string, unknown>>();
  if (existing) return mapRevision(existing);
  const current = await db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM security_policy_revisions WHERE project_id = ?").bind(input.projectId).first<{ revision: number }>();
  const revision = Number(current?.revision ?? 0) + 1;
  const revisionId = `sec_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = new Date().toISOString();
  await db.prepare("INSERT INTO security_policy_revisions (id, project_id, revision, policy_json, policy_digest, created_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(revisionId, input.projectId, revision, stable(policy), digest, input.createdBySub, createdAt).run();
  if (input.activate !== false) await activateSecurityPolicyRevision(db, { projectId: input.projectId, ownerSub: input.ownerSub, revisionId, activatedBySub: input.createdBySub });
  return { id: revisionId, projectId: input.projectId, revision, policy, policyDigest: digest, createdBySub: input.createdBySub, createdAt, active: input.activate !== false } satisfies SecurityPolicyRevision;
}

export async function activateSecurityPolicyRevision(db: D1Database, input: { projectId: string; ownerSub: string; revisionId: string; activatedBySub: string }) {
  const revision = await db.prepare("SELECT r.id FROM security_policy_revisions r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND r.project_id = ? AND p.owner_sub = ?").bind(input.revisionId, input.projectId, input.ownerSub).first<{ id: string }>();
  if (!revision) throw new Error("Security policy revision not found");
  const timestamp = new Date().toISOString();
  await db.prepare("INSERT INTO project_security_policy_heads (project_id, revision_id, activated_by_sub, activated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET revision_id = excluded.revision_id, activated_by_sub = excluded.activated_by_sub, activated_at = excluded.activated_at").bind(input.projectId, input.revisionId, input.activatedBySub, timestamp).run();
}

export async function listSecurityPolicyRevisions(db: D1Database, ownerSub: string, projectId: string) {
  const result = await db.prepare("SELECT r.*, CASE WHEN h.revision_id = r.id THEN 1 ELSE 0 END AS active FROM security_policy_revisions r JOIN projects p ON p.id = r.project_id LEFT JOIN project_security_policy_heads h ON h.project_id = r.project_id WHERE r.project_id = ? AND p.owner_sub = ? ORDER BY r.revision DESC").bind(projectId, ownerSub).all<Record<string, unknown>>();
  return result.results.map(mapRevision);
}

export async function getActiveSecurityPolicy(db: D1Database, ownerSub: string, projectId: string) {
  const row = await db.prepare("SELECT r.*, 1 AS active FROM security_policy_revisions r JOIN project_security_policy_heads h ON h.revision_id = r.id JOIN projects p ON p.id = r.project_id WHERE r.project_id = ? AND p.owner_sub = ?").bind(projectId, ownerSub).first<Record<string, unknown>>();
  return row ? mapRevision(row) : null;
}

export async function ensureDefaultSecurityPolicy(db: D1Database, projectId: string, ownerSub: string) {
  return await getActiveSecurityPolicy(db, ownerSub, projectId) ?? createSecurityPolicyRevision(db, { projectId, ownerSub, createdBySub: ownerSub, policy: defaultSecurityPolicy() });
}

export async function pinTaskSecurityPolicy(db: D1Database, input: { taskId: string; ownerSub: string; revisionId?: string }) {
  const existing = await db.prepare("SELECT p.task_id AS taskId, p.revision_id AS revisionId, p.policy_digest AS policyDigest, p.pinned_at AS pinnedAt FROM task_security_policy_pins p JOIN tasks t ON t.id = p.task_id WHERE p.task_id = ? AND t.owner_sub = ?").bind(input.taskId, input.ownerSub).first<{ taskId: string; revisionId: string; policyDigest: string; pinnedAt: string }>();
  if (existing) return existing;
  const task = await db.prepare("SELECT id, project_id FROM tasks WHERE id = ? AND owner_sub = ?").bind(input.taskId, input.ownerSub).first<{ id: string; project_id: string }>();
  if (!task) throw new Error("Task not found");
  const active = input.revisionId
    ? await db.prepare("SELECT id, policy_digest FROM security_policy_revisions WHERE id = ? AND project_id = ?").bind(input.revisionId, task.project_id).first<{ id: string; policy_digest: string }>()
    : await db.prepare("SELECT r.id, r.policy_digest FROM security_policy_revisions r JOIN project_security_policy_heads h ON h.revision_id = r.id WHERE h.project_id = ?").bind(task.project_id).first<{ id: string; policy_digest: string }>();
  if (!active) throw new Error("Project has no active security policy");
  const pinnedAt = new Date().toISOString();
  await db.prepare("INSERT INTO task_security_policy_pins (task_id, revision_id, policy_digest, pinned_at) VALUES (?, ?, ?, ?)").bind(input.taskId, active.id, active.policy_digest, pinnedAt).run();
  return { taskId: input.taskId, revisionId: active.id, policyDigest: active.policy_digest, pinnedAt };
}

export async function getTaskSecurityPolicy(db: D1Database, ownerSub: string, taskId: string) {
  const row = await db.prepare("SELECT r.*, 1 AS active FROM security_policy_revisions r JOIN task_security_policy_pins pin ON pin.revision_id = r.id JOIN tasks t ON t.id = pin.task_id WHERE pin.task_id = ? AND t.owner_sub = ?").bind(taskId, ownerSub).first<Record<string, unknown>>();
  return row ? mapRevision(row) : null;
}

export async function createMcpToolGrant(db: D1Database, input: { taskId: string; ownerSub: string; connectorId: string; toolName: string; expiresAt: string; createdBySub: string }): Promise<McpToolGrant> {
  const toolName = normalizeTool(input.toolName);
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new Error("MCP tool grant expiry must be in the future");
  const context = await db.prepare("SELECT t.id AS task_id, p.revision_id FROM tasks t JOIN task_security_policy_pins p ON p.task_id = t.id JOIN project_connectors pc ON pc.project_id = t.project_id WHERE t.id = ? AND t.owner_sub = ? AND pc.connector_id = ?").bind(input.taskId, input.ownerSub, input.connectorId).first<{ task_id: string; revision_id: string }>();
  if (!context) throw new Error("Task, pinned policy, or project connector not found");
  const grant: McpToolGrant = { id: `grant_${crypto.randomUUID().replaceAll("-", "")}`, taskId: input.taskId, connectorId: input.connectorId, policyRevisionId: context.revision_id, toolName, expiresAt: expiry.toISOString(), revokedAt: null, createdBySub: input.createdBySub, createdAt: new Date().toISOString() };
  await db.prepare("INSERT INTO mcp_tool_grants (id, task_id, connector_id, policy_revision_id, tool_name, expires_at, created_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(grant.id, grant.taskId, grant.connectorId, grant.policyRevisionId, grant.toolName, grant.expiresAt, grant.createdBySub, grant.createdAt).run();
  return grant;
}

export async function isMcpToolGranted(db: D1Database, input: { taskId: string; connectorId: string; toolName: string; at?: string }) {
  const toolName = normalizeTool(input.toolName);
  const at = input.at ?? new Date().toISOString();
  const grant = await db.prepare("SELECT g.id FROM mcp_tool_grants g JOIN task_security_policy_pins p ON p.task_id = g.task_id AND p.revision_id = g.policy_revision_id WHERE g.task_id = ? AND g.connector_id = ? AND g.tool_name = ? AND g.revoked_at IS NULL AND g.expires_at > ?").bind(input.taskId, input.connectorId, toolName, at).first<{ id: string }>();
  return Boolean(grant);
}

export async function listMcpToolGrants(db: D1Database, input: { taskId: string; ownerSub: string; connectorId?: string }) {
  const query = input.connectorId
    ? db.prepare("SELECT g.* FROM mcp_tool_grants g JOIN tasks t ON t.id = g.task_id WHERE g.task_id = ? AND t.owner_sub = ? AND g.connector_id = ? ORDER BY g.created_at DESC").bind(input.taskId, input.ownerSub, input.connectorId)
    : db.prepare("SELECT g.* FROM mcp_tool_grants g JOIN tasks t ON t.id = g.task_id WHERE g.task_id = ? AND t.owner_sub = ? ORDER BY g.created_at DESC").bind(input.taskId, input.ownerSub);
  const result = await query.all<Record<string, unknown>>();
  return result.results.map((row): McpToolGrant => ({
    id: String(row.id), taskId: String(row.task_id), connectorId: String(row.connector_id),
    policyRevisionId: String(row.policy_revision_id), toolName: String(row.tool_name),
    expiresAt: String(row.expires_at), revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdBySub: String(row.created_by_sub), createdAt: String(row.created_at),
  }));
}

export async function revokeMcpToolGrant(db: D1Database, input: { grantId: string; taskId: string; ownerSub: string }) {
  const timestamp = new Date().toISOString();
  const result = await db.prepare("UPDATE mcp_tool_grants SET revoked_at = ? WHERE id = ? AND task_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND owner_sub = ?)").bind(timestamp, input.grantId, input.taskId, input.taskId, input.ownerSub).run();
  return result.meta.changes > 0;
}

export async function registerBrokeredSecretMetadata(db: D1Database, input: { projectId: string; ownerSub: string; label: string; storageRef: string; host: string; pathPrefix?: string; methods: string[]; headerName?: string; keyVersion: number }) {
  const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND owner_sub = ?").bind(input.projectId, input.ownerSub).first<{ id: string }>();
  if (!project) throw new Error("Project not found");
  const id = `secret_${crypto.randomUUID().replaceAll("-", "")}`;
  const host = normalizeHost(input.host);
  const pathPrefix = normalizePath(input.pathPrefix ?? "/", "Secret path prefix");
  const methods = unique(input.methods.map(normalizeMethod));
  const headerName = normalizeHeader(input.headerName ?? "authorization");
  if (!input.label.trim() || !input.storageRef || !methods.length || !Number.isInteger(input.keyVersion) || input.keyVersion < 1) throw new Error("Invalid brokered secret metadata");
  const createdAt = new Date().toISOString();
  await db.prepare("INSERT INTO brokered_secret_metadata (id, project_id, label, storage_ref, host, path_prefix, methods_json, header_name, key_version, rotated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, input.projectId, input.label.trim(), input.storageRef, host, pathPrefix, JSON.stringify(methods), headerName, input.keyVersion, createdAt, createdAt).run();
  return { id, projectId: input.projectId, label: input.label.trim(), host, pathPrefix, methods, headerName, keyVersion: input.keyVersion, rotatedAt: createdAt, createdAt };
}

export async function appendSecurityAuditEvent(db: D1Database, event: SecurityAuditEvent) {
  const createdAt = event.createdAt ?? new Date().toISOString();
  await db.prepare("INSERT INTO security_audit_events (owner_sub, project_id, task_id, policy_revision_id, category, action, decision, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(event.ownerSub, event.projectId ?? null, event.taskId ?? null, event.policyRevisionId ?? null, event.category, event.action, event.decision, redactSecurityText(event.target), JSON.stringify(redactSecurityValue(event.detail ?? {})), createdAt).run();
  return { ...event, target: redactSecurityText(event.target), detail: redactSecurityValue(event.detail ?? {}), createdAt };
}

export async function listSecurityAuditEvents(db: D1Database, input: { ownerSub: string; projectId?: string; taskId?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const clauses = ["owner_sub = ?"];
  const bindings: Array<string | number> = [input.ownerSub];
  if (input.projectId) { clauses.push("project_id = ?"); bindings.push(input.projectId); }
  if (input.taskId) { clauses.push("task_id = ?"); bindings.push(input.taskId); }
  bindings.push(limit);
  const result = await db.prepare(`SELECT owner_sub, project_id, task_id, policy_revision_id, category, action, decision, target, detail_json, created_at FROM security_audit_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).bind(...bindings).all<Record<string, unknown>>();
  return result.results.map((row): SecurityAuditEvent => ({
    ownerSub: String(row.owner_sub), projectId: row.project_id ? String(row.project_id) : null,
    taskId: row.task_id ? String(row.task_id) : null, policyRevisionId: row.policy_revision_id ? String(row.policy_revision_id) : null,
    category: row.category as SecurityAuditEvent["category"], action: String(row.action),
    decision: row.decision as SecurityAuditEvent["decision"], target: String(row.target),
    detail: JSON.parse(String(row.detail_json)), createdAt: String(row.created_at),
  }));
}

export function aggregateSecurityAuditEvents(events: readonly SecurityAuditEvent[]): SecurityAuditSummary {
  const summary: SecurityAuditSummary = {
    total: events.length,
    byDecision: { allowed: 0, denied: 0, observed: 0, error: 0 },
    byCategory: { network: 0, filesystem: 0, tool: 0, secret: 0, mcp: 0, policy: 0 },
    deniedTargets: [],
  };
  const denied = new Map<string, number>();
  for (const event of events) {
    summary.byDecision[event.decision] += 1;
    summary.byCategory[event.category] += 1;
    if (event.decision === "denied") denied.set(event.target, (denied.get(event.target) ?? 0) + 1);
  }
  summary.deniedTargets = [...denied].map(([target, count]) => ({ target, count })).sort((left, right) => right.count - left.count || left.target.localeCompare(right.target));
  return summary;
}
