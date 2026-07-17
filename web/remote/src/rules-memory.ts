const RULE_CONTENT_LIMIT = 32_768;
const MEMORY_CONTENT_LIMIT = 8_192;
const REPOSITORY_RULE_TOTAL_LIMIT = 256_000;
const REPOSITORY_RULE_FILE_LIMIT = 32_768;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,119}$/u;

export type RuleScope = "user" | "project";
export type RuleMode = "always" | "agent-requested" | "manual";
export type MemoryScope = "user" | "project";
export type MemoryStatus = "active" | "disabled" | "deleted";
export type MemorySourceType = "user-stated" | "task-observation" | "repository" | "import";

export type CustomizationRule = {
  id: string;
  ownerSub: string;
  projectId: string | null;
  scope: RuleScope;
  name: string;
  mode: RuleMode;
  pathGlob: string;
  enabled: boolean;
  revisionId: string;
  version: number;
  content: string;
  reason: string;
  createdBySub: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomizationRuleRevision = {
  id: string;
  ruleId: string;
  version: number;
  content: string;
  reason: string;
  createdBySub: string;
  createdAt: string;
};

export type RepositoryRule = {
  id: string;
  sourcePath: string;
  name: string;
  mode: RuleMode;
  pathGlob: string;
  content: string;
  precedence: number;
};

export type TransparentMemory = {
  id: string;
  ownerSub: string;
  projectId: string | null;
  scope: MemoryScope;
  title: string;
  content: string;
  reason: string;
  sourceType: MemorySourceType;
  sourceRef: string;
  confidence: number;
  status: MemoryStatus;
  createdBySub: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type ContextProvenance = {
  kind: "rule" | "repository-rule" | "memory";
  id: string;
  label: string;
  source: string;
  reason: string;
  precedence: number;
  confidence?: number;
};

export type ResolvedPromptContext = {
  content: string;
  provenance: ContextProvenance[];
  omitted: Array<{ kind: ContextProvenance["kind"]; id: string; reason: string }>;
  privacyMode: boolean;
  usedCharacters: number;
};

type RuleRow = {
  id: string; owner_sub: string; project_id: string | null; scope: RuleScope; name: string;
  mode: RuleMode; path_glob: string; enabled: number; current_revision_id: string;
  created_at: string; updated_at: string; revision_id: string; version: number; content: string;
  reason: string; created_by_sub: string; revision_created_at: string;
};

type MemoryRow = {
  id: string; owner_sub: string; project_id: string | null; scope: MemoryScope; title: string;
  content: string; reason: string; source_type: MemorySourceType; source_ref: string;
  confidence: number; status: MemoryStatus; created_by_sub: string; created_at: string;
  updated_at: string; deleted_at: string | null;
};

function fail(message: string): never { throw new Error(message); }
function timestamp() { return new Date().toISOString(); }
function identifier(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

function cleanText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > maximum || text.includes("\0")) fail(`${field} must contain 1 to ${maximum} safe characters`);
  return text;
}

function cleanName(value: unknown, field = "Name") {
  const name = cleanText(value, field, 120);
  if (!NAME_PATTERN.test(name)) fail(`${field} contains unsupported characters`);
  return name;
}

function cleanScope(scope: unknown, projectId: unknown): { scope: RuleScope; projectId: string | null } {
  if (scope !== "user" && scope !== "project") fail("Scope must be user or project");
  if (scope === "user") {
    if (projectId != null) fail("User-scoped records cannot have a projectId");
    return { scope, projectId: null };
  }
  const id = cleanText(projectId, "projectId", 160);
  return { scope, projectId: id };
}

function cleanMode(value: unknown): RuleMode {
  if (value !== "always" && value !== "agent-requested" && value !== "manual") fail("Invalid rule mode");
  return value;
}

export function normalizeRepositoryPath(value: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) fail("Repository path must be a normalized relative path");
  if (path.length > 1_000) fail("Repository path is too long");
  return path;
}

