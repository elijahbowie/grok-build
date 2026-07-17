import type { ControlEnv, Identity, Project } from "./types";
import { id, now } from "./db";

const encoder = new TextEncoder();

function base64url(value: Uint8Array) { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function fromBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
async function digest(value: string) { return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }

export async function createPairingCode(env: ControlEnv, identity: Identity, name = "Local companion") {
  const random = crypto.getRandomValues(new Uint8Array(9));
  const code = base64url(random).toUpperCase();
  const pairId = id("cmp"); const timestamp = now(); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.CONTROL_DB.prepare("INSERT INTO companion_pairs (id, owner_sub, name, public_key, pairing_code_hash, pairing_expires_at, created_at) VALUES (?, ?, ?, '', ?, ?, ?)")
    .bind(pairId, identity.sub, name.slice(0, 80), await digest(code), expiresAt, timestamp).run();
  return { id: pairId, code, expiresAt };
}

export async function pairCompanion(request: Request, env: ControlEnv) {
  const input = await request.json<{code?:string;publicKey?:string;name?:string}>();
  if (!input.code || !input.publicKey || input.publicKey.length > 2000) return Response.json({ error: "Invalid pairing request" }, { status: 400 });
  const pair = await env.CONTROL_DB.prepare("SELECT id, owner_sub FROM companion_pairs WHERE pairing_code_hash = ? AND pairing_expires_at > ? AND public_key = ''").bind(await digest(input.code.toUpperCase()), now()).first<{id:string;owner_sub:string}>();
  if (!pair) return Response.json({ error: "Pairing code is invalid or expired" }, { status: 401 });
  try { await crypto.subtle.importKey("spki", fromBase64(input.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); }
  catch { return Response.json({ error: "Invalid companion public key" }, { status: 400 }); }
  await env.CONTROL_DB.prepare("UPDATE companion_pairs SET public_key = ?, name = COALESCE(?, name), pairing_code_hash = NULL, pairing_expires_at = NULL, last_seen_at = ? WHERE id = ?")
    .bind(input.publicKey, input.name?.slice(0, 80) || null, now(), pair.id).run();
  return Response.json({ id: pair.id, paired: true });
}

export async function companionIdentity(request: Request, env: ControlEnv, body = "") {
  const companionId = request.headers.get("x-grok-companion-id") || "";
  const timestamp = request.headers.get("x-grok-companion-timestamp") || "";
  const signature = request.headers.get("x-grok-companion-signature") || "";
  if (!companionId || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000 || !signature) return null;
  const pair = await env.CONTROL_DB.prepare("SELECT id, owner_sub, public_key, revoked_at FROM companion_pairs WHERE id = ?").bind(companionId).first<{id:string;owner_sub:string;public_key:string;revoked_at:string|null}>();
  if (!pair || pair.revoked_at || !pair.public_key) return null;
  const url = new URL(request.url); const bodyHash = await digest(body); const message = `${request.method}\n${url.pathname}${url.search}\n${timestamp}\n${bodyHash}`;
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64(pair.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(signature), encoder.encode(message))) return null;
  } catch { return null; }
  await env.CONTROL_DB.prepare("UPDATE companion_pairs SET last_seen_at = ? WHERE id = ?").bind(now(), pair.id).run();
  return pair;
}

export async function companionArtifactToken(request: Request, env: ControlEnv, ownerSub: string) {
  const match = new URL(request.url).pathname.match(/^\/v1\/companion\/projects\/([^/]+)\/artifact-token$/);
  const project = match ? await env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_sub = ?").bind(match[1], ownerSub).first<Project>() : null;
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const repo = await env.ARTIFACTS.get(project.artifact_repo); const token = await repo.createToken("write", 900);
  return Response.json({ projectId: project.id, remote: repo.remote, token: token.plaintext, tokenId: token.id, expiresAt: token.expiresAt, branch: project.default_branch });
}

export async function revokeCompanionToken(env: ControlEnv, ownerSub: string, body: string) {
  const input = JSON.parse(body) as {projectId?:string;tokenId?:string};
  const project = input.projectId ? await env.CONTROL_DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_sub = ?").bind(input.projectId, ownerSub).first<Project>() : null;
  if (!project || !input.tokenId) return Response.json({ error: "Invalid token revocation" }, { status: 400 });
  return Response.json({ revoked: await (await env.ARTIFACTS.get(project.artifact_repo)).revokeToken(input.tokenId) });
}
