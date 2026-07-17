#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40}$/;

export const DEFAULT_UPSTREAM_REPOSITORY = "https://github.com/xai-org/grok-build.git";

// Grok Build vendors these paths from xai-org/grok-build. Product-specific files
// such as README.md, SOURCE_REV, .gitignore, web/, and .github/ are intentionally
// outside this manifest.
export const IMPORTED_SOURCE_PATHS = [
  ".cargo",
  "CONTRIBUTING.md",
  "Cargo.lock",
  "Cargo.toml",
  "LICENSE",
  "SECURITY.md",
  "THIRD-PARTY-NOTICES",
  "bin",
  "clippy.toml",
  "crates",
  "prod",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "third_party",
];

export function compareSourceRevision(local, upstream) {
  const localRevision = local.trim();
  const upstreamRevision = upstream.trim();
  if (!SHA.test(localRevision)) throw new Error("Local SOURCE_REV must contain one lowercase 40-character commit SHA");
  if (!SHA.test(upstreamRevision)) throw new Error("Upstream SOURCE_REV did not contain a lowercase 40-character commit SHA");
  return { current:localRevision === upstreamRevision, localRevision, upstreamRevision };
}

async function addPathToManifest(root, path, manifest) {
  const absolutePath = resolve(root, path);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`Imported source path is missing: ${path}`);
    }
    throw error;
  }

  if (stats.isDirectory()) {
    const entries = await readdir(absolutePath, { withFileTypes:true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await addPathToManifest(root, join(path, entry.name), manifest);
    }
    return;
  }

  const normalizedPath = path.split(sep).join("/");
  const executable = stats.mode & 0o111 ? "x" : "-";
  const content = stats.isSymbolicLink()
    ? `symlink:${await readlink(absolutePath)}`
    : await readFile(absolutePath);
  const contentHash = createHash("sha256").update(content).digest("hex");
  manifest.set(normalizedPath, `${executable}:${contentHash}`);
}

export async function createSourceManifest(root, sourcePaths = IMPORTED_SOURCE_PATHS) {
  const manifest = new Map();
  for (const path of sourcePaths) await addPathToManifest(root, path, manifest);
  return manifest;
}

function digestManifest(manifest) {
  const hash = createHash("sha256");
  for (const [path, fingerprint] of [...manifest].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update("\0").update(fingerprint).update("\n");
  }
  return hash.digest("hex");
}

export async function compareSourceTrees(localRoot, upstreamRoot, sourcePaths = IMPORTED_SOURCE_PATHS) {
  const [localManifest, upstreamManifest] = await Promise.all([
    createSourceManifest(localRoot, sourcePaths),
    createSourceManifest(upstreamRoot, sourcePaths),
  ]);
  const missing = [...upstreamManifest.keys()].filter((path) => !localManifest.has(path)).sort();
  const added = [...localManifest.keys()].filter((path) => !upstreamManifest.has(path)).sort();
  const changed = [...upstreamManifest.keys()]
    .filter((path) => localManifest.has(path) && localManifest.get(path) !== upstreamManifest.get(path))
    .sort();
  return {
    current:missing.length === 0 && added.length === 0 && changed.length === 0,
    localTreeHash:digestManifest(localManifest),
    upstreamTreeHash:digestManifest(upstreamManifest),
    missing,
    added,
    changed,
  };
}

async function cloneUpstream(repository) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "grok-build-upstream-"));
  const checkout = join(temporaryRoot, "checkout");
  await execFile("git", ["clone", "--depth=1", "--quiet", repository, checkout], { timeout:120_000 });
  return { checkout, cleanup:() => rm(temporaryRoot, { recursive:true, force:true }) };
}

export async function checkUpstreamSource(options = {}) {
  const root = resolve(options.root || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const configuredUpstreamDir = options.upstreamDir || process.env.GROK_BUILD_UPSTREAM_DIR;
  const cloned = configuredUpstreamDir
    ? null
    : await cloneUpstream(options.upstreamRepository || process.env.GROK_BUILD_UPSTREAM_REPOSITORY || DEFAULT_UPSTREAM_REPOSITORY);
  const upstreamRoot = resolve(configuredUpstreamDir || cloned.checkout);
  try {
    const [localRevisionText, upstreamRevisionText, tree] = await Promise.all([
      readFile(resolve(root, "SOURCE_REV"), "utf8"),
      readFile(resolve(upstreamRoot, "SOURCE_REV"), "utf8"),
      compareSourceTrees(root, upstreamRoot, options.sourcePaths),
    ]);
    const revision = compareSourceRevision(localRevisionText, upstreamRevisionText);
    return {
      ...tree,
      current:revision.current && tree.current,
      revisionCurrent:revision.current,
      treeCurrent:tree.current,
      localRevision:revision.localRevision,
      upstreamRevision:revision.upstreamRevision,
      upstreamRoot,
    };
  } finally {
    await cloned?.cleanup();
  }
}

function parseUpstreamDir(argv) {
  const index = argv.indexOf("--upstream-dir");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--upstream-dir requires a path");
  return value;
}

function summarizePaths(label, paths) {
  if (paths.length === 0) return null;
  const visible = paths.slice(0, 20).join(", ");
  const remainder = paths.length > 20 ? ` (+${paths.length - 20} more)` : "";
  return `${label}: ${visible}${remainder}`;
}

async function main() {
  const json = process.argv.includes("--json");
  const result = await checkUpstreamSource({ upstreamDir:parseUpstreamDir(process.argv.slice(2)) });
  if (json) console.log(JSON.stringify(result));
  else if (result.current) console.log(`Grok Build imported source is current (${result.localRevision}; tree ${result.localTreeHash}).`);
  else {
    console.error(`Grok Build source drift detected. Revision: local ${result.localRevision}, upstream ${result.upstreamRevision}. Tree: local ${result.localTreeHash}, upstream ${result.upstreamTreeHash}.`);
    for (const detail of [
      summarizePaths("Missing locally", result.missing),
      summarizePaths("Added locally", result.added),
      summarizePaths("Changed", result.changed),
    ].filter(Boolean)) console.error(detail);
  }
  if (!result.current) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
