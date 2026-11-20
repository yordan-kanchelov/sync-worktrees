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

describe("WorktreeStatusService git process budget", () => {
  let inFlight: number;
  let peakInFlight: number;

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
      files: [],
      current: "main",
      detached: false,
      tracking: "origin/main",
      ahead: 0,
      behind: 0,
    };

    (simpleGit as unknown as Mock).mockImplementation(
      () =>
        ({
          status: vi.fn(() => tracked(cleanStatus)),
          raw: vi.fn((args: string[]) =>
            tracked(
              args[0] === "for-each-ref"
                ? "refs/heads/main\0refs/remotes/origin/main\0\nrefs/remotes/origin/main\0\0\n"
                : "0\n",
            ),
          ),
          stashList: vi.fn(() => tracked({ total: 0 })),
          env: vi.fn().mockReturnThis(),
        }) as unknown as SimpleGit,
    );

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

    expect(peakInFlight).toBe(4);
  });

  it("keeps the same verdict as an unbudgeted check", async () => {
    const service = new WorktreeStatusService({ maxConcurrentGitProcesses: 1 });

    const result = await service.getFullWorktreeStatus("/test/worktree-0");

    expect(result.canRemove).toBe(true);
    expect(result.reasons).toEqual([]);
  });

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