export function normalizeRuleGlob(value: unknown) {
  if (typeof value !== "string") fail("Rule glob must be a string");
  let glob = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!glob) glob = "**/*";
  if (glob.startsWith("/") || glob.includes("\0") || glob.length > 500 || glob.split("/").includes("..")) fail("Rule glob must be a safe relative glob");
  if (/[^\p{L}\p{N} ._/*?\-]/u.test(glob)) fail("Rule glob contains unsupported characters");
  return glob;
}

function escapeRegExp(character: string) { return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character; }

function globExpression(glob: string) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") { index += 1; expression += "(?:.*/)?"; }
        else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += escapeRegExp(character);
  }
  return new RegExp(`${expression}$`, "u");
}

export function ruleAppliesToPath(glob: string, repositoryPath: string) {
  return globExpression(normalizeRuleGlob(glob)).test(normalizeRepositoryPath(repositoryPath));
}

function parseFrontmatter(content: string) {
  if (!content.startsWith("---\n")) return { body: content.trim(), mode: "always" as RuleMode, globs: [] as string[] };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0 || end > 4_096) fail("Rule frontmatter is not terminated safely");
  const metadata = content.slice(4, end).split("\n");
  let mode: RuleMode = "always";
  let globs: string[] = [];
  for (const line of metadata) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) fail("Rule frontmatter contains an invalid entry");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "mode") mode = cleanMode(value);
    else if (key === "globs" || key === "glob") globs = value.split(",").map((item) => normalizeRuleGlob(item));
    else if (key !== "description") fail(`Unsupported rule frontmatter key: ${key}`);
  }
  return { body: cleanText(content.slice(end + 5), "Repository rule content", REPOSITORY_RULE_FILE_LIMIT), mode, globs };
}

function directoryGlob(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "**/*" : `${path.slice(0, slash)}/**/*`;
}

