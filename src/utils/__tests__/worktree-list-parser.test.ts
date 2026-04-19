import { describe, expect, it } from "vitest";

import { parseWorktreeListPorcelain } from "../worktree-list-parser";

describe("parseWorktreeListPorcelain", () => {
  it("parses a single worktree entry", () => {
    const output = ["worktree /repo/main", "HEAD abc1234567890deadbeefcafef00d", "branch refs/heads/main", ""].join(
      "\n",
    );

    const result = parseWorktreeListPorcelain(output);
    expect(result).toEqual([
      {
        path: "/repo/main",
        branch: "main",
        head: "abc1234567890deadbeefcafef00d",
        detached: false,
        prunable: false,
        locked: false,
      },
    ]);
  });

  it("parses multiple worktrees", () => {
    const output = [
      "worktree /repo/main",
      "branch refs/heads/main",
      "",
      "worktree /repo/worktrees/feature-x",
      "branch refs/heads/feature/x",
      "",
    ].join("\n");

    const result = parseWorktreeListPorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[1].branch).toBe("feature/x");
  });

  it("marks detached worktrees", () => {
    const output = ["worktree /repo/detached", "HEAD deadbeef", "detached", ""].join("\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result[0].detached).toBe(true);
    expect(result[0].branch).toBeNull();
    expect(result[0].head).toBe("deadbeef");
  });

  it("marks prunable worktrees", () => {
    const output = ["worktree /repo/stale", "branch refs/heads/gone", "prunable", ""].join("\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result[0].prunable).toBe(true);
  });

  it("handles trailing entry without empty line", () => {
    const output = ["worktree /repo/a", "branch refs/heads/a", "", "worktree /repo/b", "branch refs/heads/b"].join(
      "\n",
    );
    const result = parseWorktreeListPorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[1].path).toBe("/repo/b");
  });

  it("returns empty array for empty input", () => {
    expect(parseWorktreeListPorcelain("")).toEqual([]);
  });

  it("detects prunable with reason suffix", () => {
    const output = [
      "worktree /repo/stale",
      "branch refs/heads/gone",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result[0].prunable).toBe(true);
  });

  it("detects locked with reason suffix", () => {
    const output = ["worktree /repo/locked", "branch refs/heads/feat", "locked portable drive", ""].join("\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result[0].locked).toBe(true);
  });

  it("handles CRLF line endings", () => {
    const output = ["worktree /repo/main", "HEAD abc123", "branch refs/heads/main", "detached", ""].join("\r\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/repo/main");
    expect(result[0].head).toBe("abc123");
    expect(result[0].branch).toBe("main");
    expect(result[0].detached).toBe(true);
  });
});
