import { describe, expect, it } from "vitest";

import { filterBranchesByName, matchesPattern } from "../branch-filter";

describe("branch-filter", () => {
  describe("matchesPattern", () => {
    it("should match exact names", () => {
      expect(matchesPattern("main", "main")).toBe(true);
      expect(matchesPattern("main", "develop")).toBe(false);
    });

    it("should match wildcard at end", () => {
      expect(matchesPattern("feature/login", "feature/*")).toBe(true);
      expect(matchesPattern("feature/sub/deep", "feature/*")).toBe(true);
      expect(matchesPattern("bugfix/login", "feature/*")).toBe(false);
    });

    it("should match wildcard at start", () => {
      expect(matchesPattern("my-hotfix", "*-hotfix")).toBe(true);
      expect(matchesPattern("urgent-hotfix", "*-hotfix")).toBe(true);
      expect(matchesPattern("my-bugfix", "*-hotfix")).toBe(false);
    });

    it("should match wildcard in middle", () => {
      expect(matchesPattern("feat-login-fix", "feat*fix")).toBe(true);
      expect(matchesPattern("featfix", "feat*fix")).toBe(true);
      expect(matchesPattern("feat-login", "feat*fix")).toBe(false);
    });

    it("should match multiple wildcards", () => {
      expect(matchesPattern("feature/login", "*feature*")).toBe(true);
      expect(matchesPattern("my-feature-branch", "*feature*")).toBe(true);
      expect(matchesPattern("bugfix", "*feature*")).toBe(false);
    });

    it("should escape special regex characters in patterns", () => {
      expect(matchesPattern("my.branch", "my.branch")).toBe(true);
      expect(matchesPattern("myXbranch", "my.branch")).toBe(false);
      expect(matchesPattern("release+1", "release+1")).toBe(true);
    });

    it("should handle standalone wildcard", () => {
      expect(matchesPattern("anything", "*")).toBe(true);
      expect(matchesPattern("", "*")).toBe(true);
    });
  });

  describe("filterBranchesByName", () => {
    const branches = ["main", "develop", "feature/login", "feature/signup", "bugfix/typo", "release-1.0", "wip-test"];

    it("should return all branches when no include or exclude is specified", () => {
      expect(filterBranchesByName(branches)).toEqual(branches);
      expect(filterBranchesByName(branches, undefined, undefined)).toEqual(branches);
    });

    it("should return all branches when include and exclude are empty arrays", () => {
      expect(filterBranchesByName(branches, [], [])).toEqual(branches);
    });

    it("should filter by include patterns only", () => {
      const result = filterBranchesByName(branches, ["feature/*", "main"]);
      expect(result).toEqual(["main", "feature/login", "feature/signup"]);
    });

    it("should filter by exclude patterns only", () => {
      const result = filterBranchesByName(branches, undefined, ["wip-*", "bugfix/*"]);
      expect(result).toEqual(["main", "develop", "feature/login", "feature/signup", "release-1.0"]);
    });

    it("should apply include first, then exclude", () => {
      const result = filterBranchesByName(branches, ["feature/*", "bugfix/*"], ["feature/signup"]);
      expect(result).toEqual(["feature/login", "bugfix/typo"]);
    });

    it("should handle exact match patterns", () => {
      const result = filterBranchesByName(branches, ["main", "develop"]);
      expect(result).toEqual(["main", "develop"]);
    });

    it("should return empty array when nothing matches include", () => {
      const result = filterBranchesByName(branches, ["nonexistent/*"]);
      expect(result).toEqual([]);
    });

    it("should return empty array when everything is excluded", () => {
      const result = filterBranchesByName(branches, undefined, ["*"]);
      expect(result).toEqual([]);
    });

    it("should handle branches with special regex characters", () => {
      const specialBranches = ["release+1.0", "fix(auth)", "v2.0.0"];
      const result = filterBranchesByName(specialBranches, ["release*", "v*"]);
      expect(result).toEqual(["release+1.0", "v2.0.0"]);
    });
  });
});
