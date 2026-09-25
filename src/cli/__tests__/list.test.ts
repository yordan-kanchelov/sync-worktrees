import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { countOnDisk, formatDiskCounts, runList } from "../list";

import type { RepositoryConfig } from "../../types";
import type { ListDependencies, ListedRepository, RepositoryDiskCounts } from "../list";

const worktreeRepo: RepositoryConfig = {
  name: "app",
  repoUrl: "https://user:s3cret@example.com/org/app.git",
  worktreeDir: "/work/app",
  bareRepoDir: "/work/.bare/app",
  cronSchedule: "0 * * * *",
  runOnce: false,
  branchInclude: ["main", "release/*"],
  branchMaxAge: "14d",
  sparseCheckout: { include: ["packages/app"], mode: "cone" },
  skipLfs: true,
};

const cloneRepo: RepositoryConfig = {
  name: "docs",
  mode: "clone",
  repoUrl: "https://example.com/org/docs.git",
  worktreeDir: "/work/docs",
  cronSchedule: "*/30 * * * *",
  runOnce: true,
  branch: "develop",
};

const config = { path: "/work/sync-worktrees.config.js", source: "flag" as const };

describe("sync-worktrees list", () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void stdout.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function deps(
    repositories: RepositoryConfig[],
    counts: (repo: RepositoryConfig) => RepositoryDiskCounts = (repo) =>
      repo.mode === "clone"
        ? { worktrees: 1, trashEntries: null, error: null }
        : { worktrees: 3, trashEntries: 1, error: null },
  ): ListDependencies {
    return {
      loadRepositories: vi.fn(async () => repositories),
      countOnDisk: vi.fn(async (repo: RepositoryConfig) => counts(repo)),
    };
  }

  it("prints a JSON array with every key, the URL redacted and the on-disk counts", async () => {
    const code = await runList(config, { json: true }, deps([worktreeRepo, cloneRepo]));

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const listed = JSON.parse(stdout.join("\n")) as ListedRepository[];
    expect(listed).toEqual([
      {
        name: "app",
        mode: "worktree",
        repoUrl: "https://***@example.com/org/app.git",
        worktreeDir: "/work/app",
        bareRepoDir: "/work/.bare/app",
        branch: null,
        schedule: "0 * * * *",
        runOnce: false,
        skipLfs: true,
        filters: { branchInclude: ["main", "release/*"], branchExclude: null, branchMaxAge: "14d" },
        sparseCheckout: {
          include: ["packages/app"],
          exclude: [],
          mode: "cone",
          skipUpdateWhenOutsideSparse: true,
        },
        counts: { worktrees: 3, trashEntries: 1, error: null },
      },
      {
        name: "docs",
        mode: "clone",
        repoUrl: "https://example.com/org/docs.git",
        worktreeDir: "/work/docs",
        bareRepoDir: null,
        branch: "develop",
        schedule: "*/30 * * * *",
        runOnce: true,
        skipLfs: false,
        filters: { branchInclude: null, branchExclude: null, branchMaxAge: null },
        sparseCheckout: null,
        counts: { worktrees: 1, trashEntries: null, error: null },
      },
    ]);
    expect(stdout.join("\n")).not.toContain("s3cret");
  });

  it("shows the config it used, the settings and the counts in the human report", async () => {
    const code = await runList(
      { path: path.join(process.cwd(), "..", "sync-worktrees.config.js"), source: "discovered" },
      {},
      deps([worktreeRepo, cloneRepo]),
    );

    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("📄 Using config: ../sync-worktrees.config.js (found in a parent directory)");
    expect(out).toContain("1. app");
    expect(out).toContain("   Mode: worktree");
    expect(out).toContain("   URL: https://***@example.com/org/app.git");
    expect(out).toContain("   Branch filters: include main, release/*; max age 14d");
    expect(out).toContain("   Sparse checkout (cone): include packages/app");
    expect(out).toContain("   Skip LFS: true");
    expect(out).toContain("   On disk: 3 worktrees, 1 trash entry");
    expect(out).toContain("2. docs");
    expect(out).toContain("   Branch: develop");
    expect(out).toContain("   On disk: cloned");
    expect(out).not.toContain("s3cret");
  });

  it("passes the filter to the loader and exits 1 when it matches nothing, keeping stdout empty", async () => {
    const d = deps([]);
    const code = await runList(config, { filter: "nope-*", json: true }, d);

    expect(code).toBe(1);
    expect(d.loadRepositories).toHaveBeenCalledWith(config.path, "nope-*");
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("No repositories match filter: nope-*");
  });

  it("reports a config that does not load on one redacted stderr line and exits 1", async () => {
    const d: ListDependencies = {
      loadRepositories: vi.fn(async () => {
        throw new Error("Failed to load config file: bad remote https://u:hunter2@example.com/x.git");
      }),
      countOnDisk: vi.fn(),
    };

    const code = await runList(config, { json: true }, d);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    const err = stderr.join("\n");
    expect(err).toContain("Error loading config file: bad remote");
    expect(err).not.toContain("hunter2");
    expect(d.countOnDisk).not.toHaveBeenCalled();
  });

  it("says why a count is unknown instead of printing zero", () => {
    expect(
      formatDiskCounts({ mode: "worktree", counts: { worktrees: null, trashEntries: null, error: "EACCES" } }),
    ).toBe("unknown (EACCES)");
    expect(formatDiskCounts({ mode: "clone", counts: { worktrees: 0, trashEntries: null, error: null } })).toBe(
      "not cloned yet",
    );
    expect(formatDiskCounts({ mode: "worktree", counts: { worktrees: 1, trashEntries: 2, error: null } })).toBe(
      "1 worktree, 2 trash entries",
    );
  });
});

describe("countOnDisk before the first sync", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-list-counts-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("counts nothing, without error, for a worktree repository whose bare repo does not exist yet", async () => {
    const counts = await countOnDisk({
      ...worktreeRepo,
      worktreeDir: path.join(tempDir, "wt"),
      bareRepoDir: path.join(tempDir, ".bare", "app"),
    });
    expect(counts).toEqual({ worktrees: 0, trashEntries: 0, error: null });
    // A listing creates nothing: no worktree directory, no bare repo, no trash.
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it("counts no checkout and no trash for a clone that has not been made", async () => {
    const counts = await countOnDisk({ ...cloneRepo, worktreeDir: path.join(tempDir, "docs") });
    expect(counts).toEqual({ worktrees: 0, trashEntries: null, error: null });
  });
});
