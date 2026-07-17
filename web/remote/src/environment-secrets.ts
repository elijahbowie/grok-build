import { decryptSecret } from "./connectors";
import type { EnvironmentSecretMetadata } from "./environments";
import type { ControlEnv } from "./types";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

export async function resolveEnvironmentSecretValues(env: ControlEnv, secrets: EnvironmentSecretMetadata[], scope: "setup" | "runtime") {
  const values: Record<string, string> = {};
  for (const secret of secrets.filter((item) => item.scope === scope)) {
    if (!ENV_NAME.test(secret.name)) throw new Error(`Environment secret ${secret.name} is not a valid process variable name`);
    if (!secret.secretRef.startsWith("r2://")) throw new Error(`Environment secret ${secret.name} uses an unsupported provider; this runtime currently resolves only encrypted R2 references`);
    const key = secret.secretRef.slice("r2://".length);
    const stored = await env.CONNECTOR_SECRETS.get(key);
    if (!stored) throw new Error(`Environment secret ${secret.name} is unavailable`);
    values[secret.name] = await decryptSecret(env, await stored.text());
  }
  return values;
}

export function secretValues(values: Record<string, string>) {
  return Object.values(values);
}
