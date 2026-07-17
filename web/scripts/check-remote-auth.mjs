import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const config = JSON.parse(await readFile(resolve("../.grok-web/remote.json"), "utf8"));
const response = await fetch(`${config.url}/v1/auth/status`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: "{}" });
const value = await response.json();
if (!response.ok) throw new Error(value.error || `Remote authentication check failed (${response.status})`);
console.log(JSON.stringify({ authenticated: value.authenticated, status: value.status }, null, 2));
