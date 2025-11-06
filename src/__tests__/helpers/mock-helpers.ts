import { vi } from "vitest";

import type { SimpleGit } from "simple-git";

/**
 * Creates a mock SimpleGit instance with common default behaviors
 */
export function createMockGit(overrides?: Partial<SimpleGit>): SimpleGit {
  return {
    fetch: vi.fn<any>().mockResolvedValue(undefined),
    branch: vi.fn<any>().mockResolvedValue({
      all: ["origin/main"],
      current: "main",
      branches: {},
      detached: false,
    }),
    raw: vi.fn<any>().mockResolvedValue(""),
    status: vi.fn<any>().mockResolvedValue({
      isClean: vi.fn().mockReturnValue(true),
      not_added: [],
      conflicted: [],
      created: [],
      deleted: [],
      modified: [],
      renamed: [],
      files: [],
      staged: [],
      ahead: 0,
      behind: 0,
      current: "main",
      tracking: "origin/main",
      detached: false,
    }),
    clone: vi.fn<any>().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

/**
 * Creates a mock file system structure for testing
 */
export interface MockFileSystem {
  [path: string]: {
    type: "file" | "directory";
    content?: string;
    children?: string[];
  };
}

/**
 * Sets up fs.promises mocks based on a mock file system structure
 */
export function setupMockFileSystem(
  mockFs: MockFileSystem,
  fsMock: {
    access: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
  },
): void {
  // Mock fs.access
  fsMock.access.mockImplementation(async (path) => {
    if (!(path in mockFs)) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  });

  // Mock fs.readdir
  fsMock.readdir.mockImplementation(async (path) => {
    const entry = mockFs[path];
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }
    return entry.children || [];
  });

  // Mock fs.mkdir
  fsMock.mkdir.mockImplementation(async (path, options) => {
    if (path in mockFs && !options?.recursive) {
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }
    mockFs[path] = { type: "directory", children: [] };
  });
}

/**
 * Creates a test configuration object
 */
export function createTestConfig(overrides?: any) {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/test/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  };
}
