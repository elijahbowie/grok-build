// @vitest-environment node
import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applicationAuthConfigured, applicationIdentity, browserOriginAllowed, clearSession, createSession, passwordIdentity } from "./auth";
import type { ControlEnv } from "./types";

const salt = Buffer.from("0123456789abcdef");
const iterations = 100_000;
const password = "correct horse battery staple";
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const env = {
  AUTH_EMAIL:"director@eicimpact.org",
  AUTH_SUB:"4167902e-3eea-572e-9eb3-7246f8f340e3",
  AUTH_PASSWORD_HASH:`pbkdf2-sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`,
  AUTH_SESSION_SECRET:"session-secret-with-at-least-32-bytes-long",
  PUBLIC_ORIGIN:"https://grok.forgeagent.app",
} as ControlEnv;

describe("application authentication", () => {
  it("accepts only the configured email and password", async () => {
    expect(applicationAuthConfigured(env)).toBe(true);
    await expect(passwordIdentity("DIRECTOR@eicimpact.org", password, env)).resolves.toEqual({ sub:env.AUTH_SUB, email:env.AUTH_EMAIL });
    await expect(passwordIdentity("other@example.com", password, env)).resolves.toBeNull();
    await expect(passwordIdentity(env.AUTH_EMAIL, "wrong", env)).resolves.toBeNull();
  });

  it("rejects malformed or weak password configuration", () => {
    expect(applicationAuthConfigured({ ...env, AUTH_PASSWORD_HASH:"pbkdf2-sha256$10$bad$bad" })).toBe(false);
    expect(applicationAuthConfigured({ ...env, AUTH_SESSION_SECRET:"short" })).toBe(false);
  });

  it("creates a secure session and rejects tampering", async () => {
    const identity = { sub:env.AUTH_SUB, email:env.AUTH_EMAIL };
    const setCookie = await createSession(identity, env);
    expect(setCookie).toContain("Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200");
    const request = new Request("https://grok.forgeagent.app/api/bootstrap", { headers:{ cookie:setCookie.split(";")[0] } });
    await expect(applicationIdentity(request, env)).resolves.toEqual(identity);
    const tampered = new Request(request.url, { headers:{ cookie:`${setCookie.split(";")[0]}x` } });
    await expect(applicationIdentity(tampered, env)).resolves.toBeNull();
    expect(clearSession()).toContain("Max-Age=0");
  });

  it("requires the canonical browser origin", () => {
    expect(browserOriginAllowed(new Request(`${env.PUBLIC_ORIGIN}/api/tasks`, { headers:{ origin:env.PUBLIC_ORIGIN } }), env)).toBe(true);
    expect(browserOriginAllowed(new Request(`${env.PUBLIC_ORIGIN}/api/tasks`, { headers:{ origin:"https://evil.example" } }), env)).toBe(false);
  });
});
