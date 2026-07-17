import { runAcpPrompt, type AcpRunResult } from "./acp-runtime";
import { resolveEnvironmentSecretValues, secretValues } from "./environment-secrets";
import { resolveTaskEnvironment } from "./environments";
import { getTaskSecurityPolicy } from "./security-policy";
import { applyJobToolContract, assertStrictSandboxFilesystemPolicy, nativePermissionConfig, permissionCliArgs } from "./runtime-security";
import { grokHome, sandboxFor } from "./sandbox-runtime";
import { prepareTaskRuntime } from "./task-runtime";
import type { ControlEnv, Task } from "./types";
import { resolveModelProfile } from "./model-profiles";

type RuntimeSandbox = ReturnType<typeof sandboxFor>;

async function digest(value:unknown) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

function toml(value:string) { return JSON.stringify(value); }
function modelConfig(profile:Awaited<ReturnType<typeof resolveModelProfile>>,alias:string) {
  const backend=profile.backend==="openai-responses" ? "responses" : profile.backend==="anthropic" ? "messages" : "chat_completions";
  const lines=[`[model.${toml(alias)}]`,`model = ${toml(profile.modelId)}`,`name = ${toml(profile.name)}`,`base_url = ${toml(profile.baseUrl!)}`,`api_backend = ${toml(backend)}`];
  if (profile.contextWindow) lines.push(`context_window = ${profile.contextWindow}`);
  if (profile.backend==="anthropic" && profile.credential) lines.push(`extra_headers = { "x-api-key" = ${toml(profile.credential)}, "anthropic-version" = "2023-06-01" }`);
  else if (profile.credential) lines.push('env_key = "GROK_BUILD_MODEL_API_KEY"');
  return `${lines.join("\n")}\n`;
}

export async function runHardenedAgent(input:{
  env:ControlEnv;sandbox:RuntimeSandbox;task:Task;projectId:string;cwd:string;prompt:string;runtimeId:string;
  reviewOnly:boolean;outputSchema?:Record<string,unknown>|null;includeRuntimeSecrets?:boolean;
}):Promise<{acp:AcpRunResult;runtimeSecrets:Record<string,string>;secrets:string[]}> {
  const policy=await getTaskSecurityPolicy(input.env.CONTROL_DB,input.task.owner_sub,input.task.id);
  if (!policy) throw new Error("Task has no pinned security policy");
  assertStrictSandboxFilesystemPolicy(policy.policy,input.cwd);
  const profile=input.task.model_profile_id ? await resolveModelProfile(input.env,input.task.owner_sub,input.projectId,input.task.model_profile_id) : null;
  const runtimeModel=profile ? `managed-${profile.id.replace(/[^A-Za-z0-9_-]/g,"-")}` : input.task.model;
  const prepared=await prepareTaskRuntime({db:input.env.CONTROL_DB,sandbox:input.sandbox,taskId:input.task.id,projectId:input.projectId,ownerSub:input.task.owner_sub,cwd:input.cwd,baseGrokHome:grokHome,model:input.task.model});
  let permissions=nativePermissionConfig(policy.policy,input.reviewOnly);
  permissions=applyJobToolContract(permissions,JSON.parse(input.task.allowed_tools_json||"[]"),JSON.parse(input.task.denied_tools_json||"[]"),input.task.web_search_mode);
  const environment=await resolveTaskEnvironment(input.env.CONTROL_DB,input.task.owner_sub,input.task.id);
  const runtimeSecrets=input.includeRuntimeSecrets===false ? {} : await resolveEnvironmentSecretValues(input.env,environment.secrets,"runtime");
  const secrets=[...secretValues(runtimeSecrets),...(profile?.credential ? [profile.credential] : [])];
  const sensitiveConfig=profile ? `${prepared.grokHome}/config.toml` : null;
  try {
    if (profile) {
      await input.sandbox.writeFile(sensitiveConfig!,modelConfig(profile,runtimeModel));
      const secured=await input.sandbox.exec(`chmod 400 ${JSON.stringify(sensitiveConfig)}`);
      if (!secured.success) throw new Error("Managed model configuration could not be secured");
    }
    const acp=await runAcpPrompt(input.sandbox,`${input.task.id}-${input.runtimeId}`,{
      cwd:input.cwd,grokHome:prepared.grokHome,model:runtimeModel,prompt:input.prompt,permissionArgs:permissionCliArgs(permissions),
      reviewOnly:input.reviewOnly,env:{...runtimeSecrets,...(profile?.credential && profile.backend!=="anthropic" ? {GROK_BUILD_MODEL_API_KEY:profile.credential} : {})},maxTurns:input.task.max_turns,outputSchema:input.outputSchema||null,
      runtimeIdentity:await digest({policyDigest:prepared.policyDigest,extensionDigests:prepared.extensionDigests,runtimeId:input.runtimeId,modelProfile:profile ? await digest(profile) : null}),
      deniedPaths:policy.policy.filesystem.deniedPaths,
    });
    return {acp,runtimeSecrets,secrets};
  } finally {
    if (sensitiveConfig) await input.sandbox.exec(`rm -f ${JSON.stringify(sensitiveConfig)}`).catch(()=>undefined);
  }
}
