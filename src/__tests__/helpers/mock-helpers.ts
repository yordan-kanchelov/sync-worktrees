import { jest } from "@jest/globals";

import type { SimpleGit } from "simple-git";

/**
 * Creates a mock SimpleGit instance with common default behaviors
 */
export function createMockGit(overrides?: Partial<SimpleGit>): jest.Mocked<SimpleGit> {
  return {
    fetch: jest.fn<any>().mockResolvedValue(undefined),
    branch: jest.fn<any>().mockResolvedValue({
      all: ["origin/main"],
      current: "main",
      branches: {},
      detached: false,
    }),
    raw: jest.fn<any>().mockResolvedValue(""),
    status: jest.fn<any>().mockResolvedValue({
      isClean: jest.fn().mockReturnValue(true),
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
    clone: jest.fn<any>().mockResolvedValue(undefined),
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
    access: jest.Mock<any>;
    readdir: jest.Mock<any>;
    mkdir: jest.Mock<any>;
  },
): void {
  // Mock fs.access
  fsMock.access.mockImplementation(async (path: string) => {
    if (!(path in mockFs)) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  });

  // Mock fs.readdir
  fsMock.readdir.mockImplementation(async (path: string) => {
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
  fsMock.mkdir.mockImplementation(async (path: string, options?: any) => {
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
    repoPath: "/test/repo",
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/test/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  };
}