export function discoverRepositoryRules(files: readonly { path: string; content: string }[]) {
  const rules: RepositoryRule[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  let total = 0;
  for (const file of files.slice(0, 1_000)) {
    let path: string;
    try { path = normalizeRepositoryPath(file.path); } catch (error) { rejected.push({ path: String(file.path), reason: (error as Error).message }); continue; }
    const isAgents = /(^|\/)AGENTS\.md$/.test(path);
    const isGrokRule = /^\.grok\/rules\/[^/]+\.md$/i.test(path);
    if (!isAgents && !isGrokRule) continue;
    if (typeof file.content !== "string" || file.content.length > REPOSITORY_RULE_FILE_LIMIT || total + file.content.length > REPOSITORY_RULE_TOTAL_LIMIT) {
      rejected.push({ path, reason: "Repository rule exceeds safe size limits" });
      continue;
    }
    try {
      const parsed = parseFrontmatter(file.content);
      const globs = parsed.globs.length ? parsed.globs : [isAgents ? directoryGlob(path) : "**/*"];
      for (const [position, pathGlob] of globs.entries()) {
        const depth = path.split("/").length - 1;
        rules.push({
          id: `repo:${path}:${position}`,
          sourcePath: path,
          name: path.split("/").at(-1)!,
          mode: parsed.mode,
          pathGlob,
          content: parsed.body,
          precedence: (isAgents ? 300 : 250) + depth,
        });
      }
      total += file.content.length;
    } catch (error) { rejected.push({ path, reason: (error as Error).message }); }
  }
  return { rules, rejected, scannedFiles: Math.min(files.length, 1_000), acceptedBytes: total };
}

function mapRule(row: RuleRow): CustomizationRule {
  return {
    id: row.id, ownerSub: row.owner_sub, projectId: row.project_id, scope: row.scope, name: row.name,
    mode: row.mode, pathGlob: row.path_glob, enabled: Boolean(row.enabled), revisionId: row.revision_id,
    version: Number(row.version), content: row.content, reason: row.reason, createdBySub: row.created_by_sub,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapMemory(row: MemoryRow): TransparentMemory {
  return {
    id: row.id, ownerSub: row.owner_sub, projectId: row.project_id, scope: row.scope, title: row.title,
    content: row.content, reason: row.reason, sourceType: row.source_type, sourceRef: row.source_ref,
    confidence: Number(row.confidence), status: row.status, createdBySub: row.created_by_sub,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
  };
}

const RULE_SELECT = `SELECT r.*, v.id AS revision_id, v.version, v.content, v.reason, v.created_by_sub, v.created_at AS revision_created_at
  FROM customization_rules r JOIN customization_rule_revisions v ON v.id = r.current_revision_id`;

async function assertOwnedProject(db: D1Database, ownerSub: string, projectId: string) {
  const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND owner_sub = ?").bind(projectId, ownerSub).first<{ id: string }>();
  if (!project) fail("Project not found");
}

export async function createCustomizationRule(db: D1Database, input: { ownerSub: string; actorSub: string; scope: RuleScope; projectId?: string | null; name: string; mode: RuleMode; pathGlob?: string; content: string; reason: string }) {
  const scoped = cleanScope(input.scope, input.projectId);
  if (scoped.projectId) await assertOwnedProject(db, input.ownerSub, scoped.projectId);
  const ruleId = identifier("rule");
  const revisionId = identifier("rrev");
  const createdAt = timestamp();
  const name = cleanName(input.name);
  const mode = cleanMode(input.mode);
  const pathGlob = normalizeRuleGlob(input.pathGlob ?? "**/*");
  const content = cleanText(input.content, "Rule content", RULE_CONTENT_LIMIT);
  const reason = cleanText(input.reason, "Rule reason", 500);
  await db.batch([
    db.prepare("INSERT INTO customization_rules (id, owner_sub, project_id, scope, name, mode, path_glob, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(ruleId, input.ownerSub, scoped.projectId, scoped.scope, name, mode, pathGlob, createdAt, createdAt),
    db.prepare("INSERT INTO customization_rule_revisions (id, rule_id, version, content, reason, created_by_sub, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)").bind(revisionId, ruleId, content, reason, input.actorSub, createdAt),
    db.prepare("UPDATE customization_rules SET current_revision_id = ? WHERE id = ? AND owner_sub = ?").bind(revisionId, ruleId, input.ownerSub),
  ]);
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: scoped.projectId, entityType: "rule", entityId: ruleId, action: "created", detail: { scope: scoped.scope, mode, pathGlob, version: 1 } });
  return (await getCustomizationRule(db, input.ownerSub, ruleId))!;
}

export async function updateCustomizationRule(db: D1Database, input: { ownerSub: string; actorSub: string; ruleId: string; content: string; reason: string; expectedVersion: number; name?: string; mode?: RuleMode; pathGlob?: string }) {
  const current = await getCustomizationRule(db, input.ownerSub, input.ruleId);
  if (!current) fail("Customization rule not found");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== current.version) fail("Customization rule version conflict");
  const revisionId = identifier("rrev");
  const version = current.version + 1;
  const updatedAt = timestamp();
  const content = cleanText(input.content, "Rule content", RULE_CONTENT_LIMIT);
  const reason = cleanText(input.reason, "Rule reason", 500);
  const name = input.name === undefined ? current.name : cleanName(input.name);
  const mode = input.mode === undefined ? current.mode : cleanMode(input.mode);
  const pathGlob = input.pathGlob === undefined ? current.pathGlob : normalizeRuleGlob(input.pathGlob);
  await db.batch([
    db.prepare("INSERT INTO customization_rule_revisions (id, rule_id, version, content, reason, created_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(revisionId, current.id, version, content, reason, input.actorSub, updatedAt),
    db.prepare("UPDATE customization_rules SET name = ?, mode = ?, path_glob = ?, current_revision_id = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND current_revision_id = ?").bind(name, mode, pathGlob, revisionId, updatedAt, current.id, input.ownerSub, current.revisionId),
  ]);
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: current.projectId, entityType: "rule", entityId: current.id, action: "revised", detail: { version, mode, pathGlob } });
  return (await getCustomizationRule(db, input.ownerSub, current.id))!;
}

export async function setCustomizationRuleEnabled(db: D1Database, input: { ownerSub: string; actorSub: string; ruleId: string; enabled: boolean }) {
  const rule = await getCustomizationRule(db, input.ownerSub, input.ruleId);
  if (!rule) fail("Customization rule not found");
  await db.prepare("UPDATE customization_rules SET enabled = ?, updated_at = ? WHERE id = ? AND owner_sub = ?").bind(input.enabled ? 1 : 0, timestamp(), rule.id, input.ownerSub).run();
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: rule.projectId, entityType: "rule", entityId: rule.id, action: input.enabled ? "enabled" : "disabled" });
  return { ...rule, enabled: input.enabled };
}

