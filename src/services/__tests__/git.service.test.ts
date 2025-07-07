import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import simpleGit from "simple-git";

import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { SimpleGit } from "simple-git";

// Mock the modules
jest.mock("fs/promises");
jest.mock("simple-git");

describe("GitService", () => {
  let gitService: GitService;
  let mockConfig: Config;
  let mockGit: jest.Mocked<SimpleGit>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock config
    mockConfig = {
      repoPath: "/test/repo",
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    // Setup mock git instance
    mockGit = {
      fetch: jest.fn<any>().mockResolvedValue(undefined),
      branch: jest.fn<any>().mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/feature-2", "local-branch"],
        current: "main",
      }),
      raw: jest.fn<any>().mockResolvedValue(""),
      status: jest.fn<any>().mockResolvedValue({ isClean: jest.fn().mockReturnValue(true) }),
      clone: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    // Mock simpleGit factory
    (simpleGit as unknown as jest.Mock).mockReturnValue(mockGit);

    gitService = new GitService(mockConfig);
  });

  describe("initialize", () => {
    it("should use existing repository when path exists", async () => {
      // Mock fs.access to succeed (path exists)
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      const git = await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith("/test/repo");
      expect(simpleGit).toHaveBeenCalledWith("/test/repo");
      expect(git).toBe(mockGit);
    });

    it("should clone repository when path does not exist and URL is provided", async () => {
      // Mock fs.access to fail (path doesn't exist)
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));

      await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith("/test/repo");
      expect(simpleGit).toHaveBeenCalledWith(); // Called without args for cloning
      expect(mockGit.clone).toHaveBeenCalledWith("https://github.com/test/repo.git", "/test/repo");
      expect(simpleGit).toHaveBeenCalledWith("/test/repo"); // Called again after cloning
    });

    it("should throw error when path does not exist and no URL is provided", async () => {
      // Mock fs.access to fail
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));

      // Remove repoUrl from config
      const configWithoutUrl = { ...mockConfig, repoUrl: undefined };
      const serviceWithoutUrl = new GitService(configWithoutUrl);

      await expect(serviceWithoutUrl.initialize()).rejects.toThrow(
        'Repo path "/test/repo" not found and no --repoUrl was provided to clone from.',
      );
    });
  });

  describe("getGit", () => {
    it("should throw error when service is not initialized", () => {
      expect(() => gitService.getGit()).toThrow("Git service not initialized. Call initialize() first.");
    });

    it("should return git instance when initialized", async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();

      const git = gitService.getGit();
      expect(git).toBe(mockGit);
    });
  });

  describe("fetchAll", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should fetch with --all and --prune flags", async () => {
      await gitService.fetchAll();

      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--prune"]);
    });
  });

  describe("getRemoteBranches", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return only remote branches without origin prefix", async () => {
      const branches = await gitService.getRemoteBranches();

      expect(mockGit.branch).toHaveBeenCalledWith(["-r"]);
      expect(branches).toEqual(["main", "feature-1", "feature-2"]);
    });

    it("should handle empty branch list", async () => {
      mockGit.branch.mockResolvedValue({ all: [], current: "" } as any);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual([]);
    });
  });

  describe("addWorktree", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should add worktree with correct parameters", async () => {
      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
    });
  });

  describe("removeWorktree", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should remove worktree with force flag", async () => {
      await gitService.removeWorktree("feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "feature-1", "--force"]);
    });
  });

  describe("pruneWorktrees", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should prune worktrees", async () => {
      await gitService.pruneWorktrees();

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "prune"]);
    });
  });

  describe("checkWorktreeStatus", () => {
    it("should return true when worktree is clean", async () => {
      const mockWorktreeGit = {
        status: jest.fn<any>().mockResolvedValue({
          isClean: jest.fn().mockReturnValue(true),
        }),
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const isClean = await gitService.checkWorktreeStatus("/test/worktrees/feature-1");

      expect(simpleGit).toHaveBeenCalledWith("/test/worktrees/feature-1");
      expect(isClean).toBe(true);
    });

    it("should return false when worktree has changes", async () => {
      const mockWorktreeGit = {
        status: jest.fn<any>().mockResolvedValue({
          isClean: jest.fn().mockReturnValue(false),
        }),
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const isClean = await gitService.checkWorktreeStatus("/test/worktrees/feature-1");

      expect(isClean).toBe(false);
    });
  });
});
