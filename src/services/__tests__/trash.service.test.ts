import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { GIT_CONSTANTS, TRASH_CONSTANTS } from "../../constants";
import { TrashOperationError } from "../../errors";
import { TrashService } from "../trash.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";

const DAY_MS = 86_400_000;

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    localBranchExists: vi.fn<any>().mockResolvedValue(false),
    getLocalBranchCommit: vi.fn<any>().mockResolvedValue(null),
    createBranchAt: vi.fn<any>().mockResolvedValue(undefined),
    addWorktreeNoCheckout: vi.fn<any>().mockResolvedValue(undefined),
    resetWorktreeIndex: vi.fn<any>().mockResolvedValue(undefined),
    removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
    deleteLocalBranch: vi.fn<any>().mockResolvedValue(undefined),
  };
}

describe("TrashService", () => {
  let worktreeDir: string;
  let config: Config;
  let gitStub: ReturnType<typeof makeGitStub>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let logger: Logger;
  let service: TrashService;

  beforeEach(async () => {
    worktreeDir = await createTempDirectory();
    config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    };
    gitStub = makeGitStub();
    audit = { record: vi.fn<any>().mockResolvedValue(undefined) };
    logger = createMockLogger();
    service = new TrashService(
      config,
      gitStub as unknown as GitService,
      logger,
      audit as unknown as RemovalAuditService,
    );
  });

  afterEach(async () => {
    await cleanupTempDirectories();
  });

  async function makeSourceDir(name: string, files: Record<string, string> = { "file.txt": "data" }): Promise<string> {
    const dir = path.join(worktreeDir, name);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, file), content);
    }
    return dir;
  }

  describe("trashDirectory", () => {
    it("moves the directory into .trash/<id>/payload with a manifest and pin ref, so the removal stays reversible", async () => {
      const source = await makeSourceDir("feature-x");

      const entry = await service.trashDirectory({ dirPath: source, branch: "feature-x", reason: "prune" });

      await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(entry.payloadPath, "file.txt"), "utf-8")).resolves.toBe("data");

      const manifest = entry.manifest;
      expect(manifest.branch).toBe("feature-x");
      expect(manifest.reason).toBe("prune");
      expect(manifest.headOid).toBe("abc123");
      expect(manifest.pinRef).toBe(`${GIT_CONSTANTS.TRASH_REF_PREFIX}${manifest.id}`);
      expect(manifest.originalPath).toBe(source);
      expect(gitStub.updateRef).toHaveBeenCalledWith(manifest.pinRef, "abc123");

      const onDisk = JSON.parse(
        await fs.readFile(path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf-8"),
      );
      expect(onDisk).toEqual(manifest);

      expect(new Date(manifest.expiresAt).getTime() - new Date(manifest.deletedAt).getTime()).toBe(30 * DAY_MS);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "trash_create", result: "success", trashId: manifest.id }),
      );
    });

    it("honors trash.retentionDays for the expiry clock", async () => {
      config.trash = { retentionDays: 7 };
      const source = await makeSourceDir("short-lived");

      const { manifest } = await service.trashDirectory({ dirPath: source, reason: "orphan" });

      expect(new Date(manifest.expiresAt).getTime() - new Date(manifest.deletedAt).getTime()).toBe(7 * DAY_MS);
    });

    it("degrades to a files-only entry when pinning fails — preservation must not block on the ref", async () => {
      gitStub.updateRef.mockRejectedValue(new Error("bad object"));
      const source = await makeSourceDir("unpinnable");

      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "unpinnable",
        reason: "prune",
      });

      expect(manifest.pinRef).toBeNull();
      expect(manifest.headOid).toBe("abc123");
      await expect(fs.access(payloadPath)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not pin"));
    });

    it("does not resolve a HEAD or pin for branchless directories", async () => {
      const source = await makeSourceDir("orphan-dir");

      const { manifest } = await service.trashDirectory({ dirPath: source, reason: "orphan" });

      expect(manifest.headOid).toBeNull();
      expect(manifest.pinRef).toBeNull();
      expect(gitStub.getCurrentCommit).not.toHaveBeenCalled();
      expect(gitStub.updateRef).not.toHaveBeenCalled();
    });

    it("fails closed when the payload cannot be moved: no half-entry survives and the pin is rolled back", async () => {
      const missingSource = path.join(worktreeDir, "does-not-exist");

      await expect(
        service.trashDirectory({ dirPath: missingSource, branch: "ghost", reason: "prune" }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      const trashContents = await fs.readdir(service.getTrashRoot()).catch(() => []);
      expect(trashContents).toEqual([]);
      expect(gitStub.deleteRef).toHaveBeenCalledWith(expect.stringContaining(GIT_CONSTANTS.TRASH_REF_PREFIX));
    });
  });

  describe("trashAndUnregisterWorktree", () => {
    it("runs the removal sequence in order: payload to trash, registration cleared, branch ref deleted", async () => {
      const source = await makeSourceDir("feature-seq");

      const { entry, branchRefError } = await service.trashAndUnregisterWorktree({
        dirPath: source,
        branch: "feature-seq",
        reason: "prune",
      });

      expect(branchRefError).toBeUndefined();
      await expect(fs.access(entry.payloadPath)).resolves.toBeUndefined();
      expect(gitStub.removeWorktree).toHaveBeenCalledWith(source, { force: true });
      expect(gitStub.deleteLocalBranch).toHaveBeenCalledWith("feature-seq");
      expect(gitStub.removeWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        gitStub.deleteLocalBranch.mock.invocationCallOrder[0],
      );
    });

    it("returns the ref-delete failure as a warning — the payload is already safe in trash", async () => {
      const source = await makeSourceDir("feature-leftover");
      gitStub.deleteLocalBranch.mockRejectedValue(new Error("ref locked"));

      const { entry, branchRefError } = await service.trashAndUnregisterWorktree({
        dirPath: source,
        branch: "feature-leftover",
        reason: "manual",
      });

      expect(branchRefError).toContain("ref locked");
      await expect(fs.access(entry.payloadPath)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Leftover branch ref"));
    });
  });

  describe("listEntries / getSummary", () => {
    it("returns only manifested entries and flags unrecognized content instead of hiding it", async () => {
      const sourceA = await makeSourceDir("entry-a");
      const sourceB = await makeSourceDir("entry-b");
      await service.trashDirectory({ dirPath: sourceA, reason: "orphan" });
      await service.trashDirectory({ dirPath: sourceB, reason: "orphan" });

      const junkDir = path.join(service.getTrashRoot(), "no-manifest-here");
      await fs.mkdir(junkDir, { recursive: true });
      await fs.writeFile(path.join(service.getTrashRoot(), "stray-file"), "x");

      const { entries, invalid } = await service.listEntries();
      expect(entries).toHaveLength(2);
      expect(invalid).toEqual([junkDir]);

      const summary = await service.getSummary();
      expect(summary.itemCount).toBe(2);
      expect(summary.totalSizeBytes).toBeGreaterThanOrEqual(0);
      expect(summary.soonestExpiresAt).toBe(
        entries.map((entry) => entry.manifest.expiresAt).sort((a, b) => a.localeCompare(b))[0],
      );
    });

    it("returns empty results when no trash root exists yet", async () => {
      await expect(service.listEntries()).resolves.toEqual({ entries: [], invalid: [] });
      await expect(service.getSummary()).resolves.toEqual({
        itemCount: 0,
        totalSizeBytes: 0,
        unknownSizeCount: 0,
        soonestExpiresAt: null,
      });
    });
  });

  describe("restore", () => {
    it("restores a branchless entry as a plain directory at its original path", async () => {
      const source = await makeSourceDir("plain", { "notes.md": "keep me" });
      const { manifest } = await service.trashDirectory({ dirPath: source, reason: "orphan" });

      const restored = await service.restore(manifest.id);

      expect(restored.originalPath).toBe(source);
      await expect(fs.readFile(path.join(source, "notes.md"), "utf-8")).resolves.toBe("keep me");
      await expect(service.listEntries()).resolves.toMatchObject({ entries: [] });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "trash_restore", result: "success", trashId: manifest.id }),
      );
    });

    it("refuses to restore over an existing destination — restore must never clobber live data", async () => {
      const source = await makeSourceDir("occupied");
      const { manifest } = await service.trashDirectory({ dirPath: source, reason: "orphan" });
      await fs.mkdir(source, { recursive: true });

      await expect(service.restore(manifest.id)).rejects.toBeInstanceOf(TrashOperationError);
      const { entries } = await service.listEntries();
      expect(entries).toHaveLength(1);
    });

    it("explains the occupied destination for diverged-replace entries — a fresh worktree took the path", async () => {
      const source = await makeSourceDir("diverged-x");
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "diverged-x",
        reason: "diverged-replace",
      });
      await fs.mkdir(source, { recursive: true });

      await expect(service.restore(manifest.id)).rejects.toThrow(/fresh worktree replaced this one/);
    });

    it("recreates branch worktrees: branch at the pinned commit, preserved files overlaid, fresh .git link kept", async () => {
      const source = await makeSourceDir("feature-y", {
        "work.txt": "uncommitted work",
        ".git": "gitdir: /stale/pruned/admin",
      });
      const { manifest } = await service.trashDirectory({ dirPath: source, branch: "feature-y", reason: "prune" });

      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        const destination = args[1] as string;
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, ".git"), "gitdir: /fresh/admin");
      });

      const restored = await service.restore(manifest.id);

      expect(gitStub.createBranchAt).toHaveBeenCalledWith("feature-y", "abc123");
      expect(gitStub.addWorktreeNoCheckout).toHaveBeenCalledWith("feature-y", source);
      expect(gitStub.resetWorktreeIndex).toHaveBeenCalledWith(source);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.readFile(path.join(source, ".git"), "utf-8")).resolves.toBe("gitdir: /fresh/admin");
      expect(gitStub.deleteRef).toHaveBeenCalledWith(manifest.pinRef);
      expect(restored.branch).toBe("feature-y");
      await expect(service.listEntries()).resolves.toMatchObject({ entries: [] });
    });

    it("reuses a matching branch ref left behind by git worktree remove", async () => {
      const source = await makeSourceDir("feature-left-ref", { "work.txt": "preserved" });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-left-ref",
        reason: "prune",
      });
      gitStub.getLocalBranchCommit.mockResolvedValue("abc123");
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        const destination = args[1] as string;
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, ".git"), "gitdir: /fresh/admin");
      });

      await service.restore(manifest.id);

      expect(gitStub.createBranchAt).not.toHaveBeenCalled();
      expect(gitStub.addWorktreeNoCheckout).toHaveBeenCalledWith("feature-left-ref", source);
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("preserved");
    });

    it("falls back to a plain files restore when the entry has no pin — gc may have collected the commit", async () => {
      gitStub.updateRef.mockRejectedValue(new Error("bad object"));
      const source = await makeSourceDir("pinless", { "work.txt": "data" });
      const { manifest } = await service.trashDirectory({ dirPath: source, branch: "pinless", reason: "prune" });
      expect(manifest.pinRef).toBeNull();

      await service.restore(manifest.id);

      expect(gitStub.createBranchAt).not.toHaveBeenCalled();
      expect(gitStub.addWorktreeNoCheckout).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("data");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("restoring files only"));
    });

    it("refuses when the branch exists at a different commit instead of clobbering it", async () => {
      const source = await makeSourceDir("feature-z");
      const { manifest } = await service.trashDirectory({ dirPath: source, branch: "feature-z", reason: "prune" });
      gitStub.getLocalBranchCommit.mockResolvedValue("def456");

      await expect(service.restore(manifest.id)).rejects.toBeInstanceOf(TrashOperationError);
      expect(gitStub.createBranchAt).not.toHaveBeenCalled();
      expect(gitStub.addWorktreeNoCheckout).not.toHaveBeenCalled();
      const { entries } = await service.listEntries();
      expect(entries).toHaveLength(1);
    });

    it("rolls back the branch and keeps the trash entry intact when worktree recreation fails", async () => {
      const source = await makeSourceDir("feature-fail");
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-fail",
        reason: "prune",
      });
      gitStub.addWorktreeNoCheckout.mockRejectedValue(new Error("worktree add failed"));

      await expect(service.restore(manifest.id)).rejects.toBeInstanceOf(TrashOperationError);

      expect(gitStub.deleteLocalBranch).toHaveBeenCalledWith("feature-fail");
      await expect(fs.access(payloadPath)).resolves.toBeUndefined();
    });

    it("rejects unknown ids", async () => {
      await expect(service.restore("nope")).rejects.toBeInstanceOf(TrashOperationError);
    });
  });
});
