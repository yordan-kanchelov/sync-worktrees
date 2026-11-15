import { vi } from "vitest";

// One WorktreeMetadataService stand-in per test file, shared by the module
// mock below and by the tests that assert on it. It imports nothing but
// vitest, so a vi.mock factory can load it before the mocked module exists:
//
//   vi.mock("../worktree-metadata.service", async () =>
//     (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
//   );
export const mockMetadataServiceInstance = {
  createInitialMetadataFromPath: vi.fn<any>().mockResolvedValue(undefined),
  updateLastSyncFromPath: vi.fn<any>().mockResolvedValue(undefined),
  loadMetadata: vi.fn<any>().mockResolvedValue(null),
  loadMetadataFromPath: vi.fn<any>().mockResolvedValue(null),
  deleteMetadataFromPath: vi.fn<any>().mockResolvedValue(undefined),
  saveMetadata: vi.fn<any>().mockResolvedValue(undefined),
  getMetadataPath: vi.fn<any>().mockResolvedValue("/test/path"),
  getMetadataPathFromWorktreePath: vi.fn<any>().mockResolvedValue("/test/path"),
};

export const worktreeMetadataServiceModuleMock = (): Record<string, unknown> => ({
  WorktreeMetadataService: vi.fn(function () {
    return mockMetadataServiceInstance;
  }),
});
