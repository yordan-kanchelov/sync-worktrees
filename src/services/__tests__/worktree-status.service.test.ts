import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeNotCleanError } from "../../errors";
import { setEnvVar } from "../../__tests__/test-utils";
import { GIT_UNSAFE_ALLOWANCES } from "../../utils/git-env";
import { RefScanScope, WorktreeStatusService, parseRefScan } from "../worktree-status.service";

import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

// The `for-each-ref` ref scan's output: each local branch with the full ref it
// tracks ("" for none), then each remote-tracking ref as "<remote>/<branch>".
function refScanOutput(upstreams: Record<string, string>, remoteBranches: string[]): string {
  return [
    ...Object.entries(upstreams).map(([branch, upstream]) => `refs/heads/${branch}\0${upstream}\0`),
    ...remoteBranches.map((remoteBranch) => `refs/remotes/${remoteBranch}\0\0`),
    "",
  ].join("\n");
}

// `count` stashes made on main, the branch the default mocks check out.
function stashesOnMain(count: number): any {
  return {
    total: count,
    all: Array.from({ length: count }, (_, index) => ({
      hash: `${index}`.padStart(40, "a"),
      parents: "",
      subject: `WIP on main: abc123 stash ${index}`,
    })),
  };
}

describe("WorktreeStatusService", () => {
  let service: WorktreeStatusService;
  let mockGit: Mocked<SimpleGit>;
  // What simple-git parses off the `## <branch>...<upstream> [ahead N, behind
  // M]` header of `git status -b`, merged into whatever a test's status mock
  // returns: the snapshot takes the checked-out branch from here.
  let header: { current: string | null; detached: boolean; tracking: string | null; ahead: number; behind: number };
  // The repository-wide ref scan, kept apart from `raw` so the per-worktree
  // subcommand assertions below see only per-worktree commands.
  let mockForEachRef: Mock<(args: string[]) => Promise<string>>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorktreeStatusService();

    mockGit = {
      status: vi.fn<any>().mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      }),
      branch: vi.fn<any>().mockResolvedValue({ current: "main", detached: false }),
      raw: vi.fn<any>().mockResolvedValue("0\n"),
      stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
      env: vi.fn<any>().mockReturnThis(),
    } as any;

    header = { current: "main", detached: false, tracking: "origin/main", ahead: 0, behind: 0 };
    mockForEachRef = vi.fn(async () => refScanOutput({ main: "refs/remotes/origin/main" }, ["origin/main"]));

    (simpleGit as unknown as Mock).mockReturnValue({
      ...mockGit,
      status: async (...args: any[]) => ({ ...header, ...(await (mockGit.status as any)(...args)) }),
      raw: (args: string[]) => (args[0] === "for-each-ref" ? mockForEachRef(args) : (mockGit.raw as any)(args)),
    });
  });

  // The revision every `rev-list --count <rev> --not --remotes` probe was
  // spawned with. Git resolves a bare name through refs/tags/<name> before
  // refs/heads/<name>, so the probe must never name the branch that way.
  const unpushedProbeRevisions = (): string[] =>
    (mockGit.raw as Mock).mock.calls
      .map((call: any[]) => (Array.isArray(call[0]) ? (call[0] as string[]) : (call as string[])))
      .filter((args: string[]) => args[0] === "rev-list" && args.includes("--remotes"))
      .map((args: string[]) => args[2]);

  // Every `git.raw` subcommand the service spawned, in call order.
  const gitSubcommands = (): string[] =>
    (mockGit.raw as Mock).mock.calls
      .map((call: any[]) => (Array.isArray(call[0]) ? (call[0] as string[]) : (call as string[])))
      .map((args: string[]) => args[0]);

  describe("checkWorktreeStatus", () => {
    it("should return true for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(true);
      expect(simpleGit).toHaveBeenCalledWith(
        "/test/worktree",
        expect.objectContaining({ unsafe: GIT_UNSAFE_ALLOWANCES }),
      );
    });

    // This gate only decides whether to fast-forward, which never touches a
    // submodule's working tree. Forcing --ignore-submodules=none here would
    // override a repo's own `submodule.<name>.ignore` — the standard way to keep
    // vendored build output from dirtying the superproject — and silently stop
    // that branch from ever updating again. Removal gating is where the
    // override belongs, and getFullWorktreeStatus keeps it.
    it("honours the repository's own submodule ignore settings", async () => {
      await service.checkWorktreeStatus("/test/worktree");

      expect(mockGit.status).toHaveBeenCalledWith();
    });

    it.each([
      { field: "modified", value: ["file.ts"] },
      { field: "deleted", value: ["old-file.ts"] },
      { field: "renamed", value: [{ from: "old.ts", to: "new.ts" }] },
      { field: "created", value: ["new-file.ts"] },
      { field: "conflicted", value: ["conflicted.ts"] },
    ])("should return false for worktree with $field files", async ({ field, value }) => {
      const status = {
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
        [field]: value,
      };
      mockGit.status.mockResolvedValue(status as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    // `git status --porcelain -u` never lists an ignored path: the `??` lines
    // simple-git parses into `not_added` are by definition the paths no exclude
    // rule matched, and `--ignored` (which nothing here passes) reports ignored
    // paths on separate `!!` lines that land in `status.ignored`. The service
    // used to re-check `not_added` with `git check-ignore -- <every path>`,
    // a spawn that could never remove anything.
    it("takes status.not_added as the untracked-not-ignored list, without a second git command", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: ["new-file.ts", "docs/notes.md"],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
      expect(gitSubcommands()).toEqual([]);
    });

    // A worktree holding a large untracked output directory that nothing
    // gitignores used to hand `check-ignore` an argv of every path in it; past
    // the kernel's ARG_MAX the spawn failed with E2BIG, checkWorktreeStatus
    // threw, and the update phase recorded `update_check_failed` for that
    // worktree every tick instead of the correct "dirty worktree".
    it("answers for a worktree with tens of thousands of untracked files", async () => {
      const generated = Array.from(
        { length: 20_000 },
        (_, index) => `dist/webpack-cache/client-production/chunk-${index}.module.js`,
      );
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: generated,
      } as any);

      await expect(service.checkWorktreeStatus("/test/worktree")).resolves.toBe(false);
      expect(gitSubcommands()).toEqual([]);
    });
  });

  describe("getFullWorktreeStatus", () => {
    it("should return safe-to-remove status when directory does not exist", async () => {
      (fs.access as Mock<any>).mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );

      const result = await service.getFullWorktreeStatus("/test/nonexistent-worktree");

      expect(result).toMatchObject({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      });
      expect(simpleGit).not.toHaveBeenCalledWith("/test/nonexistent-worktree");
    });

    it("should return complete status for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") {
          return "";
        }
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result).toMatchObject({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      });
    });

    it("should return complete status for dirty worktree with reasons", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("3\n");
      mockGit.stashList.mockResolvedValue(stashesOnMain(1));
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.reasons).toContain("uncommitted changes");
      expect(result.reasons).toContain("unpushed commits");
      expect(result.reasons).toContain("operation in progress");
    });

    it("should treat stashed changes as unsafe to remove", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") {
          return "";
        }
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue(stashesOnMain(1));
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktree") return undefined;
        throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
      });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.isClean).toBe(true);
      expect(result.hasStashedChanges).toBe(true);
      expect(result.canRemove).toBe(false);
      expect(result.reasons).toEqual(["stashed changes"]);
    });

    // git has already dropped every ignored path before simple-git parses the
    // status, so a worktree holding nothing but `.DS_Store` reports no `??`
    // lines at all — and the snapshot spends no second command confirming it.
    it("should treat worktree as clean when only gitignored files exist", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.isClean).toBe(true);
      expect(result.canRemove).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(gitSubcommands()).not.toContain("check-ignore");
    });

    // The other half: what status does report as untracked is a real change,
    // listed verbatim, and still costs no extra git command.
    it("should report status.not_added verbatim as the untracked changes", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: ["src/scratch.ts", "notes.md"],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.getFullWorktreeStatus("/test/worktree", true);

      expect(result.isClean).toBe(false);
      expect(result.canRemove).toBe(false);
      expect(result.reasons).toEqual(["uncommitted changes"]);
      expect(result.details?.untrackedFiles).toBe(2);
      expect(result.details?.untrackedFilesList).toEqual(["src/scratch.ts", "notes.md"]);
      expect(gitSubcommands()).not.toContain("check-ignore");
    });

    // `git worktree add` never initializes submodules, so `git submodule status`
    // prints "-<oid> <path>" for every submodule of every worktree this tool
    // creates. Counting that "not initialized" marker as a modification made
    // canRemove permanently false for such repos: the branch was never pruned,
    // sparse narrowing was skipped and the TUI flagged ⊞ forever.
    describe("submodule status prefixes", () => {
      const setupCleanWorktree = (submoduleStatus: string): void => {
        mockGit.status.mockResolvedValue({
          modified: [],
          deleted: [],
          renamed: [],
          created: [],
          conflicted: [],
          not_added: [],
        } as any);
        mockGit.raw.mockImplementation((async (...args: any[]) => {
          const firstArg = Array.isArray(args[0]) ? args[0] : args;
          if (firstArg[0] === "submodule") {
            return submoduleStatus;
          }
          return "0\n";
        }) as any);
        mockGit.stashList.mockResolvedValue({ total: 0 } as any);
        (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (target === "/test/worktree") return undefined;
          throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
        });
      };

      it("treats an uninitialized submodule as removable", async () => {
        setupCleanWorktree("-6f73556 libs/sub\n");

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.hasModifiedSubmodules).toBe(false);
        expect(result.canRemove).toBe(true);
        expect(result.reasons).toEqual([]);
        expect(result.details?.modifiedSubmodules).toBeUndefined();
      });

      it("treats an in-sync submodule as removable", async () => {
        setupCleanWorktree(" 6f73556 libs/sub (heads/main)\n");

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.hasModifiedSubmodules).toBe(false);
        expect(result.canRemove).toBe(true);
        expect(result.details?.modifiedSubmodules).toBeUndefined();
      });

      it("blocks removal when a submodule's checked-out commit differs", async () => {
        setupCleanWorktree("+6f73556 libs/sub (heads/main)\n");

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.hasModifiedSubmodules).toBe(true);
        expect(result.canRemove).toBe(false);
        expect(result.reasons).toContain("modified submodules");
        expect(result.details?.modifiedSubmodules).toEqual(["libs/sub"]);
      });

      it("blocks removal when a submodule has merge conflicts", async () => {
        setupCleanWorktree("U6f73556 libs/sub (heads/main)\n");

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.hasModifiedSubmodules).toBe(true);
        expect(result.canRemove).toBe(false);
        expect(result.reasons).toContain("modified submodules");
        expect(result.details?.modifiedSubmodules).toEqual(["libs/sub"]);
      });

      // The details list used to capture the object id, because the old regex
      // grabbed the first \S+ run after the prefix.
      it("reports submodule paths — including paths with spaces — not object ids", async () => {
        setupCleanWorktree(
          [
            "-6f73556 libs/untouched",
            "+1e24239 libs/my sub (v1.0-1-g1e24239)",
            " abc1234 libs/in-sync (heads/main)",
            "",
          ].join("\n"),
        );

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.details?.modifiedSubmodules).toEqual(["libs/my sub"]);
      });
    });
  });

  // upstreamGone and the any-remote unpushed probe come from the same snapshot
  // getFullWorktreeStatus reads for every other field. The branch comes off
  // the status header; what it tracks and whether that ref exists come off
  // the repository's ref scan.
  describe("getFullWorktreeStatus upstream and unpushed probes", () => {
    const setupWorktree = (opts: {
      // The full ref branch "feature" tracks, "" for none.
      upstream: string;
      remoteBranches: string[];
      localBranches?: string[];
      detached?: boolean;
      ahead?: number;
      behind?: number;
    }): void => {
      header = opts.detached
        ? { current: "HEAD", detached: true, tracking: null, ahead: 0, behind: 0 }
        : {
            current: "feature",
            detached: false,
            tracking: opts.upstream.replace(/^refs\/(heads|remotes)\//, "") || null,
            ahead: opts.ahead ?? 0,
            behind: opts.behind ?? 0,
          };
      const upstreams: Record<string, string> = { feature: opts.upstream };
      for (const branch of opts.localBranches ?? []) upstreams[branch] = "";
      mockForEachRef.mockResolvedValue(refScanOutput(upstreams, opts.remoteBranches));
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));
    };

    it("reports the upstream as gone when it is missing from the remote-tracking refs", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/main"] });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(true);
      expect(status.reasons).toContain("upstream gone");
    });

    // FU-T101-2: a pruned upstream makes `rev-parse <b>@{upstream}` exit 128,
    // so the name the flag needs never arrived. The scan names the configured
    // upstream whether or not its ref exists, and `git status` prints `[gone]`
    // with 0/0 there -- which must not read as "in sync".
    it("reports a pruned upstream as gone with no divergence, not as level", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/main"], ahead: 0 });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(true);
      expect(status.divergence).toBeNull();
    });

    it("does not report the upstream as gone while it still exists on the remote", async () => {
      setupWorktree({
        upstream: "refs/remotes/origin/feature",
        remoteBranches: ["origin/main", "origin/feature"],
        ahead: 2,
        behind: 1,
      });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(false);
      expect(status.divergence).toEqual({ ahead: 2, behind: 1 });
    });

    it("does not report the upstream as gone when none is configured", async () => {
      setupWorktree({ upstream: "", remoteBranches: ["origin/main"] });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(false);
      expect(status.divergence).toBeNull();
    });

    // FU-T101-1: `branch.feature.remote = .` tracks refs/heads/main, which no
    // remote-tracking list will ever contain.
    it("does not report a branch tracking an existing local branch as gone", async () => {
      setupWorktree({
        upstream: "refs/heads/main",
        remoteBranches: ["origin/main"],
        localBranches: ["main"],
        ahead: 1,
      });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(false);
      expect(status.reasons).not.toContain("upstream gone");
      expect(status.divergence).toEqual({ ahead: 1, behind: 0 });
    });

    it("reports a branch tracking a deleted local branch as gone", async () => {
      setupWorktree({ upstream: "refs/heads/base", remoteBranches: ["origin/main"] });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(true);
      expect(status.divergence).toBeNull();
    });

    // No remote-tracking refs at all may be a failed fetch rather than a
    // deletion: fail closed rather than labelling every worktree stale.
    it("does not call a remote upstream gone when the scan saw no remote-tracking refs", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: [] });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(false);
      expect(status.divergence).toBeNull();
    });

    it("cannot say anything about the upstream when the ref scan fails", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/main"] });
      mockForEachRef.mockRejectedValue(new Error("fatal: bad object"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(false);
      expect(status.divergence).toBeNull();
      consoleSpy.mockRestore();
    });

    it("never reports a detached HEAD's upstream as gone", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/main"], detached: true });

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.upstreamGone).toBe(false);
      expect(status.divergence).toBeNull();
    });

    // The branch, whether HEAD is detached and what the branch tracks are all
    // known without a process of their own.
    it("spawns no `git branch`, `branch -r` or `rev-parse @{upstream}` per worktree", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/feature"] });

      await service.getFullWorktreeStatus("/test/worktree");

      expect(mockGit.branch).not.toHaveBeenCalled();
      expect(gitSubcommands()).not.toContain("rev-parse");
      expect(gitSubcommands().sort()).toEqual(["rev-list", "submodule"]);
      expect(mockForEachRef).toHaveBeenCalledTimes(1);
    });

    // A failed status leaves the branch unknown: not detached (which would
    // waive the unpushed gate) and with no branch to probe, so unpushed.
    it("fails closed on unpushed commits when status cannot be read", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/feature"] });
      mockGit.status.mockRejectedValue(new Error("fatal: index file corrupt"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.hasUnpushedCommits).toBe(true);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).not.toContain("detached HEAD");
      expect(status.divergence).toBeNull();
      consoleSpy.mockRestore();
    });

    it("treats a failed any-remote unpushed probe as unpushed commits (conservative)", async () => {
      setupWorktree({ upstream: "refs/remotes/origin/feature", remoteBranches: ["origin/feature"] });
      const baseRaw = mockGit.raw.getMockImplementation() as (...args: any[]) => Promise<string>;
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-list" && firstArg.includes("--remotes")) throw new Error("Git error");
        return baseRaw(...args);
      }) as any);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const status = await service.getFullWorktreeStatus("/test/worktree");

      expect(status.hasUnpushedCommits).toBe(true);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("unpushed commits");
      consoleSpy.mockRestore();
    });
  });

  describe("hasStashedChanges", () => {
    it("should return true when stash exists", async () => {
      mockGit.stashList.mockResolvedValue(stashesOnMain(2));

      const result = await service.hasStashedChanges("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no stash exists", async () => {
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);

      const result = await service.hasStashedChanges("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true on error (conservative)", async () => {
      mockGit.stashList.mockRejectedValue(new Error("Stash error"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasStashedChanges("/test/worktree");

      expect(result).toBe(true);
      consoleSpy.mockRestore();
    });

    // refs/stash is shared by every worktree of the repository, so the list
    // holds other worktrees' stashes too; only this worktree's count.
    describe("attribution to the worktree", () => {
      const listing = (...entries: Array<{ parents?: string; subject: string }>): any => ({
        total: entries.length,
        all: entries.map((entry, index) => ({ hash: `${index}`.padStart(40, "a"), parents: "", ...entry })),
      });
      const revListCalls = (): string[][] =>
        (mockGit.raw as Mock).mock.calls
          .map((call: any[]) => call[0] as string[])
          .filter((args) => Array.isArray(args) && args[0] === "rev-list");

      it("asks git for each entry's parents and reflog subject", async () => {
        await service.hasStashedChanges("/test/worktree");

        expect(mockGit.stashList).toHaveBeenCalledWith({
          format: { hash: "%H", parents: "%P", subject: "%gs" },
        });
      });

      it("ignores stashes made on another branch", async () => {
        mockGit.branch.mockResolvedValue({ current: "feature/a", detached: false } as any);
        mockGit.stashList.mockResolvedValue(
          listing({ subject: "WIP on main: abc123 msg" }, { subject: "On other: my: message" }),
        );

        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(false);
        expect(revListCalls()).toEqual([]);
      });

      it("counts a stash made on the checked-out branch, custom message with colons included", async () => {
        mockGit.branch.mockResolvedValue({ current: "feature/a", detached: false } as any);
        mockGit.stashList.mockResolvedValue(
          listing({ subject: "WIP on main: abc123 msg" }, { subject: "On feature/a: fix: half done" }),
        );

        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(true);
      });

      it("counts every named stash when the checked-out branch cannot be read", async () => {
        mockGit.branch.mockRejectedValue(new Error("branch failed"));
        mockGit.stashList.mockResolvedValue(listing({ subject: "WIP on main: abc123 msg" }));

        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(true);
      });

      it("attributes a detached-HEAD stash by whether its base commit is in HEAD's history", async () => {
        const base = "b".repeat(40);
        mockGit.stashList.mockResolvedValue(
          listing({ parents: `${base} ${"c".repeat(40)}`, subject: "WIP on (no branch): bbbbbbb msg" }),
        );

        mockGit.raw.mockResolvedValue("3\n");
        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(false);
        expect(revListCalls()).toEqual([["rev-list", "--count", `HEAD..${base}`]]);

        mockGit.raw.mockResolvedValue("0\n");
        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(true);
      });

      it("counts an unattributable stash when the history probe fails", async () => {
        mockGit.stashList.mockResolvedValue(listing({ parents: "b".repeat(40), subject: "custom stored message" }));
        mockGit.raw.mockRejectedValue(new Error("fatal: bad revision"));

        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(true);
      });

      it("counts an unattributable stash with no readable parent", async () => {
        mockGit.stashList.mockResolvedValue(listing({ parents: "", subject: "custom stored message" }));

        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(true);
        expect(revListCalls()).toEqual([]);
      });

      // During a rebase or bisect `git branch` prints `* (no branch, rebasing
      // feature/a)`, which simple-git parses as a checked-out branch named
      // "(no". Matching stashes against that name counted none of them.
      it("counts every named stash when `git branch` reports a rebase in progress", async () => {
        mockGit.branch.mockResolvedValue({ current: "(no", detached: false } as any);
        mockGit.stashList.mockResolvedValue(listing({ subject: "WIP on feature/a: abc123 msg" }));

        await expect(service.hasStashedChanges("/test/worktree")).resolves.toBe(true);
      });

      it("reports only this worktree's stashes in the status details", async () => {
        header = { current: "feature/a", detached: false, tracking: "origin/feature/a", ahead: 0, behind: 0 };
        mockForEachRef.mockResolvedValue(
          refScanOutput({ "feature/a": "refs/remotes/origin/feature/a" }, ["origin/feature/a"]),
        );
        mockGit.stashList.mockResolvedValue(
          listing(
            { subject: "WIP on main: abc123 msg" },
            { subject: "On feature/a: mine" },
            { subject: "WIP on other: abc123 msg" },
          ),
        );
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (target === "/test/worktree") return undefined;
          throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
        });

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.hasStashedChanges).toBe(true);
        expect(result.details?.stashCount).toBe(1);
      });

      // `git status -b` reports a rebase as `## HEAD (no branch)`: detached.
      // The stashes made before it name the branch being rebased, so while an
      // operation is in progress the branch reads as unknown, not as a plain
      // detached HEAD that owns no named stash.
      it("counts named stashes during a rebase, whose HEAD reads as detached", async () => {
        header = { current: "HEAD", detached: true, tracking: null, ahead: 0, behind: 0 };
        (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
        mockGit.stashList.mockResolvedValue(listing({ subject: "WIP on feature/a: abc123 msg" }));
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (target === "/test/worktree" || String(target).endsWith("rebase-merge")) return undefined;
          throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
        });

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.details?.operationType).toBe("rebase");
        expect(result.details?.stashCount).toBe(1);
        expect(result.hasStashedChanges).toBe(true);
      });

      it("does not count another branch's stash against a plain detached HEAD", async () => {
        header = { current: "HEAD", detached: true, tracking: null, ahead: 0, behind: 0 };
        (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
        mockGit.stashList.mockResolvedValue(listing({ subject: "WIP on feature/a: abc123 msg" }));
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (target === "/test/worktree") return undefined;
          throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
        });

        const result = await service.getFullWorktreeStatus("/test/worktree", true);

        expect(result.details?.stashCount).toBe(0);
        expect(result.hasStashedChanges).toBe(false);
      });
    });
  });

  describe("hasModifiedSubmodules", () => {
    it("should return true for modified submodules", async () => {
      mockGit.raw.mockResolvedValue("+abc123 submodule1 (modified)\n abc456 submodule2");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false for clean submodules", async () => {
      mockGit.raw.mockResolvedValue(" abc123 submodule1\n abc456 submodule2");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true for conflicted submodules", async () => {
      mockGit.raw.mockResolvedValue("U6f73556 libs/sub (heads/main)");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
    });

    // What every worktree `git worktree add` builds looks like: git does not
    // initialize submodules for a new worktree, and an uninitialized submodule
    // has no working tree that could be holding local work.
    it("should return false for uninitialized submodules", async () => {
      mockGit.raw.mockResolvedValue("-6f73556 libs/sub\n-6f73556 libs/other");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false when no submodules", async () => {
      mockGit.raw.mockResolvedValue("");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true on error (conservative)", async () => {
      mockGit.raw.mockRejectedValue(new Error("No submodules"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("hasOperationInProgress", () => {
    it("should return true when merge is in progress", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>)
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }))
        .mockResolvedValueOnce(undefined);

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/test/worktree", ".git", "MERGE_HEAD"));
    });

    it("should return false when no operation is in progress", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true on outer error (conservative)", async () => {
      (fs.stat as Mock<any>).mockRejectedValue(new Error("Cannot access .git"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should resolve .git file to actual git directory", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => true });
      (fs.readFile as Mock<any>).mockResolvedValue("gitdir: /real/git/dir\n");
      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
      expect(fs.readFile).toHaveBeenCalledWith(path.join("/test/worktree", ".git"), "utf-8");
    });
  });

  describe("validateWorktreeForRemoval", () => {
    it("should not throw for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).resolves.not.toThrow();
    });

    it("should throw WorktreeNotCleanError for dirty worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).rejects.toThrow(WorktreeNotCleanError);
    });

    it("should throw with correct reasons", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("3\n");
      mockGit.stashList.mockResolvedValue(stashesOnMain(1));
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      try {
        await service.validateWorktreeForRemoval("/test/worktree");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorktreeNotCleanError);
        expect((error as WorktreeNotCleanError).reasons).toContain("uncommitted changes");
        expect((error as WorktreeNotCleanError).reasons).toContain("unpushed commits");
      }
    });

    it("should not throw for worktree with only gitignored files", async () => {
      // git filtered `.DS_Store` out of the status itself; nothing re-checks it.
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).resolves.not.toThrow();
    });
  });

  describe("getFullWorktreeStatus with includeDetails", () => {
    it("should include details when includeDetails is true", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file1.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("2\n");
      mockGit.stashList.mockResolvedValue(stashesOnMain(1));
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", true);

      expect(status.details).toBeDefined();
      expect(status.details?.modifiedFiles).toBe(1);
      expect(status.details?.unpushedCommitCount).toBe(2);
      expect(status.details?.stashCount).toBe(1);
    });

    it("should not include details when includeDetails is false", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file1.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("2\n");
      mockGit.stashList.mockResolvedValue(stashesOnMain(1));
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", false);

      expect(status.details).toBeUndefined();
    });

    it("should use lastSyncCommit parameter when provided", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("2\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "abc123");

      expect(status.hasUnpushedCommits).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "abc123..HEAD"]);
    });

    it("should not report false positive for stale branch with lastSyncCommit", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "lastSyncCommit123");

      expect(status.hasUnpushedCommits).toBe(false);
      expect(status.canRemove).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "lastSyncCommit123..HEAD"]);
    });
  });

  // Removal-safety regression tests: a worktree with an unpushed
  // commit was removed by the age-based prune. Every ambiguous probe result
  // must read as "cannot verify => cannot remove".
  describe("fail-closed removal safety", () => {
    const errnoError = (code: string): NodeJS.ErrnoException =>
      Object.assign(new Error(`${code}: probe failed`), { code });

    const cleanStatus = {
      modified: [],
      deleted: [],
      renamed: [],
      created: [],
      conflicted: [],
      not_added: [],
    };

    const setupCleanWorktreeMocks = (): void => {
      mockGit.status.mockResolvedValue(cleanStatus as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") {
          return "";
        }
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockResolvedValueOnce(undefined).mockRejectedValue(errnoError("ENOENT"));
    };

    it("must not report removable when the worktree path check fails with EMFILE", async () => {
      (fs.access as Mock<any>).mockRejectedValue(errnoError("EMFILE"));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.hasUnpushedCommits).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it("still reports removable when the worktree path is genuinely missing (ENOENT)", async () => {
      (fs.access as Mock<any>).mockRejectedValue(errnoError("ENOENT"));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(true);
    });

    it("must not report a detached-HEAD worktree as removable", async () => {
      setupCleanWorktreeMocks();
      header = { current: "HEAD", detached: true, tracking: null, ahead: 0, behind: 0 };

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.reasons).toContain("detached HEAD");
    });

    it("must block removal when commits are missing from all remotes even if lastSyncCommit == HEAD", async () => {
      setupCleanWorktreeMocks();
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "submodule") {
          return "";
        }
        if (firstArg[0] === "rev-list" && firstArg.includes("--remotes")) {
          return "1\n";
        }
        return "0\n";
      }) as any);

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "headCommitSha");

      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
      expect(status.hasUnpushedCommits).toBe(true);
      expect(status.canRemove).toBe(false);
    });

    it("must probe the worktree's HEAD, never the bare branch name, for unpushed commits", async () => {
      setupCleanWorktreeMocks();
      header = { current: "release-1", detached: false, tracking: "origin/release-1", ahead: 0, behind: 0 };

      await service.getFullWorktreeStatus("/test/worktree");

      expect(unpushedProbeRevisions()).toEqual(["HEAD"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    });

    it("must report an operation in progress when operation-file probes fail with EMFILE", async () => {
      setupCleanWorktreeMocks();
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktree") return undefined;
        throw errnoError("EMFILE");
      });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.hasOperationInProgress).toBe(true);
      expect(result.canRemove).toBe(false);
    });

    it("still allows removal of a genuinely clean, fully pushed worktree with lastSyncCommit", async () => {
      setupCleanWorktreeMocks();

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "abc123");

      expect(status.hasUnpushedCommits).toBe(false);
      expect(status.canRemove).toBe(true);
    });
  });

  // Squash-merge + remote branch deletion: commits read as "unpushed" via
  // rev-list, but metadata recorded the upstream tip while the ref existed.
  // HEAD being an ancestor of that tip proves every local commit was pushed.
  describe("fullyPushedUpstreamDeleted", () => {
    const recordedTip = { ref: "origin/feature", oid: "squashtip123", recordedAt: "2026-06-01T00:00:00.000Z" };

    const cleanStatus = {
      modified: [],
      deleted: [],
      renamed: [],
      created: [],
      conflicted: [],
      not_added: [],
    };

    const setupGoneUpstreamWorktree = (opts: { headIsAncestorOfTip: boolean; remoteBranches?: string[] }): void => {
      mockGit.status.mockResolvedValue(cleanStatus as any);
      header = { current: "feature", detached: false, tracking: "origin/feature", ahead: 0, behind: 0 };
      mockForEachRef.mockResolvedValue(
        refScanOutput({ feature: "refs/remotes/origin/feature" }, opts.remoteBranches ?? ["origin/main"]),
      );
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-list" && firstArg[2] === "squashtip123..HEAD") {
          return opts.headIsAncestorOfTip ? "0\n" : "5\n";
        }
        if (firstArg[0] === "rev-list") return "39\n";
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktree") return undefined;
        throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
      });
    };

    it("allows removal when the recorded ref is gone and HEAD is an ancestor of the recorded tip", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "squashtip123..HEAD"]);
      expect(status.hasUnpushedCommits).toBe(true);
      expect(status.fullyPushedUpstreamDeleted).toBe(true);
      expect(status.canRemove).toBe(true);
      expect(status.reasons).not.toContain("unpushed commits");
    });

    it("blocks removal when no recorded tip exists (pre-feature worktree, lost metadata)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, undefined);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("unpushed commits");
    });

    it("blocks removal when commits were added after the upstream deletion (HEAD not an ancestor)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: false });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("unpushed commits");
    });

    it("fails closed when the recorded oid no longer resolves (gc'd away)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-list" && firstArg[2] === "squashtip123..HEAD") {
          throw new Error("fatal: bad revision 'squashtip123..HEAD'");
        }
        if (firstArg[0] === "rev-list") return "39\n";
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
    });

    it("does not apply the override while the recorded ref still exists on the remote (force-push case)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true, remoteBranches: ["origin/main", "origin/feature"] });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      // The proof is only consulted once the ref is gone, so it is not asked for.
      expect(mockGit.raw).not.toHaveBeenCalledWith(["rev-list", "--count", "squashtip123..HEAD"]);
    });

    it("fails closed when the remote branch list is empty (fetch may have failed)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true, remoteBranches: [] });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
    });

    it("never applies the override to a detached HEAD", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });
      header = { current: "HEAD", detached: true, tracking: null, ahead: 0, behind: 0 };

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("detached HEAD");
    });

    it("validateWorktreeForRemoval accepts a fully-pushed worktree with the recorded tip", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      await expect(service.validateWorktreeForRemoval("/test/worktree", undefined, recordedTip)).resolves.not.toThrow();
    });

    it("validateWorktreeForRemoval still rejects without the recorded tip", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      await expect(service.validateWorktreeForRemoval("/test/worktree")).rejects.toThrow(WorktreeNotCleanError);
    });
  });

  // simple-git's .env() replaces the child environment wholesale. The LFS-skip
  // client used for every status probe must therefore carry the (sanitized)
  // process environment with it: without HOME / XDG_CONFIG_HOME git never reads
  // the global excludes file, so a `.DS_Store` ignored there reports as an
  // untracked change and the worktree is neither updated nor pruned; without
  // PATH the spawn can fail outright.
  describe("skipLfs git environment", () => {
    const previous = {
      HOME: process.env.HOME,
      EDITOR: process.env.EDITOR,
      GIT_EDITOR: process.env.GIT_EDITOR,
    };

    beforeEach(() => {
      setEnvVar("HOME", "/home/probe-user");
      setEnvVar("EDITOR", "vim");
      setEnvVar("GIT_EDITOR", "nano");
    });

    afterEach(() => {
      setEnvVar("HOME", previous.HOME);
      setEnvVar("EDITOR", previous.EDITOR);
      setEnvVar("GIT_EDITOR", previous.GIT_EDITOR);
    });

    it("forwards the sanitized process environment alongside GIT_LFS_SKIP_SMUDGE", async () => {
      const lfsService = new WorktreeStatusService({ skipLfs: true });

      await expect(lfsService.checkWorktreeStatus("/test/worktree")).resolves.toBe(true);

      expect(mockGit.env).toHaveBeenCalledTimes(1);
      const env = mockGit.env.mock.calls[0][0] as NodeJS.ProcessEnv;
      expect(process.env.PATH).toBeTruthy();
      expect(env).toMatchObject({
        PATH: process.env.PATH,
        HOME: "/home/probe-user",
        GIT_LFS_SKIP_SMUDGE: "1",
      });
      expect(env).not.toHaveProperty("EDITOR");
      expect(env).not.toHaveProperty("GIT_EDITOR");
    });

    it("keeps parity with default env inheritance for the unsafe-env validation", async () => {
      const lfsService = new WorktreeStatusService({ skipLfs: true });

      await lfsService.checkWorktreeStatus("/test/worktree");

      expect(simpleGit).toHaveBeenCalledWith(
        "/test/worktree",
        expect.objectContaining({ unsafe: GIT_UNSAFE_ALLOWANCES }),
      );
    });

    it("runs the default client non-interactively without the LFS skip when skipLfs is off", async () => {
      await service.checkWorktreeStatus("/test/worktree");

      expect(simpleGit).toHaveBeenCalledWith(
        "/test/worktree",
        expect.objectContaining({ unsafe: GIT_UNSAFE_ALLOWANCES }),
      );
      const env = (mockGit.env as Mock).mock.calls[0]?.[0] as NodeJS.ProcessEnv;
      expect(env).toMatchObject({ PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0" });
      expect(env).not.toHaveProperty("GIT_LFS_SKIP_SMUDGE");
    });
  });

  // refs/heads and refs/remotes live in the common git dir, so every worktree
  // of a repository would list the same refs. A scope shares one scan per
  // repository, keyed by the common dir each worktree's `.git` file leads to.
  describe("RefScanScope", () => {
    // /test/<repo>/<name> is a linked worktree of the bare repo /test/<repo>/.bare.
    const linkedWorktreeFs = (): void => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => true });
      (fs.readFile as Mock<any>).mockImplementation(async (file: any) => {
        const gitFile = /^\/test\/([^/]+)\/([^/]+)\/\.git$/.exec(file);
        if (gitFile) return `gitdir: /test/${gitFile[1]}/.bare/worktrees/${gitFile[2]}\n`;
        if (file.endsWith(`${path.sep}commondir`)) return "../..\n";
        throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
      });
      (fs.access as Mock<any>).mockImplementation(async (target: any) => {
        if (/^\/test\/[^/]+\/[^/]+$/.test(target)) return undefined;
        throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
      });
      mockGit.raw.mockImplementation((async (args: string[]) => (args[0] === "submodule" ? "" : "0\n")) as any);
    };

    it("scans a repository's refs once for all of its worktrees", async () => {
      linkedWorktreeFs();
      const refScans = new RefScanScope();

      const results = await Promise.all(
        ["a", "b", "c", "d"].map((name) =>
          service.getFullWorktreeStatus(`/test/app/${name}`, false, undefined, undefined, refScans),
        ),
      );

      expect(mockForEachRef).toHaveBeenCalledTimes(1);
      // The shared scan is the one each worktree was judged by.
      expect(results.map((result) => result.divergence)).toEqual(Array(4).fill({ ahead: 0, behind: 0 }));
    });

    it("scans each repository separately", async () => {
      linkedWorktreeFs();
      const refScans = new RefScanScope();

      await Promise.all(
        ["/test/app/a", "/test/app/b", "/test/lib/a", "/test/lib/b"].map((worktreePath) =>
          service.getFullWorktreeStatus(worktreePath, false, undefined, undefined, refScans),
        ),
      );

      expect(mockForEachRef).toHaveBeenCalledTimes(2);
    });

    // Without a scope nothing is shared: a check that must see the refs as
    // they are now -- the re-check right before a removal -- scans afresh.
    it("scans per snapshot without a scope", async () => {
      linkedWorktreeFs();

      await Promise.all(["a", "b", "c"].map((name) => service.getFullWorktreeStatus(`/test/app/${name}`)));

      expect(mockForEachRef).toHaveBeenCalledTimes(3);
    });

    it("scans on its own when the common dir cannot be resolved", async () => {
      linkedWorktreeFs();
      (fs.stat as Mock<any>).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      const refScans = new RefScanScope();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await Promise.all(
        ["a", "b"].map((name) =>
          service.getFullWorktreeStatus(`/test/app/${name}`, false, undefined, undefined, refScans),
        ),
      );

      expect(mockForEachRef).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });
  });

  describe("parseRefScan", () => {
    it("keys each local branch's upstream by name and skips symrefs", () => {
      const scan = parseRefScan(
        [
          "refs/heads/feature/x\0refs/remotes/origin/feature/x\0",
          "refs/heads/local\0refs/heads/main\0",
          "refs/heads/main\0\0",
          "refs/remotes/origin/HEAD\0\0refs/remotes/origin/main",
          "refs/remotes/origin/main\0\0",
          "",
        ].join("\n"),
      );

      expect([...scan.upstreams]).toEqual([
        ["feature/x", "refs/remotes/origin/feature/x"],
        ["local", "refs/heads/main"],
        ["main", ""],
      ]);
      expect(scan.refs.has("refs/remotes/origin/HEAD")).toBe(false);
      expect(scan.refs.has("refs/remotes/origin/main")).toBe(true);
      expect(scan.hasRemoteRefs).toBe(true);
    });

    it("notes when there are no remote-tracking refs at all", () => {
      expect(parseRefScan("refs/heads/main\0\0\n").hasRemoteRefs).toBe(false);
    });
  });
});
