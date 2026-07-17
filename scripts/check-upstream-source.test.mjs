import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkUpstreamSource, compareSourceRevision, compareSourceTrees } from "./check-upstream-source.mjs";

const FIRST = "2ec0f0c8488842da03a71eeee3c61154957ca919";
const SECOND = "8adf9013a0929e5c7f1d4e849492d2387837a28d";

test("reports an exact source revision match", () => {
  assert.deepEqual(compareSourceRevision(`${FIRST}\n`, FIRST), { current:true, localRevision:FIRST, upstreamRevision:FIRST });
});

test("reports source drift without modifying either revision", () => {
  assert.deepEqual(compareSourceRevision(FIRST, SECOND), { current:false, localRevision:FIRST, upstreamRevision:SECOND });
});

test("rejects malformed revision files", () => {
  assert.throws(() => compareSourceRevision("main", FIRST), /Local SOURCE_REV/);
  assert.throws(() => compareSourceRevision(FIRST, "not-found"), /Upstream SOURCE_REV/);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-drift-test-"));
  const local = join(root, "local");
  const upstream = join(root, "upstream");
  await Promise.all([mkdir(join(local, "crates"), { recursive:true }), mkdir(join(upstream, "crates"), { recursive:true })]);
  await Promise.all([
    writeFile(join(local, "Cargo.toml"), "[workspace]\n"),
    writeFile(join(upstream, "Cargo.toml"), "[workspace]\n"),
    writeFile(join(local, "crates", "agent.rs"), "fn main() {}\n"),
    writeFile(join(upstream, "crates", "agent.rs"), "fn main() {}\n"),
    writeFile(join(local, "SOURCE_REV"), `${FIRST}\n`),
    writeFile(join(upstream, "SOURCE_REV"), `${FIRST}\n`),
  ]);
  return { root, local, upstream, sourcePaths:["Cargo.toml", "crates"] };
}

test("compares deterministic manifests for all imported source files", async (context) => {
  const paths = await fixture();
  context.after(() => rm(paths.root, { recursive:true, force:true }));
  const result = await compareSourceTrees(paths.local, paths.upstream, paths.sourcePaths);
  assert.equal(result.current, true);
  assert.equal(result.localTreeHash, result.upstreamTreeHash);
  assert.deepEqual(result, { ...result, missing:[], added:[], changed:[] });
});

test("reports changed, missing, and locally added source files", async (context) => {
  const paths = await fixture();
  context.after(() => rm(paths.root, { recursive:true, force:true }));
  await Promise.all([
    writeFile(join(paths.local, "Cargo.toml"), "[workspace]\nmembers = []\n"),
    writeFile(join(paths.local, "crates", "local.rs"), "local\n"),
    writeFile(join(paths.upstream, "crates", "upstream.rs"), "upstream\n"),
  ]);
  const result = await compareSourceTrees(paths.local, paths.upstream, paths.sourcePaths);
  assert.equal(result.current, false);
  assert.deepEqual(result.changed, ["Cargo.toml"]);
  assert.deepEqual(result.added, ["crates/local.rs"]);
  assert.deepEqual(result.missing, ["crates/upstream.rs"]);
});

test("full check requires both the revision and imported tree to match", async (context) => {
  const paths = await fixture();
  context.after(() => rm(paths.root, { recursive:true, force:true }));
  let result = await checkUpstreamSource({ root:paths.local, upstreamDir:paths.upstream, sourcePaths:paths.sourcePaths });
  assert.equal(result.current, true);
  assert.equal(result.revisionCurrent, true);
  assert.equal(result.treeCurrent, true);

  await writeFile(join(paths.upstream, "SOURCE_REV"), `${SECOND}\n`);
  result = await checkUpstreamSource({ root:paths.local, upstreamDir:paths.upstream, sourcePaths:paths.sourcePaths });
  assert.equal(result.current, false);
  assert.equal(result.revisionCurrent, false);
  assert.equal(result.treeCurrent, true);
});
