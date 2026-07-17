import type { Sandbox } from "@cloudflare/sandbox";
import Ajv from "ajv";

export type AcpRunInput = {
  cwd:string; grokHome:string; model:string; prompt:string; promptBlocks?:Array<Record<string, unknown>>;
  permissionArgs:string[]; sessionId?:string|null; reviewOnly:boolean; env:Record<string,string>;
  maxTurns?:number|null; outputSchema?:Record<string,unknown>|null; runtimeIdentity?:string; deniedPaths:string[];
};

export type AcpRunResult = { ok:boolean; sessionId:string|null; stopReason:string; events:Array<Record<string,unknown>>; finalText:string; structuredOutput?:unknown; structuredOutputError?:string; stderr:string };

function shell(value:string) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function sha256(value:string) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

async function readText(sandbox:Sandbox,path:string) {
  const value=await sandbox.readFile(path);
  return value.success ? value.content.trim() : null;
}

async function ensureAcpRuntime(sandbox:Sandbox, taskId:string, input:AcpRunInput) {
  const processId = `acp-${taskId}`;
  const configPath=`/run/grok-build-${taskId}.acp.json`;
  const tokenPath=`/run/grok-build-${taskId}.acp.token`;
  const identityPath=`/run/grok-build-${taskId}.acp.identity`;
  const runtimeConfig={
    cwd:input.cwd,grokHome:input.grokHome,model:input.model,permissionArgs:input.permissionArgs,env:input.env,
    maxTurns:input.maxTurns ?? null,outputSchema:input.outputSchema ?? null,runtimeIdentity:input.runtimeIdentity ?? null,sandboxProfile:"strict",deniedPaths:input.deniedPaths,
  };
  const identity=await sha256(JSON.stringify(runtimeConfig));
  let process = await sandbox.getProcess(processId);
  const running=process && ["running", "starting"].includes(await process.getStatus());
  const existingIdentity=await readText(sandbox,identityPath);
  if (process && running && existingIdentity !== identity) {
    await process.kill();
    process=null;
  }
  let token=await readText(sandbox,tokenPath);
  if (!process || !["running", "starting"].includes(await process.getStatus())) {
    token=`${crypto.randomUUID().replaceAll("-","")}${crypto.randomUUID().replaceAll("-","")}`;
    await sandbox.writeFile(configPath,JSON.stringify(runtimeConfig));
    await sandbox.writeFile(tokenPath,`${token}\n`);
    await sandbox.writeFile(identityPath,`${identity}\n`);
    const ownership=await sandbox.exec(`chown -R 10001:10001 ${shell(input.cwd)} ${shell(input.grokHome)}`);
    if (!ownership.success) throw new Error(`Failed to assign the task workspace: ${ownership.stderr.slice(-800)}`);
    for (const deniedPath of input.deniedPaths.filter((path)=>path===input.cwd || path.startsWith(`${input.cwd}/`))) {
      const sealed=await sandbox.exec(`if test -e ${shell(deniedPath)}; then chown -R root:root ${shell(deniedPath)} && chmod -R a-rwx ${shell(deniedPath)}; fi`);
      if (!sealed.success) throw new Error(`Failed to seal a denied task path: ${sealed.stderr.slice(-800)}`);
    }
    const secured=await sandbox.exec(`chmod 600 ${shell(configPath)} ${shell(tokenPath)} ${shell(identityPath)} && chown root:root ${shell(configPath)} ${shell(tokenPath)} ${shell(identityPath)}`);
    if (!secured.success) throw new Error(`Failed to secure ACP runtime: ${secured.stderr.slice(-800)}`);
    process = await sandbox.startProcess("node /usr/local/lib/grok-build/acp-bridge.mjs", {
      processId, autoCleanup:false, env:{GROK_BUILD_ACP_CONFIG:configPath,GROK_BUILD_ACP_TOKEN_FILE:tokenPath},
    });
  }
  if (!token) throw new Error("ACP runtime token is unavailable");
  await process.waitForPort(2419, { timeout:30_000 });
  return {process,token};
}

function validateStructuredOutput(schema:Record<string,unknown>, value:unknown) {
  const ajv=new Ajv({allErrors:true,strict:true});
  const validate=ajv.compile(schema);
  if (!validate(value)) throw new Error(`Agent output does not match the required JSON Schema: ${ajv.errorsText(validate.errors)}`);
}

export async function runAcpPrompt(sandbox:Sandbox, taskId:string, input:AcpRunInput):Promise<AcpRunResult> {
  const {token}=await ensureAcpRuntime(sandbox, taskId, input);
  const response = await sandbox.containerFetch(new Request("http://grok-build.local/run", {
    method:"POST", headers:{ "content-type":"application/json",authorization:`Bearer ${token}` },
    body:JSON.stringify({prompt:input.prompt,promptBlocks:input.promptBlocks,sessionId:input.sessionId,reviewOnly:input.reviewOnly}),
  }), 2419);
  const value = await response.json() as AcpRunResult & {error?:string};
  if (!response.ok) throw new Error(`ACP runtime failed: ${value.error || value.stderr || response.status}`);
  if (input.outputSchema) {
    if (value.structuredOutputError) throw new Error(`Agent structured output failed: ${value.structuredOutputError}`);
    if (value.structuredOutput === undefined) throw new Error("Agent did not return canonical structured output");
    validateStructuredOutput(input.outputSchema,value.structuredOutput);
  }
  return value;
}
