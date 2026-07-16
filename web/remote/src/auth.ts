import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ControlEnv, Identity } from "./types";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function issuerFor(teamDomain: string) {
  const domain = teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}`;
}

function accessConfig(env: ControlEnv) {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const issuer = issuerFor(env.ACCESS_TEAM_DOMAIN);
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return { issuer, jwks };
}

export async function accessIdentity(request: Request, env: ControlEnv): Promise<Identity | null> {
  const config = accessConfig(env);
  if (!config) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, config.jwks, { issuer: config.issuer, audience: env.ACCESS_AUD });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!payload.sub || !email || email !== env.ACCESS_EMAIL.toLowerCase()) return null;
    return { sub: payload.sub, email, name: typeof payload.name === "string" ? payload.name : undefined };
  } catch {
    return null;
  }
}

export function accessConfigured(env: ControlEnv) {
  return Boolean(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN);
}
