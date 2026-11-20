import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { vi } from "vitest";

import type { Stats } from "fs";
import type { Logger } from "../services/logger.service";
import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

export const TEST_BRANCHES = {
  main: "main",
  feature: "feature/test",
  bugfix: "bugfix/issue-123",
  withSlash: "feature/with/slash",
  orphaned: "orphaned-branch",
};

export const TEST_URLS = {
  github: "https://github.com/test/repo.git",
  gitlab: "https://gitlab.com/test/repo.git",
  ssh: "git@github.com:test/repo.git",
};

export const TEST_PATHS = {
  repo: "/test/repo",
  worktree: "/test/worktrees",
  config: "/test/config.js",
  bareRepo: ".bare/repo",
};

export function createMockGitService(overrides: Partial<SimpleGit> = {}): SimpleGit {
  const defaultMock = {
    clone: vi.fn<any>().mockResolvedValue(undefined),
    fetch: vi.fn<any>().mockResolvedValue(undefined),
    env: vi.fn<any>().mockReturnThis(),
    branch: vi.fn<any>().mockResolvedValue({ all: [], current: "main" }),
    raw: vi.fn<any>().mockResolvedValue(""),
    status: vi.fn<any>().mockResolvedValue({
      isClean: () => true,
      files: [],
      modified: [],
      created: [],
      deleted: [],
      renamed: [],
      staged: [],
    }),
    log: vi.fn<any>().mockResolvedValue({ all: [] }),
    ...overrides,
  };

  return defaultMock as unknown as SimpleGit;
}

export function createMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoUrl: TEST_URLS.github,
    worktreeDir: TEST_PATHS.worktree,
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  };
}

export function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

let tempDirs: string[] = [];

export async function createTempDirectory(prefix = "sync-worktrees-test-"): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

export async function cleanupTempDirectories(): Promise<void> {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
  tempDirs = [];
}

export function createWorktreeListOutput(worktrees: Array<{ path: string; branch: string; commit: string }>): string {
  return worktrees.map((wt) => `worktree ${wt.path}\nHEAD ${wt.commit}\nbranch refs/heads/${wt.branch}\n`).join("\n");
}

export function createRemoteRefListOutput(entries: Array<string | { ref: string; oid: string }>): string {
  return entries
    .map((entry) =>
      typeof entry === "string" ? `refs/remotes/origin/${entry}\0${entry}-oid` : `${entry.ref}\0${entry.oid}`,
    )
    .join("\n");
}

export function buildGitStatusResponse(
  options: {
    isClean?: boolean;
    modified?: string[];
    created?: string[];
    deleted?: string[];
  } = {},
) {
  const { isClean = true, modified = [], created = [], deleted = [] } = options;

  return {
    isClean: () => isClean,
    files: [...modified, ...created, ...deleted],
    modified,
    created,
    deleted,
    renamed: [],
    staged: [],
  };
}

export function setEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

export const PRIMARY_CHECKOUT_GIT_DIR_PROBE = "rev-parse --git-dir --git-common-dir";
export const PRIMARY_CHECKOUT_GIT_DIRS = ".git\n.git\n";

export function buildFsStats(kind: "directory" | "file" | "symlink"): Stats {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  } as unknown as Stats;
}