export async function getCustomizationRule(db: D1Database, ownerSub: string, ruleId: string) {
  const row = await db.prepare(`${RULE_SELECT} WHERE r.id = ? AND r.owner_sub = ?`).bind(ruleId, ownerSub).first<RuleRow>();
  return row ? mapRule(row) : null;
}

export async function listCustomizationRules(db: D1Database, input: { ownerSub: string; projectId?: string; includeDisabled?: boolean }) {
  if (input.projectId) await assertOwnedProject(db, input.ownerSub, input.projectId);
  const enabled = input.includeDisabled ? "" : " AND r.enabled = 1";
  const project = input.projectId
    ? " AND (r.scope = 'user' OR (r.scope = 'project' AND r.project_id = ?))"
    : " AND r.scope = 'user'";
  const query = db.prepare(`${RULE_SELECT} WHERE r.owner_sub = ?${project}${enabled} ORDER BY CASE r.scope WHEN 'user' THEN 0 ELSE 1 END, r.name, v.version DESC`);
  const result = input.projectId ? await query.bind(input.ownerSub, input.projectId).all<RuleRow>() : await query.bind(input.ownerSub).all<RuleRow>();
  return result.results.map(mapRule);
}

export async function listCustomizationRuleRevisions(db: D1Database, input: { ownerSub: string; ruleId: string }) {
  const owned = await db.prepare("SELECT id FROM customization_rules WHERE id = ? AND owner_sub = ?").bind(input.ruleId, input.ownerSub).first<{ id: string }>();
  if (!owned) fail("Customization rule not found");
  const result = await db.prepare("SELECT id, rule_id, version, content, reason, created_by_sub, created_at FROM customization_rule_revisions WHERE rule_id = ? ORDER BY version DESC").bind(input.ruleId).all<{ id: string; rule_id: string; version: number; content: string; reason: string; created_by_sub: string; created_at: string }>();
  return result.results.map((row): CustomizationRuleRevision => ({ id: row.id, ruleId: row.rule_id, version: Number(row.version), content: row.content, reason: row.reason, createdBySub: row.created_by_sub, createdAt: row.created_at }));
}

export function validateMemoryInput(input: { scope: unknown; projectId?: unknown; title: unknown; content: unknown; reason: unknown; sourceType: unknown; sourceRef: unknown; confidence: unknown }) {
  const scoped = cleanScope(input.scope, input.projectId);
  if (!["user-stated", "task-observation", "repository", "import"].includes(String(input.sourceType))) fail("Invalid memory source type");
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail("Memory confidence must be between 0 and 1");
  return {
    ...scoped, title: cleanText(input.title, "Memory title", 160), content: cleanText(input.content, "Memory content", MEMORY_CONTENT_LIMIT),
    reason: cleanText(input.reason, "Memory reason", 500), sourceType: input.sourceType as MemorySourceType,
    sourceRef: cleanText(input.sourceRef, "Memory source reference", 1_000), confidence,
  };
}

export async function createTransparentMemory(db: D1Database, input: { ownerSub: string; actorSub: string; scope: MemoryScope; projectId?: string | null; title: string; content: string; reason: string; sourceType: MemorySourceType; sourceRef: string; confidence: number }) {
  const value = validateMemoryInput(input);
  if (value.projectId) await assertOwnedProject(db, input.ownerSub, value.projectId);
  if (await getMemoryPrivacyMode(db, input.ownerSub, value.projectId)) fail("Privacy mode prevents memory generation");
  const memory: TransparentMemory = { id: identifier("mem"), ownerSub: input.ownerSub, projectId: value.projectId, scope: value.scope, title: value.title, content: value.content, reason: value.reason, sourceType: value.sourceType, sourceRef: value.sourceRef, confidence: value.confidence, status: "active", createdBySub: input.actorSub, createdAt: timestamp(), updatedAt: "", deletedAt: null };
  memory.updatedAt = memory.createdAt;
  await db.prepare("INSERT INTO transparent_memories (id, owner_sub, project_id, scope, title, content, reason, source_type, source_ref, confidence, status, created_by_sub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").bind(memory.id, memory.ownerSub, memory.projectId, memory.scope, memory.title, memory.content, memory.reason, memory.sourceType, memory.sourceRef, memory.confidence, memory.createdBySub, memory.createdAt, memory.updatedAt).run();
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: memory.projectId, entityType: "memory", entityId: memory.id, action: "created", detail: { sourceType: memory.sourceType, sourceRef: memory.sourceRef, confidence: memory.confidence } });
  return memory;
}

