import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  validateEnvironmentManifest,
  validateEnvironmentRepositories,
} from "./remote/src/environments";

describe("versioned environment validation", () => {
  it("canonicalizes manifests deterministically", () => {
    const manifest = validateEnvironmentManifest({
      validation: ["npm test"],
      setup: ["npm ci"],
      runtimeRelease: "standard-3",
      runtime: "managed",
    });
    expect(canonicalJson(manifest)).toBe('{"runtime":"managed","runtimeRelease":"standard-3","setup":["npm ci"],"validation":["npm test"]}');
  });

  it("rejects unknown manifest fields instead of silently dropping them", () => {
    expect(() => validateEnvironmentManifest({ runtime: "managed", dockerfile: "FROM node" })).toThrow("Unknown environment manifest field");
  });

  it("requires exactly one writable repository before publication", () => {
    const repositories = [
      { name: "primary", sourceType: "artifacts" as const, checkoutPath: "primary", writable: true },
      { name: "docs", sourceType: "github" as const, sourceUrl: "https://github.com/example/docs", checkoutPath: "docs", pinnedSha: "a".repeat(40) },
    ];
    expect(validateEnvironmentRepositories(repositories, true)).toHaveLength(2);
    expect(() => validateEnvironmentRepositories(repositories.map((repository) => ({ ...repository, writable: false })), true)).toThrow("exactly one writable");
  });

  it("requires every read-only context repository to use an exact commit", () => {
    expect(() => validateEnvironmentRepositories([
      { name: "primary", sourceType: "artifacts", checkoutPath: "primary", writable: true },
      { name: "docs", sourceType: "github", sourceUrl: "https://github.com/example/docs", checkoutPath: "docs" },
    ], true)).toThrow("pinned to an exact commit SHA");
  });

  it("rejects unsafe repository locations and credentials in clone URLs", () => {
    expect(() => validateEnvironmentRepositories([{ name: "bad", sourceType: "artifacts", checkoutPath: "../bad" }])).toThrow("invalid checkoutPath");
    expect(() => validateEnvironmentRepositories([{ name: "bad", sourceType: "github", sourceUrl: "https://token@github.com/example/repo", checkoutPath: "repo" }])).toThrow("public github.com HTTPS URL");
  });

  it("caps an environment at eight repositories", () => {
    const repositories = Array.from({ length: 9 }, (_, index) => ({ name: `repo-${index}`, sourceType: "artifacts" as const, checkoutPath: `repo-${index}` }));
    expect(() => validateEnvironmentRepositories(repositories)).toThrow("at most 8 repositories");
  });
});
