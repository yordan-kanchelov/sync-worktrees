import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildRepositories: vi.fn(),
  initialize: vi.fn(),
  listTrashEntries: vi.fn(),
  listKeepRefs: vi.fn(),
}));

vi.mock("../services/config-loader.service", () => ({
  ConfigLoaderService: vi.fn(function () {
    return { buildRepositories: mocks.buildRepositories };
  }),
}));

vi.mock("../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function () {
    return {
      initialize: mocks.initialize,
      isInitialized: vi.fn(() => true),
      isCloneMode: vi.fn(() => false),
      listTrashEntries: mocks.listTrashEntries,
      listKeepRefs: mocks.listKeepRefs,
    };
  }),
}));

import { main } from "../index";

const originalArgv = process.argv;

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ["node", "sync-worktrees", "trash", "--config", "/test/config.js", "--filter", "repo"];
  mocks.buildRepositories.mockResolvedValue({
    repositories: [{ name: "repo", repoUrl: "https://invalid.example/repo.git", worktreeDir: "/test/worktrees" }],
  });
  mocks.initialize.mockRejectedValue(new Error("remote unavailable"));
  mocks.listTrashEntries.mockResolvedValue({ entries: [], invalid: [] });
  mocks.listKeepRefs.mockResolvedValue([]);
});

afterEach(() => {
  process.argv = originalArgv;
});

it("lists local trash without initializing or contacting the remote", async () => {
  await expect(main()).resolves.toBeUndefined();

  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.listTrashEntries).toHaveBeenCalledOnce();
});
