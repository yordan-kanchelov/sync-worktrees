import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { vi } from "vitest";

import type { Logger } from "../services/logger.service";
import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

// Common test data constants
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

// Mock Git Service Factory
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

// Mock Configuration Factory
export function createMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoUrl: TEST_URLS.github,
    worktreeDir: TEST_PATHS.worktree,
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  };
}

// Mock Logger Factory
export function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// Temporary Directory Helper
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

// File System Mock Helpers
export function mockFileSystem(): {
  mkdir: ReturnType<typeof vi.spyOn>;
  access: ReturnType<typeof vi.spyOn>;
  readdir: ReturnType<typeof vi.spyOn>;
  rm: ReturnType<typeof vi.spyOn>;
  stat: ReturnType<typeof vi.spyOn>;
  restore: () => void;
} {
  const mocks = {
    mkdir: vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any),
    access: vi.spyOn(fs, "access").mockResolvedValue(undefined as any),
    readdir: vi.spyOn(fs, "readdir").mockResolvedValue([] as any),
    rm: vi.spyOn(fs, "rm").mockResolvedValue(undefined as any),
    stat: vi.spyOn(fs, "stat").mockImplementation(() => {
      throw new Error(`ENOENT: no such file or directory`);
    }),
  };

  return {
    ...mocks,
    restore: () => Object.values(mocks).forEach((mock) => mock.mockRestore()),
  } as any;
}

// Git Raw Output Helpers
export function createWorktreeListOutput(worktrees: Array<{ path: string; branch: string; commit: string }>): string {
  return worktrees.map((wt) => `worktree ${wt.path}\nHEAD ${wt.commit}\nbranch refs/heads/${wt.branch}\n`).join("\n");
}

export function createBranchListOutput(branches: string[]): string {
  return branches.map((branch) => `  remotes/origin/${branch}`).join("\n");
}

// Test Execution Helper
export async function withTempDirectory<T>(fn: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await createTempDirectory();
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// Mock Response Builders
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

export function buildGitLogResponse(commits: Array<{ hash: string; message: string }> = []) {
  return {
    all: commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      date: new Date().toISOString(),
      author_name: "Test Author",
      author_email: "test@example.com",
    })),
  };
}
