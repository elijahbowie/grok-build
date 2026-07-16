import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const config = "remote/wrangler.jsonc";

function wrangler(args, input) {
  const result = spawnSync(process.execPath, [resolve(webRoot, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", config], { cwd: webRoot, input, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Wrangler failed").trim());
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

const bucket = "grok-build-subscription-director-78b";
const bucketResult = spawnSync(process.execPath, [resolve(webRoot, "node_modules/wrangler/bin/wrangler.js"), "r2", "bucket", "create", bucket, "--config", config], { cwd: webRoot, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
if (bucketResult.status !== 0 && !`${bucketResult.stdout || ""}${bucketResult.stderr || ""}`.match(/already exists/i)) throw new Error((bucketResult.stderr || bucketResult.stdout || "Could not provision private authentication storage").trim());

const deployment = wrangler(["deploy"]);
const token = randomBytes(32).toString("base64url");
await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
wrangler(["secret", "put", "RUNNER_TOKEN"], `${token}\n`);
const url = deployment.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!url) throw new Error("Deployment succeeded, but its workers.dev URL could not be detected");

let credentialReady = false;
for (let attempt = 0; attempt < 45; attempt += 1) {
  try {
    const response = await fetch(`${url}/v1/deployment-ready`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (response.status !== 401) { credentialReady = true; break; }
  } catch {}
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
}
if (!credentialReady) throw new Error("Runner deployed, but its bearer credential did not become active within 90 seconds");

const destination = resolve(repoRoot, ".grok-web/remote.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify({ url, token }, null, 2), { mode: 0o600 });

console.log(`Hosted runner deployed: ${url}`);
console.log("Its bearer credential was saved with owner-only permissions in .grok-web/remote.json.");
console.log(`Private Grok subscription storage is bound to R2 bucket ${bucket}.`);
console.log("Manage the Grok subscription session from the app Settings page.");
