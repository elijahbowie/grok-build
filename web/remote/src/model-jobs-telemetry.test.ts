import { describe, expect, it, vi } from "vitest";
import { validateAgentJobContract } from "./agent-jobs";
import { validateModelProfileInput } from "./model-profiles";
import { buildOtlpPayloads, emitTaskTelemetry, sanitizeTelemetryAttributes } from "./telemetry";

describe("managed model profiles", () => {
  it("validates backend, context, effort and cost metadata", () => {
    expect(validateModelProfileInput({ name:"Sonnet", backend:"anthropic", modelId:"claude-sonnet-4", baseUrl:"https://api.example.com/v1", reasoningEffort:"high", contextWindow:200_000, inputCostMicrosPerMillion:3_000_000, outputCostMicrosPerMillion:15_000_000 }).backend).toBe("anthropic");
    expect(() => validateModelProfileInput({ name:"Bad", backend:"anthropic", modelId:"m", baseUrl:"http://localhost:8080" })).toThrow(/public HTTPS/);
  });
});

describe("structured agent job contracts", () => {
  it("accepts output schemas and bounded execution controls", () => {
    const value = validateAgentJobContract({ outputSchema:{ type:"object", properties:{answer:{type:"string"}}, required:["answer"] }, maxTurns:12, allowedTools:["Read", "Bash(npm test)"], deniedTools:["WebSearch"], webSearch:"off", attachmentIds:["att_1"] });
    expect(value).toMatchObject({ maxTurns:12, webSearch:"off", attachmentIds:["att_1"] });
  });

  it("rejects contradictory tool policy", () => {
    expect(() => validateAgentJobContract({ allowedTools:["Read"], deniedTools:["Read"] })).toThrow(/both allowed and denied/);
  });

  it("rejects invalid JSON Schema before admitting paid work", () => {
    expect(() => validateAgentJobContract({ outputSchema:{ type:"not-a-json-schema-type" } })).toThrow(/schema is invalid/i);
  });

  it("rejects unknown and blanket shell tool rules", () => {
    expect(() => validateAgentJobContract({ allowedTools:["NotARealTool"] })).toThrow(/unknown/);
    expect(() => validateAgentJobContract({ allowedTools:["Bash(*)"] })).toThrow(/overbroad/);
  });
});

describe("privacy-safe OTLP export", () => {
  it("drops prompt, code and unknown attributes from logs and metrics", () => {
    expect(sanitizeTelemetryAttributes({ taskId:"tsk_1", prompt:"secret", code:"private", status:"completed" })).toEqual({ taskId:"tsk_1", status:"completed" });
    const serialized = JSON.stringify(buildOtlpPayloads({ name:"task.completed", attributes:{ taskId:"tsk_1", status:"completed" }, metrics:[{name:"task.duration", value:1200, unit:"ms"}] }));
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("code");
  });

  it("cannot fail the caller when the collector is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(emitTaskTelemetry({ OTLP_ENDPOINT:"https://collector.example.com", OTLP_AUTH_TOKEN:"secret" } as never, { name:"task.failed", level:"ERROR", attributes:{ errorClass:"TimeoutError" } })).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});
