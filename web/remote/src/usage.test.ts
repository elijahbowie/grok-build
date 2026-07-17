import { describe, expect, it } from "vitest";
import { containerCostMicros, extractAgentUsage } from "./usage";

describe("usage accounting", () => {
  it("extracts the latest cumulative model usage without double counting streaming events", () => {
    const usage = extractAgentUsage([
      JSON.stringify({ usage:{ input_tokens:100, output_tokens:20, total_tokens:120 }, total_cost_usd:0.01 }),
      JSON.stringify({ usage:{ input_tokens:140, output_tokens:50, total_tokens:190 }, total_cost_usd:0.025 }),
    ].join("\n"));
    expect(usage).toEqual({ inputTokens:140, outputTokens:50, totalTokens:190, costMicros:25_000 });
  });

  it("converts active time to configured hourly micros", () => {
    expect(containerCostMicros(1_800_000, 2_000_000)).toBe(1_000_000);
  });
});
