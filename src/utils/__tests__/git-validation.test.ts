import { describe, expect, it } from "vitest";

import { isValidGitBranchName } from "../git-validation";

describe("isValidGitBranchName", () => {
  it("accepts a simple name", () => {
    expect(isValidGitBranchName("feature/foo")).toEqual({ valid: true });
  });

  it.each([
    ["empty", "", "empty"],
    ["whitespace only", "   ", "empty"],
    ["leading dash", "-D", "start with '-'"],
    ["ends with .lock", "feature.lock", ".lock"],
    ["contains ..", "foo..bar", "'..'"],
    ["contains @{", "foo@{bar}", "'@{'"],
    ["leading dot", ".hidden", "start or end with '.'"],
    ["trailing dot", "hidden.", "start or end with '.'"],
    ["double slash", "feature//foo", "consecutive slashes"],
    ["control char", "foo\x00bar", "invalid characters"],
    ["has tilde", "feature~1", "invalid characters"],
    ["has colon", "feature:1", "invalid characters"],
    ["has question", "feature?", "invalid characters"],
  ])("rejects %s", (_label, name, fragment) => {
    const result = isValidGitBranchName(name);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(fragment);
  });
});
