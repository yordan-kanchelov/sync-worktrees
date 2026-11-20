import { vi } from "vitest";

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