export async function updateTransparentMemory(db: D1Database, input: { ownerSub: string; actorSub: string; memoryId: string; title: string; content: string; reason: string; confidence: number }) {
  const memory = await getTransparentMemory(db, input.ownerSub, input.memoryId);
  if (!memory || memory.status === "deleted") fail("Memory not found");
  const title = cleanText(input.title, "Memory title", 160);
  const content = cleanText(input.content, "Memory content", MEMORY_CONTENT_LIMIT);
  const reason = cleanText(input.reason, "Memory reason", 500);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) fail("Memory confidence must be between 0 and 1");
  const updatedAt = timestamp();
  await db.prepare("UPDATE transparent_memories SET title = ?, content = ?, reason = ?, confidence = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status != 'deleted'").bind(title, content, reason, input.confidence, updatedAt, memory.id, input.ownerSub).run();
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: memory.projectId, entityType: "memory", entityId: memory.id, action: "edited", detail: { confidence: input.confidence } });
  return { ...memory, title, content, reason, confidence: input.confidence, updatedAt };
}

export async function setTransparentMemoryStatus(db: D1Database, input: { ownerSub: string; actorSub: string; memoryId: string; status: "active" | "disabled" | "deleted" }) {
  const memory = await getTransparentMemory(db, input.ownerSub, input.memoryId);
  if (!memory || memory.status === "deleted") fail("Memory not found");
  const updatedAt = timestamp();
  const deletedAt = input.status === "deleted" ? updatedAt : null;
  await db.prepare("UPDATE transparent_memories SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND owner_sub = ? AND status != 'deleted'").bind(input.status, deletedAt, updatedAt, memory.id, input.ownerSub).run();
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: memory.projectId, entityType: "memory", entityId: memory.id, action: input.status, detail: { previousStatus: memory.status } });
  return { ...memory, status: input.status, deletedAt, updatedAt };
}

export async function getTransparentMemory(db: D1Database, ownerSub: string, memoryId: string) {
  const row = await db.prepare("SELECT * FROM transparent_memories WHERE id = ? AND owner_sub = ?").bind(memoryId, ownerSub).first<MemoryRow>();
  return row ? mapMemory(row) : null;
}

export async function listTransparentMemories(db: D1Database, input: { ownerSub: string; projectId?: string; includeDisabled?: boolean; includeDeleted?: boolean }) {
  if (input.projectId) await assertOwnedProject(db, input.ownerSub, input.projectId);
  const statuses = ["active", ...(input.includeDisabled ? ["disabled"] : []), ...(input.includeDeleted ? ["deleted"] : [])];
  const placeholders = statuses.map(() => "?").join(", ");
  const projectClause = input.projectId ? "AND (scope = 'user' OR (scope = 'project' AND project_id = ?))" : "AND scope = 'user'";
  const bindings: unknown[] = [input.ownerSub, ...statuses];
  if (input.projectId) bindings.push(input.projectId);
  const result = await db.prepare(`SELECT * FROM transparent_memories WHERE owner_sub = ? AND status IN (${placeholders}) ${projectClause} ORDER BY scope, updated_at DESC, id`).bind(...bindings).all<MemoryRow>();
  return result.results.map(mapMemory);
}

