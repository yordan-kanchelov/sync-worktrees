import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../constants";
import { ConfigLoaderService } from "../config-loader.service";
import { GitService } from "../git.service";
import { WorktreeStatusService } from "../worktree-status.service";

import type { SimpleGit } from "simple-git";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

// One snapshot fans out to five git commands at once and then to four more, and
// the prune phase asks for `maxStatusChecks` snapshots in parallel — so the
// setting only bounds git processes if every command shares one budget. These
// tests count commands in flight rather than worktrees.
describe("WorktreeStatusService git process budget", () => {
  let inFlight: number;
  let peakInFlight: number;

  /** Resolves on a later turn of the event loop, the way a real spawn does. */
  const tracked = async <T>(value: T): Promise<T> => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight--;
    return value;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    inFlight = 0;
    peakInFlight = 0;

    const cleanStatus = {
      modified: [],
      deleted: [],
      renamed: [],
      created: [],
      conflicted: [],
      not_added: [],
    };

    // A fresh client per worktree, as createGitClient hands back.
    (simpleGit as unknown as Mock).mockImplementation(
      () =>
        ({
          status: vi.fn(() => tracked(cleanStatus)),
          branch: vi.fn((args?: string[]) =>
            tracked(args?.[0] === "-r" ? { all: ["origin/main"] } : { current: "main", detached: false }),
          ),
          raw: vi.fn((args: string[]) => tracked(args[0] === "rev-parse" ? "origin/main\n" : "0\n")),
          stashList: vi.fn(() => tracked({ total: 0 })),
          env: vi.fn().mockReturnThis(),
        }) as unknown as SimpleGit,
    );

    // The worktree directory exists; the merge/rebase/bisect marker files under
    // its .git directory do not.
    (fs.access as Mock).mockImplementation((probed: string) =>
      /^\/test\/worktree-\d+$/.test(probed)
        ? Promise.resolve(undefined)
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    (fs.stat as Mock).mockResolvedValue({ isFile: () => false });
  });

  const checkAll = async (service: WorktreeStatusService, worktrees: number): Promise<void> => {
    await Promise.all(
      Array.from({ length: worktrees }, (_, i) => service.getFullWorktreeStatus(`/test/worktree-${i}`)),
    );
  };

  it("never runs more git commands at once than maxConcurrentGitProcesses", async () => {
    const service = new WorktreeStatusService({ maxConcurrentGitProcesses: 3 });

    await checkAll(service, 8);

    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(3);
  });

  it("holds a single worktree's snapshot to the budget too", async () => {
    const service = new WorktreeStatusService({ maxConcurrentGitProcesses: 1 });

    await checkAll(service, 1);

    expect(peakInFlight).toBe(1);
  });

  it("defaults the budget to maxStatusChecks", async () => {
    const service = new WorktreeStatusService();

    await checkAll(service, 40);

    expect(peakInFlight).toBeLessThanOrEqual(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
  });

  it("still lets one worktree fan out when the budget has room", async () => {
    const service = new WorktreeStatusService({ maxConcurrentGitProcesses: 20 });

    await checkAll(service, 1);

    // status, branch, branch -r, stash list and submodule status all at once.
    expect(peakInFlight).toBe(5);
  });

  it("keeps the same verdict as an unbudgeted check", async () => {
    const service = new WorktreeStatusService({ maxConcurrentGitProcesses: 1 });

    const result = await service.getFullWorktreeStatus("/test/worktree-0");

    expect(result.canRemove).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  // The knob users actually set. Without this wiring the budget would silently
  // stay at its default however low `maxStatusChecks` is set.
  it("takes its size from the repository's maxStatusChecks", async () => {
    const gitService = new GitService({
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test",
      bareRepoDir: "/test/.bare",
      parallelism: { maxStatusChecks: 2 },
    });

    await Promise.all(Array.from({ length: 6 }, (_, i) => gitService.getFullWorktreeStatus(`/test/worktree-${i}`)));

    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(2);
  });

  // The whole chain the example config documents: a top-level `parallelism`
  // block, through config resolution, into the budget that bounds git.
  it("honours a top-level parallelism block, not just a per-repository one", async () => {
    const resolved = new ConfigLoaderService().resolveRepositoryConfig(
      {
        name: "r",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test",
        cronSchedule: "",
        runOnce: false,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { maxStatusChecks: 2 },
    );
    const gitService = new GitService({
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test",
      bareRepoDir: "/test/.bare",
      parallelism: resolved.parallelism,
    });

    await Promise.all(Array.from({ length: 6 }, (_, i) => gitService.getFullWorktreeStatus(`/test/worktree-${i}`)));

    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(2);
  });
});
