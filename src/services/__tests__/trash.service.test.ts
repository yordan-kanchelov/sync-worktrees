import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { symlinksSupported } from "../../__tests__/helpers/symlink-support";
import { allowDeletion, mockUndeletableFile } from "../../__tests__/helpers/undeletable-file";
import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { GIT_CONSTANTS, PATH_CONSTANTS, TRASH_CONSTANTS } from "../../constants";
import { TrashOperationError } from "../../errors";
import { TrashService, summarizeTrashEntries } from "../trash.service";

import type * as FsPromises from "fs/promises";
import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashEntry, TrashManifest } from "../trash.service";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    default: actual,
    rm: vi.fn(actual.rm),
    rename: vi.fn(actual.rename),
    cp: vi.fn(actual.cp),
    writeFile: vi.fn(actual.writeFile),
  };
});

const DAY_MS = 86_400_000;
const PREFIX = GIT_CONSTANTS.TRASH_REF_PREFIX;
const HASH = "0123456789abcdef";
const FRESH_GIT_LINK = "gitdir: /fresh/admin\n";

async function createFreshWorktreeDir(destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, PATH_CONSTANTS.GIT_DIR), FRESH_GIT_LINK);
}

async function failRenameWhen(
  shouldFail: (from: string, to: string) => boolean,
  code: "EXDEV" | "EPERM",
): Promise<void> {
  const realRename = (await vi.importActual<typeof FsPromises>("fs/promises")).rename;
  vi.mocked(fs.rename).mockImplementation((async (from: string, to: string) => {
    if (shouldFail(String(from), String(to))) {
      throw Object.assign(new Error(`${code}: rename '${String(from)}' -> '${String(to)}'`), { code });
    }
    return realRename(from, to);
  }) as unknown as typeof fs.rename);
}

function allowRename(): void {
  vi.mocked(fs.rename).mockReset();
}

async function failWriteFileWhen(shouldFail: (target: string) => boolean, code: "EIO"): Promise<void> {
  const realWriteFile = (await vi.importActual<typeof FsPromises>("fs/promises")).writeFile;
  vi.mocked(fs.writeFile).mockImplementation((async (target: string, data: string) => {
    if (shouldFail(String(target))) {
      throw Object.assign(new Error(`${code}: write '${String(target)}'`), { code });
    }
    return realWriteFile(target, data);
  }) as unknown as typeof fs.writeFile);
}