export async function setMemoryPrivacyMode(db: D1Database, input: { ownerSub: string; actorSub: string; projectId?: string | null; privacyMode: boolean }) {
  if (input.projectId) await assertOwnedProject(db, input.ownerSub, input.projectId);
  const updatedAt = timestamp();
  await db.prepare("INSERT INTO memory_privacy_settings (owner_sub, project_id, project_key, privacy_mode, updated_by_sub, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_sub, project_key) DO UPDATE SET privacy_mode = excluded.privacy_mode, updated_by_sub = excluded.updated_by_sub, updated_at = excluded.updated_at").bind(input.ownerSub, input.projectId ?? null, input.projectId ?? "*", input.privacyMode ? 1 : 0, input.actorSub, updatedAt).run();
  await appendRulesMemoryAudit(db, { ownerSub: input.ownerSub, actorSub: input.actorSub, projectId: input.projectId ?? null, entityType: "privacy", action: input.privacyMode ? "enabled" : "disabled" });
  return { ownerSub: input.ownerSub, projectId: input.projectId ?? null, privacyMode: input.privacyMode, updatedAt };
}

export async function getMemoryPrivacyMode(db: D1Database, ownerSub: string, projectId?: string | null) {
  if (projectId) await assertOwnedProject(db, ownerSub, projectId);
  const rows = projectId
    ? await db.prepare("SELECT project_id, privacy_mode FROM memory_privacy_settings WHERE owner_sub = ? AND (project_id IS NULL OR project_id = ?)").bind(ownerSub, projectId).all<{ project_id: string | null; privacy_mode: number }>()
    : await db.prepare("SELECT project_id, privacy_mode FROM memory_privacy_settings WHERE owner_sub = ? AND project_id IS NULL").bind(ownerSub).all<{ project_id: string | null; privacy_mode: number }>();
  return rows.results.some((row) => Boolean(row.privacy_mode));
}

export function previewMemoriesForContext(memories: readonly TransparentMemory[], privacyMode: boolean) {
  if (privacyMode) return [];
  return memories.filter((memory) => memory.status === "active").map((memory) => ({ id: memory.id, title: memory.title, reason: memory.reason, sourceType: memory.sourceType, sourceRef: memory.sourceRef, confidence: memory.confidence, scope: memory.scope }));
}

export function resolvePromptContext(input: { rules: readonly CustomizationRule[]; repositoryRules?: readonly RepositoryRule[]; memories?: readonly TransparentMemory[]; repositoryPath: string; requestedRuleIds?: readonly string[]; manualRuleIds?: readonly string[]; visibleMemoryIds?: readonly string[]; privacyMode: boolean; maxCharacters?: number; maxItems?: number }): ResolvedPromptContext {
  const path = normalizeRepositoryPath(input.repositoryPath);
  const requested = new Set(input.requestedRuleIds ?? []);
  const manual = new Set(input.manualRuleIds ?? []);
  const visible = new Set(input.visibleMemoryIds ?? []);
  const maximum = Math.max(1_000, Math.min(100_000, Math.floor(input.maxCharacters ?? 24_000)));
  const maxItems = Math.max(1, Math.min(100, Math.floor(input.maxItems ?? 32)));
  const omitted: ResolvedPromptContext["omitted"] = [];
  const candidates: Array<{ provenance: ContextProvenance; content: string }> = [];
  const allowedMode = (id: string, mode: RuleMode) => mode === "always" || (mode === "agent-requested" && requested.has(id)) || (mode === "manual" && manual.has(id));

  for (const rule of input.rules) {
    if (!rule.enabled) { omitted.push({ kind: "rule", id: rule.id, reason: "disabled" }); continue; }
    if (!ruleAppliesToPath(rule.pathGlob, path)) { omitted.push({ kind: "rule", id: rule.id, reason: "glob-not-applicable" }); continue; }
    if (!allowedMode(rule.id, rule.mode)) { omitted.push({ kind: "rule", id: rule.id, reason: `mode-${rule.mode}-not-selected` }); continue; }
    candidates.push({ content: rule.content, provenance: { kind: "rule", id: rule.id, label: rule.name, source: `${rule.scope}:revision:${rule.version}`, reason: rule.reason, precedence: rule.scope === "user" ? 100 : 200 } });
  }
  for (const rule of input.repositoryRules ?? []) {
    if (!ruleAppliesToPath(rule.pathGlob, path)) { omitted.push({ kind: "repository-rule", id: rule.id, reason: "glob-not-applicable" }); continue; }
    if (!allowedMode(rule.id, rule.mode)) { omitted.push({ kind: "repository-rule", id: rule.id, reason: `mode-${rule.mode}-not-selected` }); continue; }
    candidates.push({ content: rule.content, provenance: { kind: "repository-rule", id: rule.id, label: rule.name, source: rule.sourcePath, reason: "Repository-provided rule", precedence: rule.precedence } });
  }
  for (const memory of input.memories ?? []) {
    if (input.privacyMode) { omitted.push({ kind: "memory", id: memory.id, reason: "privacy-mode" }); continue; }
    if (memory.status !== "active") { omitted.push({ kind: "memory", id: memory.id, reason: memory.status }); continue; }
    if (!visible.has(memory.id)) { omitted.push({ kind: "memory", id: memory.id, reason: "not-visible-before-use" }); continue; }
    candidates.push({ content: memory.content, provenance: { kind: "memory", id: memory.id, label: memory.title, source: `${memory.sourceType}:${memory.sourceRef}`, reason: memory.reason, confidence: memory.confidence, precedence: memory.scope === "user" ? 110 : 210 } });
  }
  candidates.sort((left, right) => left.provenance.precedence - right.provenance.precedence || left.provenance.id.localeCompare(right.provenance.id));
  const sections: string[] = [];
  const provenance: ContextProvenance[] = [];
  let used = 0;
  for (const candidate of candidates) {
    if (provenance.length >= maxItems) { omitted.push({ kind: candidate.provenance.kind, id: candidate.provenance.id, reason: "item-limit" }); continue; }
    const section = `### ${candidate.provenance.label}\nSource: ${candidate.provenance.source}\n${candidate.content}`;
    if (used + section.length + (sections.length ? 2 : 0) > maximum) { omitted.push({ kind: candidate.provenance.kind, id: candidate.provenance.id, reason: "character-limit" }); continue; }
    sections.push(section); provenance.push(candidate.provenance); used += section.length + (sections.length > 1 ? 2 : 0);
  }
  return { content: sections.join("\n\n"), provenance, omitted, privacyMode: input.privacyMode, usedCharacters: used };
}

