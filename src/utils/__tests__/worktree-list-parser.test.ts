import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitClient } from "../git-client";
import {
  parseWorktreeListPorcelain,
  readWorktreeListPorcelain,
  resetWorktreeListCapabilityForTests,
} from "../worktree-list-parser";

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
        lockReason: null,
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
    expect(result[0].lockReason).toBe("portable drive");
  });

  it("reports a lock with no reason as locked without one", () => {
    const output = ["worktree /repo/locked", "branch refs/heads/feat", "locked", ""].join("\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result[0].locked).toBe(true);
    expect(result[0].lockReason).toBeNull();
  });

  // git runs the reason through quote_c_style, so a reason holding a newline or
  // a quote arrives on one line, double-quoted and escaped. Keeping it exactly
  // as git printed it is what makes the value safe to put in a log line.
  it("keeps a C-quoted lock reason as git printed it", () => {
    const output = [
      "worktree /repo/locked",
      "branch refs/heads/feat",
      String.raw`locked "multi\nline \"quoted\" reason"`,
      "",
    ].join("\n");
    const result = parseWorktreeListPorcelain(output);
    expect(result[0].locked).toBe(true);
    expect(result[0].lockReason).toBe(String.raw`"multi\nline \"quoted\" reason"`);
  });
});

describe("parseWorktreeListPorcelain with NUL-terminated (-z) output", () => {
  const z = (records: string[][]): string => records.map((fields) => [...fields, ""].join("\0")).join("\0") + "\0";

  it("keeps a path containing a newline as one worktree", () => {
    const output = z([
      ["worktree /repo/main", "HEAD aaa", "branch refs/heads/main"],
      ["worktree /repo/odd\nname", "HEAD bbb", "branch refs/heads/odd"],
    ]);

    const result = parseWorktreeListPorcelain(output);

    expect(result.map((w) => [w.path, w.branch, w.head])).toEqual([
      ["/repo/main", "main", "aaa"],
      ["/repo/odd\nname", "odd", "bbb"],
    ]);
  });

  it("parses detached, prunable and locked records", () => {
    const output = z([
      ["worktree /repo/d", "HEAD ccc", "detached", "prunable gitdir file points to non-existent location"],
      ["worktree /repo/l", "HEAD ddd", "branch refs/heads/l", "locked"],
    ]);

    const [detached, locked] = parseWorktreeListPorcelain(output);

    expect(detached).toMatchObject({ detached: true, branch: null, prunable: true, locked: false });
    expect(locked).toMatchObject({ locked: true, lockReason: null, branch: "l" });
  });

  // -z prints the lock reason raw; the parser quotes it the way the newline
  // form does, so the value stays single-line and safe to log.
  it("C-quotes a raw lock reason that holds a newline, quote, backslash or control character", () => {
    const output = z([["worktree /repo/l", "branch refs/heads/l", 'locked multi\nline "quoted" \\ reason\x01']]);

    expect(parseWorktreeListPorcelain(output)[0].lockReason).toBe(String.raw`"multi\nline \"quoted\" \\ reason\001"`);
  });

  it("keeps an ordinary lock reason verbatim", () => {
    const output = z([["worktree /repo/l", "branch refs/heads/l", "locked portable drive"]]);

    expect(parseWorktreeListPorcelain(output)[0].lockReason).toBe("portable drive");
  });
});

describe("readWorktreeListPorcelain", () => {
  afterEach(() => {
    resetWorktreeListCapabilityForTests();
  });

  it("asks git for NUL-terminated output", async () => {
    const raw = vi.fn().mockResolvedValue("worktree /r\0\0");

    await expect(readWorktreeListPorcelain({ raw } as never)).resolves.toBe("worktree /r\0\0");
    expect(raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"]);
  });

  it("falls back to the newline form, for good, on a git without -z", async () => {
    const raw = vi.fn(async (args: string[]) => {
      if (args.includes("-z")) throw new Error("error: unknown switch `z'\nusage: git worktree list [<options>]");
      return "worktree /r\n";
    });

    await expect(readWorktreeListPorcelain({ raw } as never)).resolves.toBe("worktree /r\n");
    await expect(readWorktreeListPorcelain({ raw } as never)).resolves.toBe("worktree /r\n");
    expect(raw.mock.calls.map(([args]) => args)).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "list", "--porcelain"],
      ["worktree", "list", "--porcelain"],
    ]);
  });

  it("rethrows any other failure", async () => {
    const raw = vi.fn().mockRejectedValue(new Error("fatal: not a git repository"));

    await expect(readWorktreeListPorcelain({ raw } as never)).rejects.toThrow("not a git repository");
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("lists a real worktree whose path contains a newline", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-wt-list-"));
    try {
      const repo = path.join(dir, "repo");
      const oddPath = path.join(dir, "odd\nname");
      await fs.mkdir(repo);
      const git = createGitClient(repo, {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      });
      await git.init();
      await git.raw(["commit", "--allow-empty", "-m", "init"]);
      await git.raw(["worktree", "add", "-b", "odd", oddPath]);

      const worktrees = parseWorktreeListPorcelain(await readWorktreeListPorcelain(git));

      expect(worktrees.map((w) => w.path)).toEqual([await fs.realpath(repo), await fs.realpath(oddPath)]);
      expect(worktrees[1].branch).toBe("odd");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