function allowWriteFile(): void {
  vi.mocked(fs.writeFile).mockReset();
}

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    getLocalBranchCommit: vi.fn<any>().mockResolvedValue(null),
    createBranchAt: vi.fn<any>().mockResolvedValue(undefined),
    addWorktreeNoCheckout: vi.fn<any>(async (_branch: string, destination: string) =>
      createFreshWorktreeDir(destination),
    ),
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
    allowDeletion();
    allowRename();
    allowWriteFile();
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

    it("warns, rather than staying silent, when the rolled-back pin ref cannot be deleted", async () => {
      gitStub.deleteRef.mockRejectedValueOnce(new Error("ref locked"));
      const missingSource = path.join(worktreeDir, "does-not-exist");

      await expect(
        service.trashDirectory({ dirPath: missingSource, branch: "ghost", reason: "prune" }),
      ).rejects.toBeInstanceOf(TrashOperationError);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/Could not remove the trash pin ref '.*': ref locked/),
      );
    });

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
      gitStub.getCurrentCommit.mockResolvedValueOnce("abc123").mockResolvedValueOnce("def456");
      const source = await makeSourceDir("racing-commit");

      await expect(
        service.trashDirectory({ dirPath: source, branch: "racing-commit", reason: "prune" }),
      ).rejects.toBeInstanceOf(TrashOperationError);

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

    it("keeps a keep-on-reap entry listable while its bundle is still being created", async () => {
      let releaseBundle!: () => void;
      let bundleStarted!: () => void;
      const started = new Promise<void>((resolve) => (bundleStarted = resolve));
      const bundleGate = new Promise<boolean>((resolve) => (releaseBundle = () => resolve(true)));
      const stub = gitStub as ReturnType<typeof makeGitStub> & { createBundleFromRef: ReturnType<typeof vi.fn> };
      stub.createBundleFromRef = vi.fn<any>(() => {
        bundleStarted();
        return bundleGate;
      });
      const source = await makeSourceDir("keep-mid-bundle");

      const pending = service.trashDirectory({
        dirPath: source,
        branch: "keep-mid-bundle",
        reason: "manual",
        keepPinOnReap: true,
      });
      await started;

      const fresh = new TrashService(
        config,
        gitStub as unknown as GitService,
        logger,
        audit as unknown as RemovalAuditService,
      );
      const { entries, invalid } = await fresh.listEntries();
      expect(invalid).toEqual([]);
      expect(entries).toHaveLength(1);
      expect(entries[0].manifest.branch).toBe("keep-mid-bundle");

      releaseBundle();
      const entry = await pending;
      expect(entry.manifest.keepPinOnReap).toBe(true);
      expect(entry.manifest.bundleFile).toBe(TRASH_CONSTANTS.BUNDLE_FILENAME);
      const onDisk = JSON.parse(
        await fs.readFile(path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf-8"),
      );
      expect(onDisk.keepPinOnReap).toBe(true);
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
      expect(gitStub.deleteLocalBranchIfAt).toHaveBeenCalledWith("feature-seq", "abc123");
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      expect(gitStub.removeWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        gitStub.deleteLocalBranchIfAt.mock.invocationCallOrder[0],
      );
    });

    it("keeps the branch ref (leftover warning) when it moved between HEAD verification and deletion", async () => {
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
      const source = await makeSourceDir("feature-rollback", { "file.txt": "data", ".git": "gitdir: /x\n" });
      gitStub.removeWorktree.mockRejectedValue(new Error("registration locked"));

      await expect(
        service.trashAndUnregisterWorktree({ dirPath: source, branch: "feature-rollback", reason: "prune" }),
      ).rejects.toThrow("restored the directory to its original path");

      await expect(fs.readFile(path.join(source, "file.txt"), "utf-8")).resolves.toBe("data");
      await expect(fs.readFile(path.join(source, ".git"), "utf-8")).resolves.toBe("gitdir: /x\n");
      await expect(fs.access(path.join(source, ".git.detached"))).rejects.toMatchObject({ code: "ENOENT" });
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
    });

    it.each([
      { scenario: "a branch ref", pinRef: () => "refs/heads/main" },
      {
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

    it.each([
      { scenario: "an option", branch: "-m" },
      { scenario: "a long option", branch: "--delete" },
      { scenario: "a range expression", branch: "a..b" },
      { scenario: "a reflog selector", branch: "feature@{1}" },
      { scenario: "a .lock ref", branch: "feature/x.lock" },
      { scenario: "empty", branch: "" },
      { scenario: "a non-string", branch: 17 },
      { scenario: "a number that would read as a valid name", branch: 123456 },
    ])("rejects a manifest whose branch is $scenario, and never restores it", async ({ branch }) => {
      const source = await makeSourceDir("bad-branch", { "work.txt": "uncommitted work" });
      const entry = await service.trashDirectory({ dirPath: source, branch: "bad-branch", reason: "prune" });
      await fs.writeFile(
        path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME),
        JSON.stringify({ ...entry.manifest, branch }),
      );

      const listed = await service.listEntries();
      expect(listed.entries).toEqual([]);
      expect(listed.invalid).toEqual([entry.containerPath]);

      await expect(service.restore(entry.manifest.id)).rejects.toThrow(/no trash entry with id/);
      expect(gitStub.createBranchAt).not.toHaveBeenCalled();
      expect(gitStub.addWorktreeNoCheckout).not.toHaveBeenCalled();
    });

    it("still restores the same fixture when the branch is a real name", async () => {
      const source = await makeSourceDir("bad-branch", { "work.txt": "uncommitted work" });
      const entry = await service.trashDirectory({ dirPath: source, branch: "bad-branch", reason: "prune" });

      const listed = await service.listEntries();
      expect(listed.invalid).toEqual([]);
      expect(listed.entries.map((candidate) => candidate.manifest.id)).toEqual([entry.manifest.id]);

      await expect(service.restore(entry.manifest.id)).resolves.toMatchObject({ branch: "bad-branch" });
      expect(gitStub.createBranchAt).toHaveBeenCalledWith("bad-branch", "abc123");
    });

    it.each([
      { scenario: "a slashed name with a dot", branch: "feature/x.y" },
      { scenario: "a dotted release name", branch: "release-1.0" },
      { scenario: "a deeply nested name", branch: "team/area/sub/thing" },
      { scenario: "a non-ASCII name", branch: "fonctionnalité/日本語" },
      { scenario: "a name ending in a dash", branch: "wip-" },
      { scenario: "a name that merely contains .lock", branch: "feature/x.lock.y" },
      { scenario: "a very long name", branch: `feature/${"x".repeat(300)}` },
      { scenario: "the bare at-sign git allows", branch: "@" },
    ])("keeps listing an entry whose branch is $scenario", async ({ branch }) => {
      const source = await makeSourceDir("valid-branch");
      const entry = await service.trashDirectory({ dirPath: source, branch: "valid-branch", reason: "prune" });
      await fs.writeFile(
        path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME),
        JSON.stringify({ ...entry.manifest, branch }),
      );

      const listed = await service.listEntries();

      expect(listed.invalid).toEqual([]);
      expect(listed.entries.map((candidate) => candidate.manifest.branch)).toEqual([branch]);
    });

    it.each([
      { scenario: "an option", headOid: "-m" },
      { scenario: "the delete switch", headOid: "-d" },
      { scenario: "a ref name rather than an oid", headOid: "refs/heads/main" },
      { scenario: "not hexadecimal", headOid: "zzzzzz" },
      { scenario: "empty", headOid: "" },
      { scenario: "a JSON number that is valid hex", headOid: 123456 },
      { scenario: "shorter than the minimum abbreviation", headOid: "abc" },
      { scenario: "a non-string", headOid: 17 },
    ])("rejects a manifest whose headOid is $scenario", async ({ headOid }) => {
      const source = await makeSourceDir("bad-oid");
      const entry = await service.trashDirectory({ dirPath: source, branch: "bad-oid", reason: "prune" });
      await fs.writeFile(
        path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME),
        JSON.stringify({ ...entry.manifest, headOid }),
      );

      const listed = await service.listEntries();

      expect(listed.entries).toEqual([]);
      expect(listed.invalid).toEqual([entry.containerPath]);
    });

    it("keeps listing an entry whose headOid is a full-length object id", async () => {
      const source = await makeSourceDir("good-oid");
      const entry = await service.trashDirectory({ dirPath: source, branch: "good-oid", reason: "prune" });
      const fullOid = "a1b2c3d4".repeat(5);
      await fs.writeFile(
        path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME),
        JSON.stringify({ ...entry.manifest, headOid: fullOid }),
      );

      const listed = await service.listEntries();

      expect(listed.invalid).toEqual([]);
      expect(listed.entries.map((candidate) => candidate.manifest.headOid)).toEqual([fullOid]);
    });

    it.each(["branch", "headOid"])("rejects a manifest with no %s key at all — absence is not null", async (field) => {
      const source = await makeSourceDir("absent-field");
      const entry = await service.trashDirectory({ dirPath: source, branch: "absent-field", reason: "prune" });
      const withoutField: Record<string, unknown> = { ...entry.manifest };
      delete withoutField[field];
      await fs.writeFile(
        path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME),
        JSON.stringify(withoutField),
      );

      await expect(service.listEntries()).resolves.toEqual({ entries: [], invalid: [entry.containerPath] });
      await expect(service.restore(entry.manifest.id)).rejects.toThrow(/no trash entry with id/);
      expect(gitStub.createBranchAt).not.toHaveBeenCalled();
    });

    it("rejects a manifest with no pinRef key at all — absence is not the same as an unpinned entry", async () => {
      const source = await makeSourceDir("absent-pin");
      const entry = await service.trashDirectory({ dirPath: source, branch: "absent-pin", reason: "manual" });
      const manifestPath = path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME);
      const { pinRef: _dropped, ...withoutPinRef } = entry.manifest;
      await fs.writeFile(manifestPath, JSON.stringify(withoutPinRef));

      await expect(service.listEntries()).resolves.toEqual({ entries: [], invalid: [entry.containerPath] });
    });

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

    it.each(["bundleFile", "legacyQuarantinedAt", "keepPinOnReap"])(
      "keeps listing an entry whose manifest predates the %s field",
      async (field) => {
        const source = await makeSourceDir("pre-upgrade");
        const entry = await service.trashDirectory({ dirPath: source, branch: "pre-upgrade", reason: "prune" });
        const older: Record<string, unknown> = { ...entry.manifest };
        expect(field in older).toBe(true);
        delete older[field];
        await fs.writeFile(path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), JSON.stringify(older));

        const listed = await service.listEntries();

        expect(listed.invalid).toEqual([]);
        expect(listed.entries.map((candidate) => candidate.manifest.id)).toEqual([entry.manifest.id]);
      },
    );

    it("restores a manifest written before the pin namespacing and the optional fields existed", async () => {
      const source = await makeSourceDir("pre-upgrade-restore", { "work.txt": "uncommitted work" });
      const entry = await service.trashDirectory({
        dirPath: source,
        branch: "pre-upgrade-restore",
        reason: "prune",
      });
      const legacyPinRef = `${PREFIX}${entry.manifest.id}`;
      const older: Record<string, unknown> = { ...entry.manifest, pinRef: legacyPinRef, replacedAt: null };
      for (const field of ["bundleFile", "legacyQuarantinedAt", "keepPinOnReap", "replacedAt"]) {
        expect(field in older).toBe(true);
        delete older[field];
      }
      await fs.writeFile(path.join(entry.containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), JSON.stringify(older));

      const listed = await service.listEntries();
      expect(listed.invalid).toEqual([]);
      expect(listed.entries[0].manifest).toMatchObject({
        id: entry.manifest.id,
        branch: "pre-upgrade-restore",
        pinRef: legacyPinRef,
      });

      const restored = await service.restore(entry.manifest.id);

      expect(restored.pinRef).toBe(legacyPinRef);
      expect(gitStub.createBranchAt).toHaveBeenCalledWith("pre-upgrade-restore", "abc123");
      expect(gitStub.addWorktreeNoCheckout).toHaveBeenCalledWith("pre-upgrade-restore", source);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      expect(gitStub.deleteRef).toHaveBeenCalledWith(legacyPinRef);
      await expect(service.listEntries()).resolves.toMatchObject({ entries: [], invalid: [] });
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

    it("keeps recognizing its own entries after worktreeDir is relocated", async () => {
      const source = await makeSourceDir("relocated");
      const entry = await service.trashDirectory({ dirPath: source, branch: "relocated", reason: "prune" });

      const movedDir = `${worktreeDir}-moved`;
      await fs.rename(worktreeDir, movedDir);
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

      const restored = await service.restore(manifest.id);

      expect(gitStub.createBranchAt).toHaveBeenCalledWith("feature-y", "abc123");
      expect(gitStub.addWorktreeNoCheckout).toHaveBeenCalledWith("feature-y", source);
      expect(gitStub.resetWorktreeIndex).toHaveBeenCalledWith(source);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.readFile(path.join(source, ".git"), "utf-8")).resolves.toBe(FRESH_GIT_LINK);
      expect(gitStub.deleteRef).toHaveBeenCalledWith(manifest.pinRef);
      expect(restored.branch).toBe("feature-y");
      await expect(service.listEntries()).resolves.toMatchObject({ entries: [] });
    });

    it("moves the payload into the recreated worktree instead of copying it", async () => {
      const source = await makeSourceDir("feature-move", {
        "work.txt": "uncommitted work",
        ".git": "gitdir: /stale/pruned/admin",
      });
      const { manifest, containerPath, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-move",
        reason: "prune",
      });
      const payloadInode = (await fs.stat(payloadPath)).ino;

      await service.restore(manifest.id);

      expect(fs.rename).toHaveBeenCalledWith(payloadPath, source);
      expect(fs.cp).not.toHaveBeenCalled();
      expect((await fs.stat(source)).ino).toBe(payloadInode);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.readFile(path.join(source, PATH_CONSTANTS.GIT_DIR), "utf-8")).resolves.toBe(FRESH_GIT_LINK);
      await expect(fs.access(payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("replaces a payload's .git directory with the link the fresh registration wrote", async () => {
      const source = await makeSourceDir("feature-gitdir", { "work.txt": "uncommitted work" });
      await fs.mkdir(path.join(source, PATH_CONSTANTS.GIT_DIR));
      await fs.writeFile(path.join(source, PATH_CONSTANTS.GIT_DIR, "HEAD"), "ref: refs/heads/feature-gitdir\n");
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-gitdir",
        reason: "prune",
      });

      const restored = await service.restore(manifest.id);

      expect(restored.branch).toBe("feature-gitdir");
      await expect(fs.readFile(path.join(source, PATH_CONSTANTS.GIT_DIR), "utf-8")).resolves.toBe(FRESH_GIT_LINK);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
    });

    it("falls back to copying the payload when the rename crosses a device boundary", async () => {
      const source = await makeSourceDir("feature-exdev", {
        "work.txt": "uncommitted work",
        ".git": "gitdir: /stale/pruned/admin",
      });
      const { manifest, containerPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-exdev",
        reason: "prune",
      });
      await failRenameWhen((_from, to) => to === source, "EXDEV");

      const restored = await service.restore(manifest.id);

      expect(restored.branch).toBe("feature-exdev");
      expect(fs.cp).toHaveBeenCalled();
      expect(gitStub.resetWorktreeIndex).toHaveBeenCalledWith(source);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.readFile(path.join(source, PATH_CONSTANTS.GIT_DIR), "utf-8")).resolves.toBe(FRESH_GIT_LINK);
      await expect(fs.access(containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("returns a moved payload to the container when a later step fails, leaving the entry restorable", async () => {
      const source = await makeSourceDir("feature-late-fail", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-late-fail",
        reason: "prune",
      });
      gitStub.resetWorktreeIndex.mockRejectedValueOnce(new Error("index.lock exists"));

      await expect(service.restore(manifest.id)).rejects.toThrow(/trash entry left intact/);

      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(gitStub.removeWorktree).toHaveBeenCalledWith(source, { force: true });
      expect(gitStub.deleteLocalBranch).toHaveBeenCalledWith("feature-late-fail");

      const restored = await service.restore(manifest.id);
      expect(restored.branch).toBe("feature-late-fail");
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
    });

    it("never starts the move when the payload's .git link cannot be corrected", async () => {
      const source = await makeSourceDir("feature-link-fail", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-link-fail",
        reason: "prune",
      });
      await failWriteFileWhen((target) => target === path.join(payloadPath, PATH_CONSTANTS.GIT_DIR), "EIO");

      await expect(service.restore(manifest.id)).rejects.toThrow(/trash entry left intact/);

      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      expect(gitStub.removeWorktree).toHaveBeenCalledWith(source, { force: true });
      allowWriteFile();
      await fs.rm(source, { recursive: true, force: true });
      const restored = await service.restore(manifest.id);
      expect(restored.branch).toBe("feature-link-fail");
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
    });

    it("refuses to replace a destination holding anything but the link git just wrote", async () => {
      const source = await makeSourceDir("feature-occupied", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-occupied",
        reason: "prune",
      });
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        const dirPath = args[1] as string;
        await createFreshWorktreeDir(dirPath);
        await fs.writeFile(path.join(dirPath, "someone-elses-work.txt"), "do not delete me");
      });

      await expect(service.restore(manifest.id)).rejects.toThrow(/refusing to replace/);

      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.readFile(path.join(source, "someone-elses-work.txt"), "utf-8")).resolves.toBe("do not delete me");
    });

    it("propagates a non-EXDEV rename failure instead of copying the payload instead", async () => {
      const source = await makeSourceDir("feature-eperm", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-eperm",
        reason: "prune",
      });
      await failRenameWhen((from) => from === payloadPath, "EPERM");

      await expect(service.restore(manifest.id)).rejects.toThrow(/trash entry left intact/);

      expect(fs.cp).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      allowRename();
      await fs.rm(source, { recursive: true, force: true });
      await expect(service.restore(manifest.id)).resolves.toMatchObject({ branch: "feature-eperm" });
    });

    it("rolls back normally when a cross-device restore fails after the copy", async () => {
      const source = await makeSourceDir("feature-xdev-late", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-xdev-late",
        reason: "prune",
      });
      await failRenameWhen((_from, to) => to === source, "EXDEV");
      gitStub.resetWorktreeIndex.mockRejectedValueOnce(new Error("index.lock exists"));

      await expect(service.restore(manifest.id)).rejects.toThrow(/trash entry left intact/);

      expect(gitStub.removeWorktree).toHaveBeenCalledWith(source, { force: true });
      expect(gitStub.deleteLocalBranch).toHaveBeenCalledWith("feature-xdev-late");
      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");

      allowRename();
      await fs.rm(source, { recursive: true, force: true });
      const restored = await service.restore(manifest.id);
      expect(restored.branch).toBe("feature-xdev-late");
    });

    it("never removes the directory when a moved payload cannot be put back", async () => {
      const source = await makeSourceDir("feature-stuck", { "work.txt": "uncommitted work" });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-stuck",
        reason: "prune",
      });
      gitStub.resetWorktreeIndex.mockRejectedValue(new Error("index.lock exists"));
      await failRenameWhen((from) => from === source, "EPERM");

      await expect(service.restore(manifest.id)).rejects.toThrow(/finish by hand/);

      expect(gitStub.removeWorktree).not.toHaveBeenCalled();
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      await expect(fs.readFile(path.join(source, PATH_CONSTANTS.GIT_DIR), "utf-8")).resolves.toBe(FRESH_GIT_LINK);
    });

    for (const { device, crossDevice } of [
      { device: "the same", crossDevice: false },
      { device: "another", crossDevice: true },
    ]) {
      it(`restores relative symlinks intact from ${device} device, resolvable after the container is deleted`, async (ctx) => {
        if (!(await symlinksSupported())) {
          ctx.skip("this host cannot create symlinks");
          return;
        }
        const source = await makeSourceDir("feature-links", { "work.txt": "uncommitted work" });
        const binDir = path.join(source, "node_modules", ".bin");
        await fs.mkdir(binDir, { recursive: true });
        await fs.mkdir(path.join(source, "node_modules", "pkg"), { recursive: true });
        await fs.writeFile(path.join(source, "node_modules", "pkg", "cli.js"), "#!/usr/bin/env node\n");
        await fs.symlink(path.join("..", "pkg", "cli.js"), path.join(binDir, "tool"));
        const { manifest, containerPath } = await service.trashDirectory({
          dirPath: source,
          branch: "feature-links",
          reason: "prune",
        });
        if (crossDevice) {
          await failRenameWhen((_from, to) => to === source, "EXDEV");
        }

        await service.restore(manifest.id);

        expect(fs.cp).toHaveBeenCalledTimes(crossDevice ? 1 : 0);
        await expect(fs.access(containerPath)).rejects.toMatchObject({ code: "ENOENT" });
        const restoredLink = path.join(source, "node_modules", ".bin", "tool");
        await expect(fs.readlink(restoredLink)).resolves.toBe(path.join("..", "pkg", "cli.js"));
        await expect(fs.readFile(restoredLink, "utf-8")).resolves.toBe("#!/usr/bin/env node\n");
      });
    }

    it("reuses a matching branch ref left behind by git worktree remove", async () => {
      const source = await makeSourceDir("feature-left-ref", { "work.txt": "preserved" });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-left-ref",
        reason: "prune",
      });
      gitStub.getLocalBranchCommit.mockResolvedValue("abc123");

      await service.restore(manifest.id);

      expect(gitStub.createBranchAt).not.toHaveBeenCalled();
      expect(gitStub.addWorktreeNoCheckout).toHaveBeenCalledWith("feature-left-ref", source);
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("preserved");
    });

    it("points the recreated branch at origin/<branch> once the worktree is registered", async () => {
      const source = await makeSourceDir("feature-track", { "work.txt": "data" });
      const { manifest } = await service.trashDirectory({ dirPath: source, branch: "feature-track", reason: "prune" });
      const order: string[] = [];
      gitStub.addWorktreeNoCheckout.mockImplementation(async (...args: unknown[]) => {
        order.push("addWorktreeNoCheckout");
        await createFreshWorktreeDir(args[1] as string);
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

    it("warns that the next sync prunes the restore again when origin/<branch> is gone", async () => {
      const source = await makeSourceDir("feature-gone", { "work.txt": "data" });
      const { manifest } = await service.trashDirectory({ dirPath: source, branch: "feature-gone", reason: "prune" });
      gitStub.trackRemoteBranchIfExists.mockResolvedValue(false);

      await service.restore(manifest.id);

      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("data");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("if origin/feature-gone is gone"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("next sync will prune it again"));
    });

    it("finishes the restore with a warning when the upstream cannot be set", async () => {
      const source = await makeSourceDir("feature-no-upstream", { "work.txt": "data" });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-no-upstream",
        reason: "prune",
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
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("moves it back to trash as a new 'orphan' entry"),
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("pinless"));
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
      expect(gitStub.deleteRef).not.toHaveBeenCalledWith(manifest.pinRef);
    });

    it("wraps a refused branch creation in TrashOperationError and keeps the payload", async () => {
      const source = await makeSourceDir("topic", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "topic",
        reason: "prune",
      });
      gitStub.createBranchAt.mockRejectedValue(new Error("cannot lock ref 'refs/heads/topic'"));

      const error = await service.restore(manifest.id).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TrashOperationError);
      expect((error as Error).message).toMatch(/cannot lock ref/);
      expect(gitStub.addWorktreeNoCheckout).not.toHaveBeenCalled();
      expect(gitStub.deleteLocalBranch).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      const { entries } = await service.listEntries();
      expect(entries).toHaveLength(1);
    });

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

    it("leaves a restored entry listable when a copied-out payload cannot be deleted", async () => {
      const source = await makeSourceDir("feature-cleanup", {
        "work.txt": "uncommitted work",
        "root-built.js": "written by a root container",
      });
      const { manifest } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-cleanup",
        reason: "prune",
      });
      await failRenameWhen((_from, to) => to === source, "EXDEV");
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

  describe("releaseAdoptedKeepRef", () => {
    const LEGACY_NAME = "2026-06-02-feat-abc12";
    const LEGACY_KEEP_REF = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${LEGACY_NAME}`;

    function adoptedEntry(overrides: Partial<TrashManifest> = {}): TrashEntry {
      return {
        manifest: {
          schemaVersion: TRASH_CONSTANTS.SCHEMA_VERSION,
          id: "2026-09-01T00-00-00-000Z-feat-abc12-aa11bb",
          deletedAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z",
          originalPath: path.join(worktreeDir, "feat"),
          branch: "feat",
          reason: "legacy-adopt",
          sizeBytes: null,
          headOid: "deadbeef",
          pinRef: `${PREFIX}${HASH}/2026-09-01T00-00-00-000Z-feat-abc12-aa11bb`,
          bundleFile: TRASH_CONSTANTS.BUNDLE_FILENAME,
          source: ".diverged",
          legacyOriginalName: LEGACY_NAME,
          legacyQuarantinedAt: "2026-06-02T08:00:00.000Z",
          keepPinOnReap: true,
          ...overrides,
        },
        containerPath: path.join(worktreeDir, ".trash", "container"),
        payloadPath: path.join(worktreeDir, ".trash", "container", "payload"),
      };
    }

    it("releases the ref the entry's own legacy name derives", async () => {
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(), LEGACY_KEEP_REF)).resolves.toBe("released");
      expect(gitStub.deleteRef).toHaveBeenCalledExactlyOnceWith(LEGACY_KEEP_REF);
    });

    it("reports nothing to do when the info file named no ref", async () => {
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(), undefined)).resolves.toBe("absent");
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(), null)).resolves.toBe("absent");
      expect(gitStub.deleteRef).not.toHaveBeenCalled();
    });

    it("releases a fully-pushed adoption that had nothing to bundle", async () => {
      await expect(service.releaseAdoptedKeepRef(adoptedEntry({ bundleFile: null }), LEGACY_KEEP_REF)).resolves.toBe(
        "released",
      );
    });

    it.each([
      ["the entry never adopted a .diverged backup", { source: "worktree" as const }],
      ["the entry is not pinned for keep-on-reap", { keepPinOnReap: false }],
      ["the entry holds no pin ref of its own", { pinRef: null }],
      ["the entry has no legacy name to derive the ref from", { legacyOriginalName: null }],
    ])("refuses when %s", async (_label, overrides) => {
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(overrides), LEGACY_KEEP_REF)).resolves.toBe("rejected");
      expect(gitStub.deleteRef).not.toHaveBeenCalled();
    });

    it("never derives a ref from a missing legacy name", async () => {
      await expect(
        service.releaseAdoptedKeepRef(
          adoptedEntry({ legacyOriginalName: null }),
          `${GIT_CONSTANTS.KEEP_REF_PREFIX}null`,
        ),
      ).resolves.toBe("rejected");
      expect(gitStub.deleteRef).not.toHaveBeenCalled();
    });

    it.each([
      "refs/heads/main",
      `${GIT_CONSTANTS.KEEP_REF_PREFIX}${LEGACY_NAME}/../../heads/main`,
      `${GIT_CONSTANTS.KEEP_REF_PREFIX}${LEGACY_NAME}-other`,
      GIT_CONSTANTS.KEEP_REF_PREFIX,
    ])("refuses '%s', which is not this entry's keep ref", async (candidate) => {
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(), candidate)).resolves.toBe("rejected");
      expect(gitStub.deleteRef).not.toHaveBeenCalled();
    });

    it("refuses a non-string keepRef", async () => {
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(), { toString: () => LEGACY_KEEP_REF })).resolves.toBe(
        "rejected",
      );
      expect(gitStub.deleteRef).not.toHaveBeenCalled();
    });

    it("propagates a refused deletion instead of reporting a release", async () => {
      gitStub.deleteRef.mockRejectedValue(new Error("ref locked"));
      await expect(service.releaseAdoptedKeepRef(adoptedEntry(), LEGACY_KEEP_REF)).rejects.toThrow("ref locked");
    });
  });
});
