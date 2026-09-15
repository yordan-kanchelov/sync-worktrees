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

// Real filesystem everywhere except the one path a test declares undeletable:
// an ESM namespace export cannot be spied on, so `rm` is replaceable only by
// way of a partial module mock. `rename` and `cp` go through the same mock as
// pass-through spies — restore moves the payload rather than copying it, which
// is a claim about which of the two ran.
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

/**
 * What `git worktree add --no-checkout` leaves behind: the directory and
 * exactly one entry in it, the `.git` link (measured on git 2.43). Restore
 * reads that link back to re-point the payload it moves into the directory, so
 * a stub that creates the directory alone is not the operation it stands in
 * for. {@link makeGitStub} installs this by default.
 */
async function createFreshWorktreeDir(destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, PATH_CONSTANTS.GIT_DIR), FRESH_GIT_LINK);
}

/**
 * Makes exactly the renames a test names fail, with everything else still
 * going to the real one: the manifest writes and the trash move itself run
 * through `fs.rename` too, and a blanket failure would break the fixture
 * instead of the operation under test. Used for the EXDEV a bind mount or a
 * symlinked worktreeDir puts between the trash root and the worktree, and for
 * the rollback rename that puts a moved payload back.
 */
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

/** Hands `fs.rename` back to the real one. */
function allowRename(): void {
  vi.mocked(fs.rename).mockReset();
}

/** {@link failRenameWhen} for `fs.writeFile`, which restore uses for one thing. */
async function failWriteFileWhen(shouldFail: (target: string) => boolean, code: "EIO"): Promise<void> {
  const realWriteFile = (await vi.importActual<typeof FsPromises>("fs/promises")).writeFile;
  vi.mocked(fs.writeFile).mockImplementation((async (target: string, data: string) => {
    if (shouldFail(String(target))) {
      throw Object.assign(new Error(`${code}: write '${String(target)}'`), { code });
    }
    return realWriteFile(target, data);
  }) as unknown as typeof fs.writeFile);
}

