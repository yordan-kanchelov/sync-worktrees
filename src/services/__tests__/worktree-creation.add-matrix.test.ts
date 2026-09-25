import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpstreamSetupError } from "../../errors";

import { createGitServiceFixture, mockShowRef as mockShowRefOn } from "./helpers/git-service-fixture";

import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

// Which `git worktree add` WorktreeCreationService runs for each combination
// of local and remote branch, and what it does around it (upstream setup,
// fast-forwarding a stale local ref, rolling back a failed add).
describe("WorktreeCreationService add matrix (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockLogger: Logger;

  const mockShowRef = (opts: Parameters<typeof mockShowRefOn>[1]): void => mockShowRefOn(mockGit, opts);

  beforeEach(async () => {
    ({ gitService, mockGit, mockLogger } = createGitServiceFixture());
    (fs.access as Mock<any>).mockResolvedValue(undefined);
    await gitService.initialize();
  });

  describe("addWorktree - ref existence matrix", () => {
    const makeWorktreeGitMock = () => ({
      branch: vi.fn<any>().mockResolvedValue(undefined),
      raw: vi.fn<any>().mockResolvedValue(""),
      revparse: vi.fn<any>().mockResolvedValue("abc123"),
      env: vi.fn<any>().mockReturnThis(),
    });

    it("should add worktree without upstream when local exists but remote does not (push:false flow)", async () => {
      const worktreeGitMock = makeWorktreeGitMock();
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feat-new") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: false });
      mockGit.raw.mockClear();

      await gitService.addWorktree("feat-new", "/test/worktrees/feat-new");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feat-new", "feat-new"]);
      expect(worktreeGitMock.branch).not.toHaveBeenCalled();
      expect(mockGit.raw).not.toHaveBeenCalledWith(
        expect.arrayContaining(["worktree", "add", "--track", "-b", "feat-new"]),
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to create worktree with tracking"),
      );
    });

    it("should add worktree with upstream when both local and remote exist", async () => {
      const worktreeGitMock = makeWorktreeGitMock();
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      expect(worktreeGitMock.raw).toHaveBeenCalledWith(["merge", "--ff-only", "origin/feature-1"]);
    });

    it("should not fast-forward when both exist and the local branch has commits not on origin", async () => {
      const worktreeGitMock = makeWorktreeGitMock();
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true, localOnlyCommits: 1 });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["merge"]));
    });

    it("should use --track when local missing but remote exists", async () => {
      mockShowRef({ local: false, remote: true });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        "/test/worktrees/feature-1",
        "origin/feature-1",
      ]);
    });

    it("should throw clear WorktreeError when neither local nor remote ref exists", async () => {
      mockShowRef({ local: false, remote: false });
      mockGit.raw.mockClear();

      await expect(gitService.addWorktree("nope", "/test/worktrees/nope")).rejects.toThrow(
        /does not exist locally or on origin/,
      );
      const worktreeAddCalls = mockGit.raw.mock.calls.filter(
        (call) => Array.isArray(call[0]) && call[0][0] === "worktree" && call[0][1] === "add",
      );
      expect(worktreeAddCalls).toHaveLength(0);
    });

    it("should rollback worktree add when --set-upstream-to fails", async () => {
      const worktreeGitMock = {
        branch: vi.fn<any>().mockRejectedValue(new Error("fatal: branch 'feature-1' does not point to a commit")),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true });
      mockGit.raw.mockClear();

      const error = await gitService.addWorktree("feature-1", "/test/worktrees/feature-1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamSetupError);
      expect((error as UpstreamSetupError).rollbackSucceeded).toBe(true);
      expect((error as UpstreamSetupError).message).toMatch(
        /Failed to set upstream for 'feature-1'.*does not point to a commit/,
      );

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", "/test/worktrees/feature-1"]);
    });

    it("should still throw wrapped upstream error if rollback also fails", async () => {
      const worktreeGitMock = {
        branch: vi.fn<any>().mockRejectedValue(new Error("upstream-set-failure")),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true });
      mockGit.raw.mockClear();
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          if (args[0] === "show-ref" && args[1] === "--verify") {
            return Promise.resolve("");
          }
          if (args[0] === "worktree" && args[1] === "remove") {
            return Promise.reject(new Error("rollback-failure"));
          }
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        /Failed to set upstream.*upstream-set-failure.*rollback failed/,
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Rollback failed"));
    });

    it("should not enter tracking-error fallback when upstream-set fails with tracking-classified message", async () => {
      // Fresh add: no existing dir.
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const worktreeGitMock = {
        branch: vi.fn<any>().mockRejectedValue(new Error("fatal: no such remote ref refs/remotes/origin/feature-1")),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true });
      mockGit.raw.mockClear();
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          if (args[0] === "show-ref" && args[1] === "--verify") {
            return Promise.resolve("");
          }
          if (args[0] === "worktree" && args[1] === "remove") {
            return Promise.reject(new Error("rollback-failure"));
          }
          if (args[0] === "worktree" && args[1] === "list") {
            return Promise.resolve("");
          }
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        /Failed to set upstream/,
      );

      // Only the initial `worktree add <path> <branch>` should fire.
      // The fallback non-tracking add at addWorktree's L498 must NOT fire.
      const plainWorktreeAdds = (mockGit.raw as Mock).mock.calls.filter(
        (call) =>
          Array.isArray(call[0]) && call[0][0] === "worktree" && call[0][1] === "add" && !call[0].includes("--track"),
      );
      expect(plainWorktreeAdds).toHaveLength(1);
    });

    it("should not special-case slash branch names (feat/foo with both refs behaves like normal)", async () => {
      const worktreeGitMock = makeWorktreeGitMock();
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feat-foo") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true });

      await gitService.addWorktree("feat/foo", "/test/worktrees/feat-foo");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feat-foo", "feat/foo"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feat/foo", "feat/foo"]);
    });

    it("should reuse ref matrix in retry path after pruning (no remote → non-tracking add)", async () => {
      const worktreePath = "/test/worktrees/feat-new";
      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found"));

      const worktreeGitMock = makeWorktreeGitMock();
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feat-new") ? worktreeGitMock : mockGit,
      );

      mockGit.raw.mockClear();

      let initialAddAttempted = false;
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          if (args[0] === "show-ref" && args[1] === "--verify") {
            const ref = args[args.length - 1];
            if (typeof ref === "string" && ref.startsWith("refs/heads/")) return Promise.resolve("");
            if (typeof ref === "string" && ref.startsWith("refs/remotes/origin/")) {
              return Promise.reject(new Error("show-ref: not found"));
            }
          }
          if (args[0] === "worktree" && args[1] === "add" && !initialAddAttempted) {
            initialAddAttempted = true;
            return Promise.reject(new Error("fatal: 'feat-new' is already registered worktree"));
          }
          if (args[0] === "worktree" && args[1] === "list") {
            return Promise.resolve(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feat-new\nprunable\n\n`);
          }
        }
        return Promise.resolve("");
      });

      await gitService.addWorktree("feat-new", worktreePath);

      const trackingAdds = mockGit.raw.mock.calls.filter(
        (call) => Array.isArray(call[0]) && call[0].includes("--track"),
      );
      expect(trackingAdds).toHaveLength(0);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to create worktree with tracking"),
      );
    });
  });
});
