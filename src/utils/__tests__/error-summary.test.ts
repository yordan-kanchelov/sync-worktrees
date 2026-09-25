import { GitError } from "simple-git";
import { describe, expect, it } from "vitest";

import { WorktreeError } from "../../errors";
import { summarizeExpectedError } from "../error-summary";

describe("summarizeExpectedError", () => {
  it("reduces git's stderr to the first fatal line, which names the cause", () => {
    const error = new GitError(
      undefined,
      [
        "fatal: '/repos/app' does not appear to be a git repository",
        "fatal: Could not read from remote repository.",
        "",
        "Please make sure you have the correct access rights",
        "and the repository exists.",
      ].join("\n"),
    );

    expect(summarizeExpectedError(error)).toBe("fatal: '/repos/app' does not appear to be a git repository");
  });

  it("falls back to git's first line when nothing is marked fatal or error", () => {
    expect(summarizeExpectedError(new GitError(undefined, "\n  something odd happened\nmore\n"))).toBe(
      "something odd happened",
    );
  });

  it("keeps this tool's own typed error messages whole", () => {
    expect(summarizeExpectedError(new WorktreeError("worktree is locked\nunlock it first", "LOCKED"))).toBe(
      "worktree is locked\nunlock it first",
    );
  });

  it("returns null for anything else, which keeps its stack", () => {
    expect(summarizeExpectedError(new TypeError("x is undefined"))).toBeNull();
    expect(summarizeExpectedError("a string")).toBeNull();
    expect(summarizeExpectedError(undefined)).toBeNull();
  });
});
