import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { ControlEnv } from "./types";

export const grokHome = "/home/grok";

export function shell(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function sandboxFor(env: ControlEnv, id: string) {
  return getSandbox(env.Sandbox, `grok-${id}`, { normalizeId: true, sleepAfter: "30s" });
}

async function hasSavedSubscription(sandbox: Sandbox) {
  return (await sandbox.exec(`test -s ${shell(`${grokHome}/auth.json`)}`)).success;
}

export async function loadSubscription(env: ControlEnv, sandbox: Sandbox) {
  await sandbox.exec(`mkdir -p ${shell(grokHome)} && chmod 700 ${shell(grokHome)}`);
  if (await hasSavedSubscription(sandbox)) return true;
  const stored = await env.GROK_HOME_STORE.get("profile/auth.json");
  if (!stored) return false;
  await sandbox.writeFile(`${grokHome}/auth.json`, await stored.text());
  await sandbox.exec(`chmod 600 ${shell(`${grokHome}/auth.json`)}`);
  return true;
}

export async function persistSubscription(env: ControlEnv, sandbox: Sandbox) {
  if (!await hasSavedSubscription(sandbox)) return false;
  const auth = await sandbox.readFile(`${grokHome}/auth.json`);
  if (!auth.success) return false;
  await env.GROK_HOME_STORE.put("profile/auth.json", auth.content, { httpMetadata: { contentType: "application/json" } });
  return true;
}

export async function ensureDesktop(sandbox: Sandbox, taskId: string) {
  const processId = `desktop-${taskId}`;
  let process = await sandbox.getProcess(processId);
  if (!process || !["running", "starting"].includes(await process.getStatus())) {
    process = await sandbox.startProcess("start-grok-desktop", { processId, autoCleanup: false, env: { HOME: "/home/sandbox", DISPLAY: ":1" } });
  }
  await Promise.all([process.waitForPort(6901, { timeout: 90_000 }), process.waitForPort(8931, { timeout: 90_000 })]);
  return process;
}
