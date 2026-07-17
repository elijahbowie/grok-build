import { id, now } from "./db";

const MAX_REPOSITORIES = 8;
const MAX_COMMANDS = 64;
const MAX_COMMAND_LENGTH = 2_000;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;

export type EnvironmentManifest = {
  runtime: "managed";
  runtimeRelease: string;
  setup: string[];
  validation: string[];
};

export type EnvironmentRepositoryInput = {
  id?: string;
  name: string;
  sourceType: "artifacts" | "github";
  sourceUrl?: string | null;
  ref?: string;
  pinnedSha?: string | null;
  checkoutPath: string;
  writable?: boolean;
};

export type EnvironmentDraft = {
  projectId: string;
  revision: number;
  manifest: EnvironmentManifest;
  repositories: EnvironmentRepository[];
  createdAt: string;
  updatedAt: string;
};

export type EnvironmentRepository = {
  id: string;
  name: string;
  sourceType: "artifacts" | "github";
  sourceUrl: string | null;
  ref: string;
  pinnedSha: string | null;
  checkoutPath: string;
  writable: boolean;
  position: number;
};

export type EnvironmentVersion = {
  id: string;
  projectId: string;
  version: number;
  manifest: EnvironmentManifest;
  manifestHash: string;
  sourceDraftRevision: number;
  repositories: EnvironmentRepository[];
  secretIds: string[];
  createdAt: string;
  active: boolean;
};

export type EnvironmentSecretMetadata = {
  id: string;
  projectId: string;
  name: string;
  scope: "setup" | "runtime";
  secretRef: string;
  secretVersion: number;
  createdAt: string;
  rotatedAt: string | null;
  deletedAt: string | null;
};

export type EnvironmentBuild = {
  id: string;
  environmentVersionId: string;
  status: "queued" | "building" | "ready" | "failed" | "cancelled";
  fingerprint: string;
  runtimeRelease: string;
  workflowId: string | null;
  logKey: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type EnvironmentSnapshot = {
  id: string;
  environmentVersionId: string;
  buildId: string;
  fingerprint: string;
  backupId: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  invalidatedAt: string | null;
};

export type ResolvedTaskEnvironment = {
  taskId: string;
  environmentVersionId: string;
  snapshotId: string | null;
  targetRepositoryId: string;
  manifestHash: string;
  resolvedAt: string;
  manifest: EnvironmentManifest;
  repositories: EnvironmentRepository[];
  secrets: EnvironmentSecretMetadata[];
};

type DraftRow = {
  project_id: string; owner_sub: string; manifest_json: string; revision: number;
  created_at: string; updated_at: string;
};

type RepositoryRow = {
  id: string; name: string; source_type: "artifacts" | "github"; source_url: string | null;
  ref: string; pinned_sha: string | null; checkout_path: string; writable: number; position: number;
};

type VersionRow = {
  id: string; project_id: string; owner_sub: string; version: number; manifest_json: string;
  manifest_hash: string; source_draft_revision: number; created_at: string; active: number;
};

type SecretRow = {
  id: string; project_id: string; name: string; scope: "setup" | "runtime"; secret_ref: string;
  secret_version: number; created_at: string; rotated_at: string | null; deleted_at: string | null;
};

type BuildRow = {
  id: string; environment_version_id: string; status: EnvironmentBuild["status"]; fingerprint: string;
  runtime_release: string; workflow_id: string | null; log_key: string | null; error: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
};

type SnapshotRow = {
  id: string; environment_version_id: string; build_id: string; fingerprint: string; backup_id: string;
  size_bytes: number; metadata_json: string; created_at: string; invalidated_at: string | null;
};

function fail(message: string): never {
  throw new Error(message);
}

function cleanCommands(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) fail(`${field} must be an array with at most ${MAX_COMMANDS} commands`);
  return value.map((command, index) => {
    if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND_LENGTH || command.includes("\0")) fail(`${field}[${index}] is invalid`);
    return command.trim();
  });
}

