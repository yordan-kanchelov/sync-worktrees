import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { allowDeletion, mockUndeletableFile } from "../../__tests__/helpers/undeletable-file";
import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { GIT_CONSTANTS, TRASH_CONSTANTS } from "../../constants";
import { TrashOperationError } from "../../errors";
import { TrashService, summarizeTrashEntries } from "../trash.service";

import type * as FsPromises from "fs/promises";
import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";

// Real filesystem everywhere except the one path a test declares undeletable:
// an ESM namespace export cannot be spied on, so `rm` is replaceable only by
// way of a partial module mock.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, default: actual, rm: vi.fn(actual.rm) };
});

const DAY_MS = 86_400_000;
const PREFIX = GIT_CONSTANTS.TRASH_REF_PREFIX;
const HASH = "0123456789abcdef";

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    getLocalBranchCommit: vi.fn<any>().mockResolvedValue(null),
    createBranchAt: vi.fn<any>().mockResolvedValue(undefined),
    addWorktreeNoCheckout: vi.fn<any>().mockResolvedValue(undefined),
    trackRemoteBranchIfExists: vi.fn<any>().mockResolvedValue(false),
    resetWorktreeIndex: vi.fn<any>().mockResolvedValue(undefined),
    removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
    getWorktreeLock: vi.fn<any>().mockResolvedValue({ locked: false }),
    deleteLocalBranch: vi.fn<any>().mockResolvedValue(undefined),
    deleteLocalBranchIfAt: vi.fn<any>().mockResolvedValue(undefined),
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
    // Before the cleanup below: it deletes the temp trees with the very fs.rm
    // some of these tests replace.
    allowDeletion();
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
      expect(manifest.pinRef).toMatch(new RegExp(`^${GIT_CONSTANTS.TRASH_REF_PREFIX}[0-9a-f]{16}/${manifest.id}$`));
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

    // The rollback of a half-made entry is a delete like any other: when it is
    // refused, what stays behind has to be something the pipeline can still
    // see and finish — a payload-less entry that lists and ages out.
    it("leaves a listable entry behind, and says so, when the rollback delete is refused", async () => {
      const missingSource = path.join(worktreeDir, "does-not-exist");
      await mockUndeletableFile(TRASH_CONSTANTS.MANIFEST_FILENAME);

      await expect(
        service.trashDirectory({ dirPath: missingSource, branch: "ghost", reason: "prune" }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      const { entries, invalid } = await service.listEntries();
      expect(entries).toHaveLength(1);
      expect(invalid).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ages out with the retention window"));
    });

    it("aborts and rolls back when HEAD moves between resolution and the payload move (commit made mid-trash)", async () => {
      // First resolution pins abc123; the pre-rename re-check sees a new
      // commit the user made during the (slow) size scan / bundle window.
      gitStub.getCurrentCommit.mockResolvedValueOnce("abc123").mockResolvedValueOnce("def456");
      const source = await makeSourceDir("racing-commit");

      await expect(
        service.trashDirectory({ dirPath: source, branch: "racing-commit", reason: "prune" }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      // Source untouched, no trash container left behind, pin rolled back.
      await expect(fs.access(source)).resolves.toBeUndefined();
      const trashContents = await fs.readdir(service.getTrashRoot()).catch(() => []);
      expect(trashContents).toEqual([]);
      expect(gitStub.deleteRef).toHaveBeenCalledWith(expect.stringContaining(GIT_CONSTANTS.TRASH_REF_PREFIX));
    });

    it("aborts when HEAD can no longer be resolved at the pre-rename re-check", async () => {
      gitStub.getCurrentCommit.mockResolvedValueOnce("abc123").mockRejectedValueOnce(new Error("gone"));
      const source = await makeSourceDir("vanishing-head");

      await expect(
        service.trashDirectory({ dirPath: source, branch: "vanishing-head", reason: "prune" }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      await expect(fs.access(source)).resolves.toBeUndefined();
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
      // Conditional delete: the ref goes only while it still points at the
      // verified HEAD, so a commit racing the removal keeps its branch.
      expect(gitStub.deleteLocalBranchIfAt).toHaveBeenCalledWith("feature-seq", "abc123");
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      expect(gitStub.removeWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        gitStub.deleteLocalBranchIfAt.mock.invocationCallOrder[0],
      );
    });

    it("keeps the branch ref (leftover warning) when it moved between HEAD verification and deletion", async () => {
      // The CAS delete refuses because the ref no longer points at the
      // verified oid — the racing commit must keep its branch.
      gitStub.deleteLocalBranchIfAt.mockRejectedValue(new Error("ref value mismatch"));
      const source = await makeSourceDir("racing-ref");

      const { entry, branchRefError } = await service.trashAndUnregisterWorktree({
        dirPath: source,
        branch: "racing-ref",
        reason: "prune",
      });

      expect(branchRefError).toContain("ref value mismatch");
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      await expect(fs.access(entry.payloadPath)).resolves.toBeUndefined();
    });

    it("refuses keep-on-reap removal when HEAD cannot be resolved before unregistering the worktree", async () => {
      gitStub.getCurrentCommit.mockRejectedValue(new Error("missing head"));
      const source = await makeSourceDir("unknown-head");

      await expect(
        service.trashAndUnregisterWorktree({
          dirPath: source,
          branch: "unknown-head",
          reason: "manual",
          keepPinOnReap: true,
        }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      await expect(fs.access(source)).resolves.toBeUndefined();
      expect(gitStub.removeWorktree).not.toHaveBeenCalled();
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      const trashContents = await fs.readdir(service.getTrashRoot()).catch(() => []);
      expect(trashContents).toEqual([]);
    });

    it("refuses keep-on-reap removal when the pin ref cannot be created before deleting the branch", async () => {
      gitStub.updateRef.mockRejectedValue(new Error("bad object"));
      const source = await makeSourceDir("unpinned-keep");

      await expect(
        service.trashAndUnregisterWorktree({
          dirPath: source,
          branch: "unpinned-keep",
          reason: "manual",
          keepPinOnReap: true,
        }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      await expect(fs.access(source)).resolves.toBeUndefined();
      expect(gitStub.removeWorktree).not.toHaveBeenCalled();
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      const trashContents = await fs.readdir(service.getTrashRoot()).catch(() => []);
      expect(trashContents).toEqual([]);
    });

    it("returns the ref-delete failure as a warning — the payload is already safe in trash", async () => {
      const source = await makeSourceDir("feature-leftover");
      gitStub.deleteLocalBranchIfAt.mockRejectedValue(new Error("ref locked"));

      const { entry, branchRefError } = await service.trashAndUnregisterWorktree({
        dirPath: source,
        branch: "feature-leftover",
        reason: "manual",
      });

      expect(branchRefError).toContain("ref locked");
      await expect(fs.access(entry.payloadPath)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Leftover branch ref"));
    });

    it("restores the source when unregistering fails, so a partial removal never hides the worktree", async () => {
      const source = await makeSourceDir("feature-rollback");
      gitStub.removeWorktree.mockRejectedValue(new Error("registration locked"));

      await expect(
        service.trashAndUnregisterWorktree({ dirPath: source, branch: "feature-rollback", reason: "prune" }),
      ).rejects.toThrow("restored the directory to its original path");

      await expect(fs.readFile(path.join(source, "file.txt"), "utf-8")).resolves.toBe("data");
      await expect(fs.readdir(service.getTrashRoot())).resolves.toEqual([]);
    });

    it("reports both unregister and rollback failures in the top-level error message", async () => {
      const source = await makeSourceDir("feature-rollback-fail");
      gitStub.removeWorktree.mockImplementation(async () => {
        await fs.rm(worktreeDir, { recursive: true, force: true });
        throw new Error("registration locked");
      });

      const error = await service
        .trashAndUnregisterWorktree({ dirPath: source, branch: "feature-rollback-fail", reason: "prune" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TrashOperationError);
      expect((error as Error).message).toContain("registration locked");
      expect((error as Error).message).toContain("ENOENT");
    });
  });

  describe("listEntries / summarizeTrashEntries", () => {
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

      const summary = summarizeTrashEntries(entries);
      expect(summary.itemCount).toBe(2);
      expect(summary.totalSizeBytes).toBeGreaterThanOrEqual(0);
      expect(summary.soonestExpiresAt).toBe(
        entries.map((entry) => entry.manifest.expiresAt).sort((a, b) => a.localeCompare(b))[0],
      );
    });

    // A pin ref is what the reaper and restore hand to `git update-ref -d`, so
    // every shape that does not end at this entry's own id has to be refused —
    // otherwise a hand-edited or corrupted manifest picks the delete target.
    it.each([
      { scenario: "a branch ref", pinRef: () => "refs/heads/main" },
      {
        // Padded so the root-hash slice lands on real hex even without the
        // prefix check: the whole string is still a branch ref.
        scenario: "a branch ref padded to the trash prefix's length",
        pinRef: (id: string) => `refs/heads/${"x".repeat(PREFIX.length - "refs/heads/".length)}${HASH}/${id}`,
      },
      { scenario: "a traversal out of the namespace", pinRef: (id: string) => `${PREFIX}../../heads/${id}` },
      { scenario: "a flat ref naming a different entry", pinRef: (id: string) => `${PREFIX}other-${id}` },
      { scenario: "a flat ref naming a longer id", pinRef: (id: string) => `${PREFIX}${id}-extra` },
      { scenario: "a hashed ref naming a different entry", pinRef: (id: string) => `${PREFIX}${HASH}/other-${id}` },
      { scenario: "a hashed ref with a short root hash", pinRef: (id: string) => `${PREFIX}deadbeef/${id}` },
      { scenario: "a hashed ref not joined by a slash", pinRef: (id: string) => `${PREFIX}${HASH}-${id}` },
      { scenario: "a nested path below this entry", pinRef: (id: string) => `${PREFIX}${HASH}/${id}/child` },
      { scenario: "the bare trash prefix", pinRef: () => PREFIX },
      { scenario: "an empty string", pinRef: () => "" },
      { scenario: "a non-string", pinRef: () => 17 },
    ])("rejects a manifest whose pin ref is $scenario", async ({ pinRef }) => {
      const source = await makeSourceDir("bad-pin");
      const entry = await service.trashDirectory({ dirPath: source, branch: "bad-pin", reason: "manual" });
      const manifestPath = path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
      await fs.writeFile(manifestPath, JSON.stringify({ ...entry.manifest, pinRef: pinRef(entry.manifest.id) }));

      const listed = await service.listEntries();

      expect(listed.entries).toEqual([]);
      expect(listed.invalid).toEqual([entry.containerPath]);
    });

    it("rejects a manifest with no pinRef key at all — absence is not the same as an unpinned entry", async () => {
      const source = await makeSourceDir("absent-pin");
      const entry = await service.trashDirectory({ dirPath: source, branch: "absent-pin", reason: "manual" });
      const manifestPath = path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
      const { pinRef: _dropped, ...withoutPinRef } = entry.manifest;
      await fs.writeFile(manifestPath, JSON.stringify(withoutPinRef));

      await expect(service.listEntries()).resolves.toEqual({ entries: [], invalid: [entry.containerPath] });
    });

    // Trash shipped writing flat pin refs (`<prefix><id>`) before they were
    // namespaced per trash root. Refusing that layout stranded every entry made
    // before the upgrade: hidden from the listing, unrestorable, never reaped,
    // and its pin held through every gc forever.
    it("accepts the legacy flat pin ref layout so entries written before the namespacing still list", async () => {
      const source = await makeSourceDir("legacy-flat");
      const entry = await service.trashDirectory({ dirPath: source, branch: "legacy-flat", reason: "prune" });
      const legacyPinRef = `${PREFIX}${entry.manifest.id}`;
      const manifestPath = path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
      await fs.writeFile(manifestPath, JSON.stringify({ ...entry.manifest, pinRef: legacyPinRef }));

      const listed = await service.listEntries();

      expect(listed.invalid).toEqual([]);
      expect(listed.entries.map((candidate) => candidate.manifest.pinRef)).toEqual([legacyPinRef]);
    });

    it("rejects keep-on-reap manifests without a pinned HEAD", async () => {
      const source = await makeSourceDir("missing-keep-pin");
      const entry = await service.trashDirectory({ dirPath: source, branch: "missing-keep-pin", reason: "manual" });
      const manifestPath = path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ ...entry.manifest, keepPinOnReap: true, headOid: null, pinRef: null }),
      );

      await expect(service.listEntries()).resolves.toEqual({ entries: [], invalid: [entry.containerPath] });
    });

    // Restore is the only writer of originalPath, so that is where an escaping
    // destination has to be refused. The entry itself stays listable and
    // reapable — marking it invalid would leak its payload and pin forever.
    it("rejects restore destinations that escape worktreeDir through a symlinked parent", async () => {
      const source = await makeSourceDir("escaped-restore");
      const entry = await service.trashDirectory({ dirPath: source, reason: "manual" });
      const outsideDir = await createTempDirectory();
      const linkedParent = path.join(worktreeDir, "outside-link");
      await fs.symlink(outsideDir, linkedParent);
      const escapedPath = path.join(linkedParent, "restored");
      const manifestPath = path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
      await fs.writeFile(manifestPath, JSON.stringify({ ...entry.manifest, originalPath: escapedPath }));

      await expect(service.restore(entry.manifest.id)).rejects.toThrow(/outside worktreeDir/);
      await expect(fs.access(escapedPath)).rejects.toThrow();

      const listed = await service.listEntries();
      expect(listed.invalid).toEqual([]);
      expect(listed.entries.map((e) => e.manifest.id)).toEqual([entry.manifest.id]);
    });

    // Relocating worktreeDir moves .trash with it. The entries inside are still
    // ours and must keep ageing out — an entry that reads as "invalid" is never
    // reaped and its pin ref is never released, so the disk and the object store
    // both leak permanently.
    it("keeps recognizing its own entries after worktreeDir is relocated", async () => {
      const source = await makeSourceDir("relocated");
      const entry = await service.trashDirectory({ dirPath: source, branch: "relocated", reason: "prune" });

      const movedDir = `${worktreeDir}-moved`;
      await fs.rename(worktreeDir, movedDir);
      // Restore in `finally`: a failed assertion here would otherwise leave the
      // fixture relocated and take the rest of the suite down with it.
      try {
        const movedService = new TrashService(
          { ...config, worktreeDir: movedDir },
          gitStub as unknown as GitService,
          logger,
          audit as unknown as RemovalAuditService,
        );

        const listed = await movedService.listEntries();

        expect(listed.invalid).toEqual([]);
        expect(listed.entries.map((e) => e.manifest.id)).toEqual([entry.manifest.id]);
      } finally {
        await fs.rename(movedDir, worktreeDir);
      }
    });

    it("returns empty results when no trash root exists yet", async () => {
      await expect(service.listEntries()).resolves.toEqual({ entries: [], invalid: [] });
      expect(summarizeTrashEntries([])).toEqual({
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

    it("restores an entry pinned in the legacy flat layout and releases that flat ref", async () => {
      const source = await makeSourceDir("legacy-restore", { "work.txt": "uncommitted work" });
      const { manifest, containerPath } = await service.trashDirectory({
        dirPath: source,
        branch: "legacy-restore",
        reason: "prune",
      });
      const legacyPinRef = `${PREFIX}${manifest.id}`;
      await fs.writeFile(
        path.join(containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME),
        JSON.stringify({ ...manifest, pinRef: legacyPinRef }),
      );
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        await fs.mkdir(args[1] as string, { recursive: true });
      });

      const restored = await service.restore(manifest.id);

      expect(restored.pinRef).toBe(legacyPinRef);
      expect(gitStub.createBranchAt).toHaveBeenCalledWith("legacy-restore", "abc123");
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      expect(gitStub.deleteRef).toHaveBeenCalledWith(legacyPinRef);
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

    // `git branch <name> <sha>` leaves the recreated branch without an
    // upstream. Sync fast-forwards it regardless, but pull/status in the
    // worktree only work once branch.<name>.merge points at origin/<name>.
    it("points the recreated branch at origin/<branch> once the worktree is registered", async () => {
      const source = await makeSourceDir("feature-track", { "work.txt": "data" });
      const { manifest } = await service.trashDirectory({ dirPath: source, branch: "feature-track", reason: "prune" });
      const order: string[] = [];
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        order.push("addWorktreeNoCheckout");
        await fs.mkdir(args[1] as string, { recursive: true });
      });
      gitStub.trackRemoteBranchIfExists.mockImplementation(async () => {
        order.push("trackRemoteBranchIfExists");
        return true;
      });

      await service.restore(manifest.id);

      expect(gitStub.trackRemoteBranchIfExists).toHaveBeenCalledWith("feature-track", source);
      expect(order).toEqual(["addWorktreeNoCheckout", "trackRemoteBranchIfExists"]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("finishes the restore with a warning when the upstream cannot be set", async () => {
      const source = await makeSourceDir("feature-no-upstream", { "work.txt": "data" });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-no-upstream",
        reason: "prune",
      });
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        await fs.mkdir(args[1] as string, { recursive: true });
      });
      gitStub.trackRemoteBranchIfExists.mockRejectedValue(new Error("config locked"));

      const restored = await service.restore(manifest.id);

      expect(restored.branch).toBe("feature-no-upstream");
      expect(gitStub.removeWorktree).not.toHaveBeenCalled();
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("data");
      await expect(service.listEntries()).resolves.toMatchObject({ entries: [] });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not set the upstream of restored 'feature-no-upstream': config locked"),
      );
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

    // A reap that already set the payload aside has committed the entry to
    // deletion. "Payload missing" reads like corruption for a user who can
    // still see the files sitting under the container.
    it("tells a user that a mid-delete entry is finishing, not that its payload went missing", async () => {
      const source = await makeSourceDir("mid-delete");
      const { manifest, containerPath } = await service.trashDirectory({ dirPath: source, reason: "orphan" });
      await fs.rename(
        path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME),
        path.join(containerPath, `${TRASH_CONSTANTS.DELETING_PREFIX}2026-01-01T00-00-00-000Z`),
      );

      await expect(service.restore(manifest.id)).rejects.toThrow(/already being deleted/);
    });

    it("still reports a payload that simply vanished as missing", async () => {
      const source = await makeSourceDir("vanished-payload");
      const { manifest, containerPath } = await service.trashDirectory({ dirPath: source, reason: "orphan" });
      await fs.rm(path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME), { recursive: true, force: true });

      await expect(service.restore(manifest.id)).rejects.toThrow(/payload missing or unverifiable/);
    });

    // A worktree restore copies the payload out instead of moving it, so the
    // cleanup is a real recursive delete over the user's files and takes the
    // reaper's ordering: what it cannot delete must stay a listed entry the
    // reaper will finish, never unrecognized content nothing comes back for.
    it("leaves a restored entry listable when its payload cannot be deleted", async () => {
      const source = await makeSourceDir("feature-cleanup", {
        "work.txt": "uncommitted work",
        "root-built.js": "written by a root container",
      });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-cleanup",
        reason: "prune",
      });
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        await fs.mkdir(args[1] as string, { recursive: true });
      });
      await mockUndeletableFile("root-built.js");

      const restored = await service.restore(manifest.id);

      expect(restored.branch).toBe("feature-cleanup");
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      const { entries, invalid } = await service.listEntries();
      expect(entries.map((entry) => entry.manifest.id)).toEqual([manifest.id]);
      expect(invalid).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to remove restored trash container"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("chattr -i"));
    });

    it("rejects unknown ids", async () => {
      await expect(service.restore("nope")).rejects.toBeInstanceOf(TrashOperationError);
    });
  });
});
