import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorktreeListOutput } from "../../__tests__/test-utils";

import { createGitServiceFixture } from "./helpers/git-service-fixture";

import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("WorktreeCreationService stale directories (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockLogger: Logger;

  beforeEach(() => {
    ({ gitService, mockGit, mockLogger } = createGitServiceFixture());
  });

  describe("addWorktree stale directory safety", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("quarantines an existing non-worktree directory containing a .git instead of deleting it", async () => {
      const target = "/test/worktrees/feature-1";
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });
      (fs.rename as Mock<any>).mockResolvedValue(undefined);

      await gitService.addWorktree("feature-1", target);

      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).toHaveBeenCalledWith(target, expect.stringContaining(".removed"));
    });

    describe("without a .git and without trash", () => {
      const target = "/test/worktrees/feature-1";

      beforeEach(() => {
        (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
          if (p === path.join(target, ".git")) {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          }
          return undefined;
        });
        (mockGit.raw as Mock).mockImplementation((args: unknown) => {
          if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
            return Promise.resolve(
              createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]),
            );
          }
          return Promise.resolve("");
        });
        (fs.rename as Mock<any>).mockResolvedValue(undefined);
      });

      // Unknown content — files someone left at the managed path by hand — is
      // never deleted permanently.
      it("quarantines a non-empty directory instead of deleting it", async () => {
        (fs.readdir as Mock<any>).mockResolvedValueOnce(["notes.txt"]);

        await gitService.addWorktree("feature-1", target);

        expect(fs.rm).not.toHaveBeenCalledWith(target, expect.anything());
        expect(fs.rmdir).not.toHaveBeenCalled();
        expect(fs.rename).toHaveBeenCalledWith(
          target,
          expect.stringMatching(/[/\\]test[/\\]worktrees[/\\]\.removed[/\\].*-feature-1$/),
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("quarantined"));
      });

      it("quarantines a directory whose listing fails instead of deleting it", async () => {
        (fs.readdir as Mock<any>).mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));

        await gitService.addWorktree("feature-1", target);

        expect(fs.rm).not.toHaveBeenCalledWith(target, expect.anything());
        expect(fs.rmdir).not.toHaveBeenCalled();
        expect(fs.rename).toHaveBeenCalledWith(target, expect.stringContaining(".removed"));
      });

      it("removes an empty directory with a non-recursive rmdir", async () => {
        (fs.readdir as Mock<any>).mockResolvedValueOnce([]);
        (fs.rmdir as Mock<any>).mockResolvedValueOnce(undefined);

        await gitService.addWorktree("feature-1", target);

        expect(fs.rmdir).toHaveBeenCalledWith(target);
        expect(fs.rm).not.toHaveBeenCalledWith(target, expect.anything());
        expect(fs.rename).not.toHaveBeenCalled();
      });

      it("quarantines an empty directory that gained content before the rmdir", async () => {
        (fs.readdir as Mock<any>).mockResolvedValueOnce([]);
        (fs.rmdir as Mock<any>).mockRejectedValueOnce(Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" }));

        await gitService.addWorktree("feature-1", target);

        expect(fs.rm).not.toHaveBeenCalledWith(target, expect.anything());
        expect(fs.rename).toHaveBeenCalledWith(target, expect.stringContaining(".removed"));
      });

      it("fails the worktree creation when the quarantine move fails", async () => {
        (fs.readdir as Mock<any>).mockResolvedValueOnce(["notes.txt"]);
        (fs.rename as Mock<any>).mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));

        await expect(gitService.addWorktree("feature-1", target)).rejects.toThrow();

        expect(fs.rm).not.toHaveBeenCalledWith(target, expect.anything());
        expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]));
      });
    });

    it("refuses to clear the stale directory when the .git probe fails for unknown reasons", async () => {
      const target = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
        if (p === path.join(target, ".git")) {
          throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        }
        return undefined;
      });
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", target)).rejects.toThrow();

      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("routes stale-directory cleanup through the injected trasher instead of deleting", async () => {
      const target = "/test/worktrees/feature-1";
      const trasher = vi.fn<any>().mockResolvedValue("/test/worktrees/.trash/id/payload");
      gitService.setStaleDirectoryTrasher(trasher as unknown as (dirPath: string) => Promise<string>);
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await gitService.addWorktree("feature-1", target);

      expect(trasher).toHaveBeenCalledWith(target);
      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("fails the worktree creation when the trasher cannot preserve the stale directory", async () => {
      const target = "/test/worktrees/feature-1";
      gitService.setStaleDirectoryTrasher(
        vi.fn<any>().mockRejectedValue(new Error("EXDEV")) as unknown as (dirPath: string) => Promise<string>,
      );
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", target)).rejects.toThrow(/trash/);

      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
    });
  });
});