export function validateEnvironmentManifest(value: unknown): EnvironmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Environment manifest must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["runtime", "runtimeRelease", "setup", "validation"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unknown environment manifest field: ${key}`);
  if ((input.runtime ?? "managed") !== "managed") fail("Only the managed runtime is supported");
  const runtimeRelease = typeof input.runtimeRelease === "string" ? input.runtimeRelease.trim() : "current";
  if (!NAME_PATTERN.test(runtimeRelease)) fail("runtimeRelease is invalid");
  return {
    runtime: "managed",
    runtimeRelease,
    setup: cleanCommands(input.setup ?? [], "setup"),
    validation: cleanCommands(input.validation ?? [], "validation"),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRepository(input: EnvironmentRepositoryInput, position: number): EnvironmentRepository {
  const name = input.name?.trim();
  if (!NAME_PATTERN.test(name)) fail(`Repository ${position + 1} has an invalid name`);
  if (!(["artifacts", "github"] as const).includes(input.sourceType)) fail(`Repository ${name} has an invalid source type`);
  const ref = (input.ref || "main").trim();
  if (!ref || ref.length > 255 || /[\x00-\x20~^:?*[\\]/.test(ref) || ref.includes("..") || ref.startsWith("-") || ref.endsWith(".") || ref.endsWith("/")) fail(`Repository ${name} has an invalid ref`);
  const pinnedSha = input.pinnedSha?.trim() || null;
  if (pinnedSha && !SHA_PATTERN.test(pinnedSha)) fail(`Repository ${name} has an invalid pinned SHA`);
  let sourceUrl = input.sourceUrl?.trim() || null;
  if (input.sourceType === "github") {
    if (!sourceUrl) fail(`GitHub repository ${name} requires sourceUrl`);
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) fail(`Repository ${name} must use a public github.com HTTPS URL`);
    sourceUrl = url.toString();
  } else if (sourceUrl) fail(`Artifacts repository ${name} cannot define sourceUrl`);
  const checkoutPath = input.checkoutPath?.trim().replace(/^\.\//, "");
  if (!checkoutPath || checkoutPath.length > 160 || checkoutPath.startsWith("/") || checkoutPath.split("/").some((part) => !part || part === "." || part === ".." || !/^[a-zA-Z0-9._-]+$/.test(part))) fail(`Repository ${name} has an invalid checkoutPath`);
  return { id: input.id || id("envrepo"), name, sourceType: input.sourceType, sourceUrl, ref, pinnedSha, checkoutPath, writable: Boolean(input.writable), position };
}

export function validateEnvironmentRepositories(inputs: EnvironmentRepositoryInput[], publishing = false) {
  if (!Array.isArray(inputs) || inputs.length > MAX_REPOSITORIES || (publishing && inputs.length === 0)) fail(`An environment must contain ${publishing ? "one to " : "at most "}${MAX_REPOSITORIES} repositories`);
  const repositories = inputs.map(normalizeRepository);
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const repository of repositories) {
    if (names.has(repository.name.toLowerCase())) fail(`Duplicate repository name: ${repository.name}`);
    if (paths.has(repository.checkoutPath.toLowerCase())) fail(`Duplicate checkout path: ${repository.checkoutPath}`);
    names.add(repository.name.toLowerCase()); paths.add(repository.checkoutPath.toLowerCase());
  }
  const writable = repositories.filter((repository) => repository.writable);
  if (writable.length > 1 || (publishing && writable.length !== 1)) fail(publishing ? "Published environments require exactly one writable repository" : "A draft can have at most one writable repository");
  if (publishing && repositories.some((repository) => !repository.writable && !repository.pinnedSha)) fail("Every read-only context repository must be pinned to an exact commit SHA before publishing");
  return repositories;
}

function repositoryFromRow(row: RepositoryRow): EnvironmentRepository {
  return { id: row.id, name: row.name, sourceType: row.source_type, sourceUrl: row.source_url, ref: row.ref, pinnedSha: row.pinned_sha, checkoutPath: row.checkout_path, writable: Boolean(row.writable), position: row.position };
}

function secretFromRow(row: SecretRow): EnvironmentSecretMetadata {
  return { id: row.id, projectId: row.project_id, name: row.name, scope: row.scope, secretRef: row.secret_ref, secretVersion: row.secret_version, createdAt: row.created_at, rotatedAt: row.rotated_at, deletedAt: row.deleted_at };
}

function buildFromRow(row: BuildRow): EnvironmentBuild {
  return { id: row.id, environmentVersionId: row.environment_version_id, status: row.status, fingerprint: row.fingerprint, runtimeRelease: row.runtime_release, workflowId: row.workflow_id, logKey: row.log_key, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
}

function snapshotFromRow(row: SnapshotRow): EnvironmentSnapshot {
  return { id: row.id, environmentVersionId: row.environment_version_id, buildId: row.build_id, fingerprint: row.fingerprint, backupId: row.backup_id, sizeBytes: row.size_bytes, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at, invalidatedAt: row.invalidated_at };
}

async function ownedProject(db: D1Database, ownerSub: string, projectId: string) {
  const project = await db.prepare("SELECT id, artifact_repo, default_branch FROM projects WHERE id = ? AND owner_sub = ?").bind(projectId, ownerSub).first<{id:string;artifact_repo:string;default_branch:string}>();
  if (!project) fail("Project not found");
  return project;
}

async function draftRepositories(db: D1Database, projectId: string) {
  const result = await db.prepare("SELECT * FROM environment_draft_repositories WHERE project_id = ? ORDER BY position, id").bind(projectId).all<RepositoryRow>();
  return result.results.map(repositoryFromRow);
}

async function versionRepositories(db: D1Database, versionId: string) {
  const result = await db.prepare("SELECT id, name, source_type, source_url, ref, pinned_sha, checkout_path, writable, position FROM environment_repositories WHERE environment_version_id = ? ORDER BY position, id").bind(versionId).all<RepositoryRow>();
  return result.results.map(repositoryFromRow);
}

export async function getEnvironmentDraft(db: D1Database, ownerSub: string, projectId: string): Promise<EnvironmentDraft> {
  const project = await ownedProject(db, ownerSub, projectId);
  let row = await db.prepare("SELECT * FROM environment_drafts WHERE project_id = ? AND owner_sub = ?").bind(projectId, ownerSub).first<DraftRow>();
  if (!row) {
    const timestamp = now();
    const manifest = validateEnvironmentManifest({});
    const repository = normalizeRepository({ name: "primary", sourceType: "artifacts", checkoutPath: "repository", ref: project.default_branch, writable: true }, 0);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO environment_drafts (project_id, owner_sub, manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(projectId, ownerSub, canonicalJson(manifest), timestamp, timestamp),
      db.prepare("INSERT OR IGNORE INTO environment_draft_repositories (id, project_id, name, source_type, source_url, ref, pinned_sha, checkout_path, writable, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(repository.id, projectId, repository.name, repository.sourceType, repository.sourceUrl, repository.ref, repository.pinnedSha, repository.checkoutPath, 1, 0, timestamp, timestamp),
    ]);
    row = await db.prepare("SELECT * FROM environment_drafts WHERE project_id = ? AND owner_sub = ?").bind(projectId, ownerSub).first<DraftRow>();
  }
  if (!row) fail("Environment draft could not be created");
  return { projectId, revision: row.revision, manifest: validateEnvironmentManifest(JSON.parse(row.manifest_json)), repositories: await draftRepositories(db, projectId), createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function updateEnvironmentDraft(db: D1Database, ownerSub: string, projectId: string, input: { expectedRevision: number; manifest: unknown; repositories: EnvironmentRepositoryInput[] }): Promise<EnvironmentDraft> {
  await ownedProject(db, ownerSub, projectId);
  const current = await getEnvironmentDraft(db, ownerSub, projectId);
  if (current.revision !== input.expectedRevision) fail("Environment draft changed; reload before saving");
  const manifest = validateEnvironmentManifest(input.manifest);
  const repositories = validateEnvironmentRepositories(input.repositories);
  const timestamp = now();
  const statements = [
    db.prepare("DELETE FROM environment_draft_repositories WHERE project_id = ? AND EXISTS (SELECT 1 FROM environment_drafts WHERE project_id = ? AND owner_sub = ? AND revision = ?)").bind(projectId, projectId, ownerSub, input.expectedRevision),
    ...repositories.map((repository) => db.prepare("INSERT INTO environment_draft_repositories (id, project_id, name, source_type, source_url, ref, pinned_sha, checkout_path, writable, position, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM environment_drafts WHERE project_id = ? AND owner_sub = ? AND revision = ?)").bind(repository.id, projectId, repository.name, repository.sourceType, repository.sourceUrl, repository.ref, repository.pinnedSha, repository.checkoutPath, repository.writable ? 1 : 0, repository.position, timestamp, timestamp, projectId, ownerSub, input.expectedRevision)),
    db.prepare("UPDATE environment_drafts SET manifest_json = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND owner_sub = ? AND revision = ?").bind(canonicalJson(manifest), timestamp, projectId, ownerSub, input.expectedRevision),
  ];
  const results = await db.batch(statements);
  if (!results.at(-1)?.meta.changes) fail("Environment draft changed; reload before saving");
  return getEnvironmentDraft(db, ownerSub, projectId);
}

export async function addEnvironmentDraftRepository(db: D1Database, ownerSub: string, projectId: string, expectedRevision: number, repository: EnvironmentRepositoryInput) {
  const draft = await getEnvironmentDraft(db, ownerSub, projectId);
  if (draft.revision !== expectedRevision) fail("Environment draft changed; reload before saving");
  return updateEnvironmentDraft(db, ownerSub, projectId, { expectedRevision, manifest: draft.manifest, repositories: [...draft.repositories, repository] });
}

export async function updateEnvironmentDraftRepository(db: D1Database, ownerSub: string, projectId: string, repositoryId: string, expectedRevision: number, repository: EnvironmentRepositoryInput) {
  const draft = await getEnvironmentDraft(db, ownerSub, projectId);
  const position = draft.repositories.findIndex((item) => item.id === repositoryId);
  if (position < 0) fail("Environment draft repository not found");
  const repositories: EnvironmentRepositoryInput[] = draft.repositories.map((item, index) => index === position ? { ...repository, id: repositoryId } : item);
  return updateEnvironmentDraft(db, ownerSub, projectId, { expectedRevision, manifest: draft.manifest, repositories });
}

export async function removeEnvironmentDraftRepository(db: D1Database, ownerSub: string, projectId: string, repositoryId: string, expectedRevision: number) {
  const draft = await getEnvironmentDraft(db, ownerSub, projectId);
  if (!draft.repositories.some((item) => item.id === repositoryId)) fail("Environment draft repository not found");
  return updateEnvironmentDraft(db, ownerSub, projectId, { expectedRevision, manifest: draft.manifest, repositories: draft.repositories.filter((item) => item.id !== repositoryId) });
}

async function ownedSecrets(db: D1Database, ownerSub: string, projectId: string, secretIds: string[]) {
  if (new Set(secretIds).size !== secretIds.length) fail("Duplicate environment secret binding");
  if (!secretIds.length) return [];
  const placeholders = secretIds.map(() => "?").join(",");
  const result = await db.prepare(`SELECT * FROM environment_secret_metadata WHERE project_id = ? AND owner_sub = ? AND deleted_at IS NULL AND id IN (${placeholders})`).bind(projectId, ownerSub, ...secretIds).all<SecretRow>();
  if (result.results.length !== secretIds.length) fail("One or more environment secrets were not found");
  return result.results;
}

export async function publishEnvironmentVersion(db: D1Database, ownerSub: string, projectId: string, input: { expectedDraftRevision: number; secretIds?: string[]; activate?: boolean }): Promise<EnvironmentVersion> {
  await ownedProject(db, ownerSub, projectId);
  const draft = await getEnvironmentDraft(db, ownerSub, projectId);
  if (draft.revision !== input.expectedDraftRevision) fail("Environment draft changed; reload before publishing");
  const repositories = validateEnvironmentRepositories(draft.repositories.map((repository) => ({ ...repository })), true);
  const secrets = await ownedSecrets(db, ownerSub, projectId, input.secretIds || []);
  const frozen = { manifest: draft.manifest, repositories: repositories.map(({ id: _id, position: _position, ...repository }) => repository), secrets: secrets.map((secret) => ({ id: secret.id, version: secret.secret_version })).sort((a, b) => a.id.localeCompare(b.id)) };
  const manifestJson = canonicalJson(draft.manifest);
  const manifestHash = await sha256(canonicalJson(frozen));
  const existing = await db.prepare("SELECT v.*, CASE WHEN a.environment_version_id = v.id THEN 1 ELSE 0 END active FROM environment_versions v LEFT JOIN project_active_environments a ON a.project_id = v.project_id WHERE v.project_id = ? AND v.manifest_hash = ?").bind(projectId, manifestHash).first<VersionRow>();
  if (existing) {
    if (input.activate) await activateEnvironmentVersion(db, ownerSub, projectId, existing.id);
    return getEnvironmentVersion(db, ownerSub, existing.id);
  }
  const next = await db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM environment_versions WHERE project_id = ?").bind(projectId).first<{version:number}>();
  const versionId = id("envver");
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO environment_versions (id, project_id, owner_sub, version, manifest_json, manifest_hash, source_draft_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(versionId, projectId, ownerSub, next?.version || 1, manifestJson, manifestHash, draft.revision, timestamp),
    ...repositories.map((repository) => db.prepare("INSERT INTO environment_repositories (id, environment_version_id, source_repository_id, name, source_type, source_url, ref, pinned_sha, checkout_path, writable, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id("verrepo"), versionId, repository.id, repository.name, repository.sourceType, repository.sourceUrl, repository.ref, repository.pinnedSha, repository.checkoutPath, repository.writable ? 1 : 0, repository.position)),
    ...secrets.map((secret) => db.prepare("INSERT INTO environment_version_secrets (environment_version_id, secret_id, secret_name, secret_scope, secret_ref, secret_version) VALUES (?, ?, ?, ?, ?, ?)").bind(versionId, secret.id, secret.name, secret.scope, secret.secret_ref, secret.secret_version)),
  ];
  await db.batch(statements);
  if (input.activate) await activateEnvironmentVersion(db, ownerSub, projectId, versionId);
  return getEnvironmentVersion(db, ownerSub, versionId);
}

export async function listEnvironmentVersions(db: D1Database, ownerSub: string, projectId: string) {
  await ownedProject(db, ownerSub, projectId);
  const result = await db.prepare("SELECT v.*, CASE WHEN a.environment_version_id = v.id THEN 1 ELSE 0 END active FROM environment_versions v LEFT JOIN project_active_environments a ON a.project_id = v.project_id WHERE v.project_id = ? AND v.owner_sub = ? ORDER BY v.version DESC").bind(projectId, ownerSub).all<VersionRow>();
  return Promise.all(result.results.map((row) => hydrateVersion(db, row)));
}

async function hydrateVersion(db: D1Database, row: VersionRow): Promise<EnvironmentVersion> {
  const secrets = await db.prepare("SELECT secret_id FROM environment_version_secrets WHERE environment_version_id = ? ORDER BY secret_id").bind(row.id).all<{secret_id:string}>();
  return { id: row.id, projectId: row.project_id, version: row.version, manifest: validateEnvironmentManifest(JSON.parse(row.manifest_json)), manifestHash: row.manifest_hash, sourceDraftRevision: row.source_draft_revision, repositories: await versionRepositories(db, row.id), secretIds: secrets.results.map((item) => item.secret_id), createdAt: row.created_at, active: Boolean(row.active) };
}

export async function getEnvironmentVersion(db: D1Database, ownerSub: string, versionId: string) {
  const row = await db.prepare("SELECT v.*, CASE WHEN a.environment_version_id = v.id THEN 1 ELSE 0 END active FROM environment_versions v LEFT JOIN project_active_environments a ON a.project_id = v.project_id WHERE v.id = ? AND v.owner_sub = ?").bind(versionId, ownerSub).first<VersionRow>();
  if (!row) fail("Environment version not found");
  return hydrateVersion(db, row);
}

export async function activateEnvironmentVersion(db: D1Database, ownerSub: string, projectId: string, versionId: string) {
  const version = await db.prepare("SELECT id FROM environment_versions WHERE id = ? AND project_id = ? AND owner_sub = ?").bind(versionId, projectId, ownerSub).first<{id:string}>();
  if (!version) fail("Environment version not found");
  const timestamp = now();
  await db.prepare("INSERT INTO project_active_environments (project_id, environment_version_id, activated_by, activated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET environment_version_id = excluded.environment_version_id, activated_by = excluded.activated_by, activated_at = excluded.activated_at").bind(projectId, versionId, ownerSub, timestamp).run();
  return getEnvironmentVersion(db, ownerSub, versionId);
}

function validateSecretInput(input: { name: string; scope: "setup" | "runtime"; secretRef: string }) {
  const name = input.name?.trim();
  if (!NAME_PATTERN.test(name)) fail("Secret name is invalid");
  if (!(["setup", "runtime"] as const).includes(input.scope)) fail("Secret scope is invalid");
  const secretRef = input.secretRef?.trim();
  if (!secretRef || secretRef.length > 300 || !/^(?:secrets-store:|r2:\/\/|[a-zA-Z0-9._-]+\/)[a-zA-Z0-9/._:-]+$/.test(secretRef)) fail("Secret reference is invalid; pass a Secrets Store or encrypted object reference, never a plaintext value");
  return { name, scope: input.scope, secretRef };
}

export async function createEnvironmentSecretMetadata(db: D1Database, ownerSub: string, projectId: string, input: { name: string; scope: "setup" | "runtime"; secretRef: string }) {
  await ownedProject(db, ownerSub, projectId);
  const value = validateSecretInput(input);
  const secretId = id("envsec");
  const timestamp = now();
  await db.prepare("INSERT INTO environment_secret_metadata (id, project_id, owner_sub, name, scope, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(secretId, projectId, ownerSub, value.name, value.scope, value.secretRef, timestamp).run();
  return getEnvironmentSecretMetadata(db, ownerSub, secretId);
}

export async function listEnvironmentSecretMetadata(db: D1Database, ownerSub: string, projectId: string, includeDeleted = false) {
  await ownedProject(db, ownerSub, projectId);
  const result = await db.prepare(`SELECT * FROM environment_secret_metadata WHERE project_id = ? AND owner_sub = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY scope, name`).bind(projectId, ownerSub).all<SecretRow>();
  return result.results.map(secretFromRow);
}

export async function getEnvironmentSecretMetadata(db: D1Database, ownerSub: string, secretId: string) {
  const row = await db.prepare("SELECT * FROM environment_secret_metadata WHERE id = ? AND owner_sub = ?").bind(secretId, ownerSub).first<SecretRow>();
  if (!row) fail("Environment secret not found");
  return secretFromRow(row);
}

export async function rotateEnvironmentSecretMetadata(db: D1Database, ownerSub: string, secretId: string, secretRef: string) {
  const secret = await getEnvironmentSecretMetadata(db, ownerSub, secretId);
  if (secret.deletedAt) fail("Deleted environment secrets cannot be rotated");
  const value = validateSecretInput({ name: secret.name, scope: secret.scope, secretRef });
  await db.prepare("UPDATE environment_secret_metadata SET secret_ref = ?, secret_version = secret_version + 1, rotated_at = ? WHERE id = ? AND owner_sub = ? AND deleted_at IS NULL").bind(value.secretRef, now(), secretId, ownerSub).run();
  return getEnvironmentSecretMetadata(db, ownerSub, secretId);
}

export async function deleteEnvironmentSecretMetadata(db: D1Database, ownerSub: string, secretId: string) {
  const secret = await getEnvironmentSecretMetadata(db, ownerSub, secretId);
  if (secret.deletedAt) return secret;
  await db.prepare("UPDATE environment_secret_metadata SET deleted_at = ? WHERE id = ? AND owner_sub = ?").bind(now(), secretId, ownerSub).run();
  return getEnvironmentSecretMetadata(db, ownerSub, secretId);
}

export async function createEnvironmentBuild(db: D1Database, ownerSub: string, versionId: string, input: { fingerprint: string; runtimeRelease: string; workflowId?: string | null }) {
  await getEnvironmentVersion(db, ownerSub, versionId);
  if (!/^[a-f0-9]{64}$/i.test(input.fingerprint)) fail("Build fingerprint must be a SHA-256 digest");
  if (!NAME_PATTERN.test(input.runtimeRelease)) fail("Build runtime release is invalid");
  const buildId = id("envbuild");
  const timestamp = now();
  await db.prepare("INSERT INTO environment_builds (id, environment_version_id, owner_sub, status, fingerprint, runtime_release, workflow_id, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)").bind(buildId, versionId, ownerSub, input.fingerprint.toLowerCase(), input.runtimeRelease, input.workflowId || null, timestamp, timestamp).run();
  return getEnvironmentBuild(db, ownerSub, buildId);
}

export async function computeEnvironmentBuildFingerprint(db: D1Database, ownerSub: string, versionId: string, runtimeRelease: string) {
  const version = await getEnvironmentVersion(db, ownerSub, versionId);
  if (!NAME_PATTERN.test(runtimeRelease)) fail("Build runtime release is invalid");
  const secrets = await db.prepare("SELECT secret_id id, secret_version FROM environment_version_secrets WHERE environment_version_id = ? ORDER BY secret_id").bind(versionId).all<{id:string;secret_version:number}>();
  return sha256(canonicalJson({ runtimeRelease, manifestHash: version.manifestHash, repositories: version.repositories.map((repository) => ({ id: repository.id, pinnedSha: repository.pinnedSha, ref: repository.ref })), secrets: secrets.results.map((secret) => ({ id: secret.id, version: secret.secret_version })) }));
}

export async function listEnvironmentBuilds(db: D1Database, ownerSub: string, versionId: string) {
  await getEnvironmentVersion(db, ownerSub, versionId);
  const result = await db.prepare("SELECT * FROM environment_builds WHERE environment_version_id = ? AND owner_sub = ? ORDER BY created_at DESC").bind(versionId, ownerSub).all<BuildRow>();
  return result.results.map(buildFromRow);
}

export async function getEnvironmentBuild(db: D1Database, ownerSub: string, buildId: string) {
  const row = await db.prepare("SELECT * FROM environment_builds WHERE id = ? AND owner_sub = ?").bind(buildId, ownerSub).first<BuildRow>();
  if (!row) fail("Environment build not found");
  return buildFromRow(row);
}

export async function updateEnvironmentBuild(db: D1Database, ownerSub: string, buildId: string, input: { status: EnvironmentBuild["status"]; logKey?: string | null; error?: string | null }) {
  const build = await getEnvironmentBuild(db, ownerSub, buildId);
  const transitions: Record<EnvironmentBuild["status"], EnvironmentBuild["status"][]> = { queued: ["building", "cancelled", "failed"], building: ["ready", "failed", "cancelled"], ready: [], failed: [], cancelled: [] };
  if (!transitions[build.status].includes(input.status)) fail(`Cannot change environment build from ${build.status} to ${input.status}`);
  const timestamp = now();
  const completed = ["ready", "failed", "cancelled"].includes(input.status) ? timestamp : null;
  await db.prepare("UPDATE environment_builds SET status = ?, log_key = COALESCE(?, log_key), error = ?, updated_at = ?, completed_at = ? WHERE id = ? AND owner_sub = ? AND status = ?").bind(input.status, input.logKey ?? null, input.error ?? null, timestamp, completed, buildId, ownerSub, build.status).run();
  return getEnvironmentBuild(db, ownerSub, buildId);
}

export async function recordEnvironmentSnapshot(db: D1Database, ownerSub: string, buildId: string, input: { backupId: string; sizeBytes?: number; metadata?: Record<string, unknown> }) {
  const build = await getEnvironmentBuild(db, ownerSub, buildId);
  if (build.status !== "ready") fail("Only ready environment builds can create snapshots");
  if (!input.backupId?.trim() || input.backupId.length > 300) fail("Snapshot backup ID is invalid");
  if (!Number.isSafeInteger(input.sizeBytes || 0) || (input.sizeBytes || 0) < 0) fail("Snapshot size is invalid");
  const metadata = input.metadata || {};
  const metadataJson = canonicalJson(metadata);
  if (metadataJson.length > 16_384) fail("Snapshot metadata is too large");
  const snapshotId = id("envsnap");
  await db.prepare("INSERT INTO environment_snapshots (id, environment_version_id, build_id, owner_sub, fingerprint, backup_id, size_bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(snapshotId, build.environmentVersionId, build.id, ownerSub, build.fingerprint, input.backupId.trim(), input.sizeBytes || 0, metadataJson, now()).run();
  return getEnvironmentSnapshot(db, ownerSub, snapshotId);
}

export async function getEnvironmentSnapshot(db: D1Database, ownerSub: string, snapshotId: string) {
  const row = await db.prepare("SELECT * FROM environment_snapshots WHERE id = ? AND owner_sub = ?").bind(snapshotId, ownerSub).first<SnapshotRow>();
  if (!row) fail("Environment snapshot not found");
  return snapshotFromRow(row);
}

export async function invalidateEnvironmentSnapshot(db: D1Database, ownerSub: string, snapshotId: string) {
  await getEnvironmentSnapshot(db, ownerSub, snapshotId);
  await db.prepare("UPDATE environment_snapshots SET invalidated_at = COALESCE(invalidated_at, ?) WHERE id = ? AND owner_sub = ?").bind(now(), snapshotId, ownerSub).run();
  return getEnvironmentSnapshot(db, ownerSub, snapshotId);
}

export async function findEnvironmentSnapshot(db: D1Database, ownerSub: string, versionId: string, fingerprint: string) {
  await getEnvironmentVersion(db, ownerSub, versionId);
  const row = await db.prepare("SELECT * FROM environment_snapshots WHERE environment_version_id = ? AND owner_sub = ? AND fingerprint = ? AND invalidated_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(versionId, ownerSub, fingerprint.toLowerCase()).first<SnapshotRow>();
  return row ? snapshotFromRow(row) : null;
}

export async function listEnvironmentSnapshots(db: D1Database, ownerSub: string, versionId: string, includeInvalidated = false) {
  await getEnvironmentVersion(db, ownerSub, versionId);
  const result = await db.prepare(`SELECT * FROM environment_snapshots WHERE environment_version_id = ? AND owner_sub = ? ${includeInvalidated ? "" : "AND invalidated_at IS NULL"} ORDER BY created_at DESC`).bind(versionId, ownerSub).all<SnapshotRow>();
  return result.results.map(snapshotFromRow);
}

export async function resolveTaskEnvironment(db: D1Database, ownerSub: string, taskId: string, input: { environmentVersionId?: string; targetRepositoryId?: string } = {}): Promise<ResolvedTaskEnvironment> {
  const task = await db.prepare("SELECT id, project_id FROM tasks WHERE id = ? AND owner_sub = ?").bind(taskId, ownerSub).first<{id:string;project_id:string}>();
  if (!task) fail("Task not found");
  const existing = await db.prepare("SELECT * FROM task_environments WHERE task_id = ?").bind(taskId).first<{task_id:string;environment_version_id:string;snapshot_id:string|null;target_repository_id:string;manifest_hash:string;resolved_at:string}>();
  if (existing) {
    if (input.environmentVersionId && input.environmentVersionId !== existing.environment_version_id) fail("Task environment is already pinned");
    if (input.targetRepositoryId && input.targetRepositoryId !== existing.target_repository_id) fail("Task target repository is already pinned");
    return hydrateTaskEnvironment(db, existing);
  }
  let versionId = input.environmentVersionId;
  if (!versionId) {
    const active = await db.prepare("SELECT environment_version_id FROM project_active_environments WHERE project_id = ?").bind(task.project_id).first<{environment_version_id:string}>();
    versionId = active?.environment_version_id;
  }
  if (!versionId) fail("Project has no active environment version");
  const version = await getEnvironmentVersion(db, ownerSub, versionId);
  if (version.projectId !== task.project_id) fail("Environment version does not belong to the task project");
  const revoked = await db.prepare("SELECT COUNT(*) count FROM environment_version_secrets binding JOIN environment_secret_metadata metadata ON metadata.id=binding.secret_id WHERE binding.environment_version_id=? AND metadata.deleted_at IS NOT NULL")
    .bind(version.id).first<{count:number}>();
  if ((revoked?.count ?? 0) > 0) fail("Environment version contains a revoked secret and cannot be pinned to a new task; publish a replacement version");
  const target = input.targetRepositoryId ? version.repositories.find((repository) => repository.id === input.targetRepositoryId) : version.repositories.find((repository) => repository.writable);
  if (!target?.writable) fail("Task target repository must be writable and belong to the environment version");
  const snapshot = await db.prepare("SELECT s.* FROM environment_snapshots s JOIN environment_builds b ON b.id = s.build_id WHERE s.environment_version_id = ? AND s.owner_sub = ? AND s.invalidated_at IS NULL AND b.status = 'ready' ORDER BY s.created_at DESC LIMIT 1").bind(version.id, ownerSub).first<SnapshotRow>();
  const resolvedAt = now();
  await db.prepare("INSERT INTO task_environments (task_id, environment_version_id, snapshot_id, target_repository_id, manifest_hash, resolved_at) VALUES (?, ?, ?, ?, ?, ?)").bind(taskId, version.id, snapshot?.id || null, target.id, version.manifestHash, resolvedAt).run();
  const secrets = await versionSecrets(db, version.id);
  return { taskId, environmentVersionId: version.id, snapshotId: snapshot?.id || null, targetRepositoryId: target.id, manifestHash: version.manifestHash, resolvedAt, manifest: version.manifest, repositories: version.repositories, secrets };
}

async function versionSecrets(db: D1Database, versionId: string) {
  const rows = await db.prepare("SELECT binding.secret_id id, version.project_id, binding.secret_name name, binding.secret_scope scope, binding.secret_ref, binding.secret_version, version.created_at, NULL rotated_at, NULL deleted_at FROM environment_version_secrets binding JOIN environment_versions version ON version.id=binding.environment_version_id WHERE binding.environment_version_id=? ORDER BY binding.secret_scope, binding.secret_name")
    .bind(versionId).all<SecretRow>();
  return rows.results.map(secretFromRow);
}

async function hydrateTaskEnvironment(db: D1Database, row: {task_id:string;environment_version_id:string;snapshot_id:string|null;target_repository_id:string;manifest_hash:string;resolved_at:string}): Promise<ResolvedTaskEnvironment> {
  const versionRow = await db.prepare("SELECT manifest_json FROM environment_versions WHERE id = ?").bind(row.environment_version_id).first<{manifest_json:string}>();
  if (!versionRow) fail("Pinned task environment no longer exists");
  return { taskId: row.task_id, environmentVersionId: row.environment_version_id, snapshotId: row.snapshot_id, targetRepositoryId: row.target_repository_id, manifestHash: row.manifest_hash, resolvedAt: row.resolved_at, manifest: validateEnvironmentManifest(JSON.parse(versionRow.manifest_json)), repositories: await versionRepositories(db, row.environment_version_id), secrets: await versionSecrets(db, row.environment_version_id) };
}