/** Hands `fs.writeFile` back to the real one. */
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
    // Before the cleanup below: it deletes the temp trees with the very fs.rm
    // and fs.rename some of these tests replace.
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

    // `branch` and `headOid` are handed to git positionally by restore —
    // `git branch <branch> <headOid>`, then `git worktree add ... <branch>` —
    // and git's option parser permutes, so an option-shaped value in either
    // slot is read as an option. Measured on git 2.43: in a bare repo whose
    // HEAD is refs/heads/main, `git branch -m <sha>` and `git branch <name> -m`
    // both rename main and take HEAD with it, and every later sync then fails
    // to find the default branch. No real branch name or object id can look
    // like that, so the manifest is the only way in — and it is refused here,
    // before any of it reaches a git wrapper.
    it.each([
      { scenario: "an option", branch: "-m" },
      { scenario: "a long option", branch: "--delete" },
      { scenario: "a range expression", branch: "a..b" },
      { scenario: "a reflog selector", branch: "feature@{1}" },
      { scenario: "a .lock ref", branch: "feature/x.lock" },
      { scenario: "empty", branch: "" },
      // A JSON number, not a string: `isGitCreatableBranchName` throws on it
      // and readManifest's catch would swallow that into the same `null`, so
      // this only pins the typeof guard because the value below is one the
      // predicate itself would otherwise be asked about.
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

    // The control for the rejections above: the identical fixture with a
    // real branch name still lists AND still reaches createBranchAt, so those
    // assertions are about the branch value and not about a restore that never
    // runs in this suite.
    it("still restores the same fixture when the branch is a real name", async () => {
      const source = await makeSourceDir("bad-branch", { "work.txt": "uncommitted work" });
      const entry = await service.trashDirectory({ dirPath: source, branch: "bad-branch", reason: "prune" });

      const listed = await service.listEntries();
      expect(listed.invalid).toEqual([]);
      expect(listed.entries.map((candidate) => candidate.manifest.id)).toEqual([entry.manifest.id]);

      await expect(service.restore(entry.manifest.id)).resolves.toMatchObject({ branch: "bad-branch" });
      expect(gitStub.createBranchAt).toHaveBeenCalledWith("bad-branch", "abc123");
    });

    // The other direction, and the one that costs an entry if it is wrong:
    // these all name branches git itself will happily create, so a check even
    // slightly stricter than git's would quietly make each of them
    // unlistable, unrestorable and unreapable. `@` in particular is accepted
    // by `git branch` and by `git check-ref-format --branch` (measured on git
    // 2.43) even though this tool refuses to create one.
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

    // `headOid` is the start-point of `git branch <branch> <headOid>` and the
    // new value of the reaper's `git update-ref <keepRef> <headOid>`. Measured
    // on git 2.43: `git update-ref <ref> -d` permutes into `update-ref -d
    // <ref>` and DELETES the ref the reaper meant to create, so a keep-on-reap
    // entry would report its commits preserved at a ref that does not exist.
    it.each([
      { scenario: "an option", headOid: "-m" },
      { scenario: "the delete switch", headOid: "-d" },
      { scenario: "a ref name rather than an oid", headOid: "refs/heads/main" },
      { scenario: "not hexadecimal", headOid: "zzzzzz" },
      { scenario: "empty", headOid: "" },
      // 123456 passes the hex regex once stringified, so ONLY the typeof guard
      // rejects it — without that case the guard is untested and a mutant that
      // drops it survives the whole suite.
      { scenario: "a JSON number that is valid hex", headOid: 123456 },
      // The lower bound: git's shortest usable abbreviation is 4, so a
      // three-character oid is not one this tool ever wrote.
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

    // JSON.stringify drops an undefined value, so a key that is simply absent
    // is how a hand-edited manifest loses a field. `null` is a meaningful
    // answer for both of these — "no branch", "no known commit" — and absence
    // must not be read as it: `isWorktreeRestorable` tests `!== null`, so an
    // undefined branch would be carried into `git branch undefined <oid>`.
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

    // Trashing a worktree is one rename; putting it back is one rename too.
    // The alternative is O(payload) under the repository lock: measured on
    // this repository's own node_modules (282 MB, 23k entries) the copy the
    // fresh worktree used to be filled with, plus the delete of the payload it
    // was copied from, took 13s where the rename takes ~2ms.
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
      // The same directory, not a faithful copy of it.
      expect((await fs.stat(source)).ino).toBe(payloadInode);
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      // The link `worktree add --no-checkout` wrote, not the stale one the
      // payload carries from when it was a worktree.
      await expect(fs.readFile(path.join(source, PATH_CONSTANTS.GIT_DIR), "utf-8")).resolves.toBe(FRESH_GIT_LINK);
      await expect(fs.access(payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    // A payload whose own `.git` is a directory rather than a link: the fresh
    // link still has to win, as it did when the copy filtered the payload's
    // `.git` out, and a plain overwrite cannot replace a directory.
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

    // The trash root lives under worktreeDir, so the payload and its
    // destination are normally one filesystem — but a bind mount or a
    // symlinked worktreeDir can still split them, and then the copy is the
    // only way back.
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

    // Once the payload has moved, the recreated worktree holds the only copy
    // of it — and the rollback for a failed restore deletes that directory.
    // The move has to be undone first, or a restore that fails halfway
    // destroys the files it exists to preserve.
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

      // "Left intact" means restorable, not merely present: the retry works.
      const restored = await service.restore(manifest.id);
      expect(restored.branch).toBe("feature-late-fail");
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
    });

    // The link is corrected on the payload BEFORE it moves, so this failure
    // lands while the container still holds everything — the move never
    // starts. That ordering is the point: written afterwards, a crash between
    // the rename and the write stranded a worktree describing itself with a
    // link to a pruned admin dir, and a payload-less trash entry whose retry
    // reported the payload missing.
    it("never starts the move when the payload's .git link cannot be corrected", async () => {
      const source = await makeSourceDir("feature-link-fail", { "work.txt": "uncommitted work" });
      const { manifest, payloadPath } = await service.trashDirectory({
        dirPath: source,
        branch: "feature-link-fail",
        reason: "prune",
      });
      await failWriteFileWhen((target) => target === path.join(payloadPath, PATH_CONSTANTS.GIT_DIR), "EIO");

      await expect(service.restore(manifest.id)).rejects.toThrow(/trash entry left intact/);

      // Nothing moved: the payload is whole and still in the container, which
      // is the entire point of failing here rather than after the rename.
      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
      expect(gitStub.removeWorktree).toHaveBeenCalledWith(source, { force: true });
      allowWriteFile();
      // Real `git worktree remove --force` deletes the registered directory;
      // the stub only records the call, so clear it the way git would before
      // the retry, which refuses a destination that already exists.
      await fs.rm(source, { recursive: true, force: true });
      const restored = await service.restore(manifest.id);
      expect(restored.branch).toBe("feature-link-fail");
      await expect(fs.readFile(path.join(source, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");
    });

    // `movePayloadInto` recursively deletes the destination before renaming
    // the payload over it, and the only thing making that safe is that
    // `worktree add --no-checkout` just created it holding one entry. Today
    // restore() refuses a destination that already exists, so nothing else can
    // put files there — but that invariant lives in another file, and if it
    // ever slips this line becomes a silent recursive delete of live data.
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

    // The fallback is for EXDEV and nothing else. Any other rename failure
    // quietly becoming a copy would trade the O(1) move this whole change
    // exists for back into an O(payload) copy under the repository lock, with
    // no error and nothing in the output to say it happened.
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

    // The cross-device path never reports the payload as moved, because the
    // container still holds it. A later failure must therefore roll back the
    // ordinary way — remove the half-built worktree — rather than try to
    // rename the payload back over itself, which fails ENOTEMPTY and would
    // leave a registered worktree and a stray branch behind for no reason.
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

      // Rolled back the ordinary way, and crucially NOT by renaming the
      // payload back over a container that still holds it — that fails
      // ENOTEMPTY and would leave the worktree registered and the branch
      // behind for nothing.
      expect(gitStub.removeWorktree).toHaveBeenCalledWith(source, { force: true });
      expect(gitStub.deleteLocalBranch).toHaveBeenCalledWith("feature-xdev-late");
      await expect(fs.readFile(path.join(payloadPath, "work.txt"), "utf-8")).resolves.toBe("uncommitted work");

      allowRename();
      await fs.rm(source, { recursive: true, force: true });
      const restored = await service.restore(manifest.id);
      expect(restored.branch).toBe("feature-xdev-late");
    });

    // The one failure that must roll nothing back: with the payload moved and
    // unable to go back, `git worktree remove --force` would delete the user's
    // only copy of it. A half-finished worktree the error explains is the
    // cheaper outcome by far.
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

    // Both ways the payload can come back. The cross-device case is the one
    // that still copies, which is what copyTreePreservingSymlinks exists for;
    // nothing may be asserted until the container is gone, since a link
    // rewritten to a path under `.trash/` still resolves while it is there and
    // would prove nothing.
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
      // An unregistered directory where a synced branch's worktree belongs is
      // what the stale-directory path trashes, so this restore is undone by the
      // next sync unless the person acts. Warning about the shape without
      // warning about the consequence is what made this surprising.
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

    // A worktree restore moves the payload out, so the container it deletes
    // afterwards normally holds nothing but its manifest. The cross-device
    // fallback is the case where that cleanup is still a recursive delete over
    // the user's files, and it takes the reaper's ordering: what it cannot
    // delete must stay a listed entry the reaper will finish, never
    // unrecognized content nothing comes back for.
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

  // Releasing the permanent keep ref a `.diverged/` backup was held by is the
  // one destructive ref operation driven by a field of an unvalidated
  // JSON.parse, so the guards are checked here directly rather than only
  // through the adoption path, which can never present a wrong-shaped entry.
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
      // createBundleFromRef reports nothing to bundle exactly when the commits
      // are already on a remote — the case where the legacy ref protects least.
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
      // legacyOriginalName is `string | null`, so an unguarded template would
      // build 'refs/sync-worktrees/keep/null' and happily match it.
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
