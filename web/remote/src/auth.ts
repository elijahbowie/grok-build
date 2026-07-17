import { jwtVerify, SignJWT } from "jose";
import type { ControlEnv, Identity } from "./types";

const encoder = new TextEncoder();
const cookieName = "__Host-grok_session";
const issuer = "grok-build";
const audience = "grok-build-web";
const sessionSeconds = 43_200;

function decode(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parsePasswordHash(value: string) {
  const [algorithm, iterationsValue, saltValue, hashValue] = value.split("$");
  const iterations = Number(iterationsValue);
  if (algorithm !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 100_000 || !saltValue || !hashValue) return null;
  try {
    const salt = decode(saltValue); const hash = decode(hashValue);
    return salt.length >= 16 && hash.length === 32 ? { iterations, salt, hash } : null;
  } catch { return null; }
}

async function derivedPassword(password: string, iterations: number, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt, iterations }, key, 256));
}

async function sessionKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign", "verify"]);
}

function safeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (left:BufferSource, right:BufferSource)=>boolean };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(left, right);
  let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function cookie(request: Request) {
  const item = (request.headers.get("cookie") || "").split(";").map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`));
  return item?.slice(cookieName.length + 1) || "";
}

export function applicationAuthConfigured(env: ControlEnv) {
  return Boolean(env.AUTH_EMAIL && env.AUTH_SUB && parsePasswordHash(env.AUTH_PASSWORD_HASH || "") && (env.AUTH_SESSION_SECRET?.length || 0) >= 32);
}

export async function passwordIdentity(email: string, password: string, env: ControlEnv): Promise<Identity|null> {
  const normalized = email.trim().toLowerCase(); const expected = env.AUTH_EMAIL?.trim().toLowerCase() || "";
  const passwordHash = parsePasswordHash(env.AUTH_PASSWORD_HASH || "");
  if (!expected || !env.AUTH_SUB || !passwordHash || !password || normalized !== expected) return null;
  const supplied = await derivedPassword(password, passwordHash.iterations, passwordHash.salt);
  if (!safeEqual(supplied, passwordHash.hash)) return null;
  return { sub:env.AUTH_SUB, email:expected };
}

export async function createSession(identity: Identity, env: ControlEnv, now = Math.floor(Date.now() / 1000)) {
  if (!env.AUTH_SESSION_SECRET) throw new Error("Application authentication is not configured");
  const token = await new SignJWT({ email:identity.email }).setProtectedHeader({ alg:"HS256" }).setIssuer(issuer).setAudience(audience).setSubject(identity.sub).setIssuedAt(now).setExpirationTime(now + sessionSeconds).sign(await sessionKey(env.AUTH_SESSION_SECRET));
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionSeconds}`;
}

export function clearSession() {
  return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function applicationIdentity(request: Request, env: ControlEnv): Promise<Identity|null> {
  const token = cookie(request);
  if (!token || !env.AUTH_SESSION_SECRET || !env.AUTH_SUB || !env.AUTH_EMAIL) return null;
  try {
    const { payload } = await jwtVerify(token, await sessionKey(env.AUTH_SESSION_SECRET), { issuer, audience, algorithms:["HS256"] });
    if (payload.sub !== env.AUTH_SUB || payload.email !== env.AUTH_EMAIL.trim().toLowerCase()) return null;
    return { sub:payload.sub, email:payload.email };
  } catch { return null; }
}

export function browserOriginAllowed(request: Request, env: ControlEnv) {
  const origin = request.headers.get("origin");
  return Boolean(origin && env.PUBLIC_ORIGIN && origin === new URL(env.PUBLIC_ORIGIN).origin);
}
