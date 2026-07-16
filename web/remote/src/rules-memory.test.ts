// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  discoverRepositoryRules,
  normalizeRepositoryPath,
  normalizeRuleGlob,
  previewMemoriesForContext,
  resolvePromptContext,
  ruleAppliesToPath,
  validateMemoryInput,
  type CustomizationRule,
  type TransparentMemory,
} from "./rules-memory";

const baseRule: CustomizationRule = {
  id: "rule_user", ownerSub: "owner", projectId: null, scope: "user", name: "User conventions",
  mode: "always", pathGlob: "**/*.ts", enabled: true, revisionId: "rrev_1", version: 1,
  content: "Prefer explicit names.", reason: "User preference", createdBySub: "owner",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const memory: TransparentMemory = {
  id: "mem_1", ownerSub: "owner", projectId: "project_1", scope: "project", title: "Test command",
  content: "Run npm test.", reason: "Observed in a successful task", sourceType: "task-observation",
  sourceRef: "task_1:event_8", confidence: 0.9, status: "active", createdBySub: "owner",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null,
};

describe("customization rule matching", () => {
  it("normalizes safe relative patterns and matches globstar paths", () => {
    expect(normalizeRepositoryPath("./src\\app.ts")).toBe("src/app.ts");
    expect(normalizeRuleGlob("./src/**/*.ts")).toBe("src/**/*.ts");
    expect(ruleAppliesToPath("**/*.ts", "app.ts")).toBe(true);
    expect(ruleAppliesToPath("src/**/*.ts", "src/features/app.ts")).toBe(true);
    expect(ruleAppliesToPath("src/**/*.ts", "test/app.ts")).toBe(false);
    expect(() => normalizeRepositoryPath("../secret")).toThrow(/normalized relative/);
    expect(() => normalizeRuleGlob("../../*")) .toThrow(/safe relative/);
  });

  it("discovers bounded AGENTS and .grok rules with source provenance", () => {
    const discovery = discoverRepositoryRules([
      { path: "AGENTS.md", content: "Root instructions" },
      { path: "packages/api/AGENTS.md", content: "API instructions" },
      { path: ".grok/rules/typescript.md", content: "---\nmode: agent-requested\nglobs: **/*.ts, **/*.tsx\ndescription: TypeScript only\n---\nUse strict TypeScript." },
      { path: ".grok/rules/ignored.txt", content: "not a rule" },
      { path: "../AGENTS.md", content: "unsafe" },
    ]);
    expect(discovery.rules).toHaveLength(4);
    expect(discovery.rules.find((rule) => rule.sourcePath === "packages/api/AGENTS.md")?.pathGlob).toBe("packages/api/**/*");
    expect(discovery.rules.filter((rule) => rule.sourcePath === ".grok/rules/typescript.md").map((rule) => rule.mode)).toEqual(["agent-requested", "agent-requested"]);
    expect(discovery.rejected).toEqual([{ path: "../AGENTS.md", reason: "Repository path must be a normalized relative path" }]);
  });
});

describe("transparent prompt context", () => {
  it("applies user, project, and repository precedence and explicit modes", () => {
    const projectRule: CustomizationRule = { ...baseRule, id: "rule_project", projectId: "project_1", scope: "project", name: "Project", mode: "manual", content: "Use project architecture." };
    const repositoryRules = discoverRepositoryRules([{ path: "src/AGENTS.md", content: "Repository-specific instruction." }]).rules;
    const result = resolvePromptContext({
      rules: [projectRule, baseRule], repositoryRules, repositoryPath: "src/app.ts", manualRuleIds: [projectRule.id],
      privacyMode: false,
    });
    expect(result.provenance.map((item) => [item.kind, item.precedence])).toEqual([
      ["rule", 100], ["rule", 200], ["repository-rule", 301],
    ]);
    expect(result.content.indexOf("User conventions")).toBeLessThan(result.content.indexOf("Project"));
    expect(result.content.indexOf("Project")).toBeLessThan(result.content.indexOf("AGENTS.md"));
  });

  it("requires memory visibility before use and privacy mode blocks all memories", () => {
    expect(previewMemoriesForContext([memory], false)).toEqual([expect.objectContaining({ id: "mem_1", sourceRef: "task_1:event_8", reason: memory.reason })]);
    expect(resolvePromptContext({ rules: [], memories: [memory], repositoryPath: "src/app.ts", privacyMode: false }).omitted).toContainEqual({ kind: "memory", id: "mem_1", reason: "not-visible-before-use" });
    const visible = resolvePromptContext({ rules: [], memories: [memory], repositoryPath: "src/app.ts", privacyMode: false, visibleMemoryIds: [memory.id] });
    expect(visible.provenance).toEqual([expect.objectContaining({ kind: "memory", source: "task-observation:task_1:event_8", confidence: 0.9 })]);
    const privateContext = resolvePromptContext({ rules: [], memories: [memory], repositoryPath: "src/app.ts", privacyMode: true, visibleMemoryIds: [memory.id] });
    expect(privateContext.content).toBe("");
    expect(privateContext.omitted).toContainEqual({ kind: "memory", id: "mem_1", reason: "privacy-mode" });
  });

  it("never exceeds context bounds and reports omissions rather than truncating instructions", () => {
    const longRules = Array.from({ length: 5 }, (_, index): CustomizationRule => ({ ...baseRule, id: `rule_${index}`, name: `Rule ${index}`, content: "x".repeat(600) }));
    const result = resolvePromptContext({ rules: longRules, repositoryPath: "src/app.ts", privacyMode: false, maxCharacters: 1_000, maxItems: 2 });
    expect(result.usedCharacters).toBeLessThanOrEqual(1_000);
    expect(result.provenance.length).toBeLessThanOrEqual(2);
    expect(result.omitted.some((item) => item.reason === "character-limit" || item.reason === "item-limit")).toBe(true);
  });

  it("validates memory scope, provenance, and confidence", () => {
    expect(validateMemoryInput({ scope: "project", projectId: "project_1", title: "Choice", content: "Use D1.", reason: "User selected it", sourceType: "user-stated", sourceRef: "task_1:message_2", confidence: 1 })).toMatchObject({ scope: "project", projectId: "project_1", confidence: 1 });
    expect(() => validateMemoryInput({ scope: "user", projectId: "project_1", title: "Choice", content: "Use D1.", reason: "reason", sourceType: "user-stated", sourceRef: "message", confidence: 1 })).toThrow(/cannot have/);
    expect(() => validateMemoryInput({ scope: "user", title: "Choice", content: "Use D1.", reason: "reason", sourceType: "guess", sourceRef: "message", confidence: 2 })).toThrow(/source type/);
  });
});
