#!/usr/bin/env node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const stateDir = join(homedir(), ".grok-build");
const statePath = join(stateDir, "companion.json");
const [command, ...args] = process.argv.slice(2);

function usage() {
  console.error("Usage:\n  node scripts/companion.mjs pair <origin> <code> [name]\n  node scripts/companion.mjs push <project-id> [repository-path]");
  process.exit(2);
}

function readState() {
  try { return JSON.parse(readFileSync(statePath, "utf8")); }
  catch { throw new Error("This Mac is not paired. Create a code in cloud Settings, then run the pair command."); }
}

function digest(value) {
  return createHash("sha256").update(value).digest("base64url");
}

async function signedRequest(state, path, method = "GET", body = "") {
  const timestamp = String(Date.now());
  const message = `${method}\n${path}\n${timestamp}\n${digest(body)}`;
  const signature = sign("sha256", Buffer.from(message), { key: state.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return fetch(`${state.origin}${path}`, { method, headers: { "content-type": "application/json", "x-grok-companion-id": state.id, "x-grok-companion-timestamp": timestamp, "x-grok-companion-signature": signature }, body: method === "GET" ? undefined : body });
}

if (command === "pair") {
  const [originValue, code, name = "This Mac"] = args;
  if (!originValue || !code) usage();
  const origin = new URL(originValue).origin;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const publicDer = Buffer.from(publicKey.replace(/-----(?:BEGIN|END) PUBLIC KEY-----|\s/g, ""), "base64").toString("base64");
  const response = await fetch(`${origin}/v1/companion/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, publicKey: publicDer }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Pairing failed (${response.status})`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify({ id: result.id, origin, privateKey }, null, 2), { mode: 0o600 });
  console.log(`Paired ${name} with ${origin}.`);
} else if (command === "push") {
  const [projectId, repositoryPath = process.cwd()] = args;
  if (!projectId) usage();
  const state = readState(); const cwd = resolve(repositoryPath);
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "ignore" });
  const tokenPath = `/v1/companion/projects/${encodeURIComponent(projectId)}/artifact-token`;
  const response = await signedRequest(state, tokenPath, "POST", "");
  const token = await response.json();
  if (!response.ok) throw new Error(token.error || `Artifact token failed (${response.status})`);
  try {
    execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${token.token}`, "push", token.remote, `HEAD:${token.branch}`], { cwd, stdio: "inherit" });
    console.log(`Pushed ${cwd} to project ${projectId}.`);
  } finally {
    const body = JSON.stringify({ projectId, tokenId: token.tokenId });
    await signedRequest(state, "/v1/companion/artifact-token", "DELETE", body).catch(() => undefined);
  }
} else usage();