export type RulesMemoryAuditEvent = { ownerSub: string; actorSub: string; projectId?: string | null; entityType: "rule" | "memory" | "privacy" | "context"; entityId?: string | null; action: string; detail?: unknown; createdAt?: string };

function safeAuditDetail(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeAuditDetail(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, /content|secret|token|password/i.test(key) ? "[REDACTED]" : safeAuditDetail(item, depth + 1)]));
  return value;
}

export async function appendRulesMemoryAudit(db: D1Database, event: RulesMemoryAuditEvent) {
  const createdAt = event.createdAt ?? timestamp();
  const detail = safeAuditDetail(event.detail ?? {});
  await db.prepare("INSERT INTO rules_memory_audit_events (owner_sub, actor_sub, project_id, entity_type, entity_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(event.ownerSub, event.actorSub, event.projectId ?? null, event.entityType, event.entityId ?? null, cleanText(event.action, "Audit action", 160), JSON.stringify(detail), createdAt).run();
  return { ...event, detail, createdAt };
}

export async function listRulesMemoryAudit(db: D1Database, input: { ownerSub: string; projectId?: string; limit?: number }) {
  if (input.projectId) await assertOwnedProject(db, input.ownerSub, input.projectId);
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const query = input.projectId
    ? db.prepare("SELECT * FROM rules_memory_audit_events WHERE owner_sub = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(input.ownerSub, input.projectId, limit)
    : db.prepare("SELECT * FROM rules_memory_audit_events WHERE owner_sub = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(input.ownerSub, limit);
  const result = await query.all<Record<string, unknown>>();
  return result.results.map((row) => ({ ownerSub: String(row.owner_sub), actorSub: String(row.actor_sub), projectId: row.project_id ? String(row.project_id) : null, entityType: row.entity_type as RulesMemoryAuditEvent["entityType"], entityId: row.entity_id ? String(row.entity_id) : null, action: String(row.action), detail: JSON.parse(String(row.detail_json)), createdAt: String(row.created_at) }));
}
