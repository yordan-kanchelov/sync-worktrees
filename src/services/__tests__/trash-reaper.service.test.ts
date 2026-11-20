import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { allowDeletion, mockUndeletableFile } from "../../__tests__/helpers/undeletable-file";
import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TRASH_CONSTANTS } from "../../constants";
import { TrashReaperService } from "../trash-reaper.service";
import { TrashService } from "../trash.service";

import type * as FsPromises from "fs/promises";
import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashEntry, TrashReason } from "../trash.service";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, default: actual, rm: vi.fn(actual.rm), rename: vi.fn(actual.rename) };
});

const DAY_MS = 86_400_000;

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    listRefs: vi.fn<any>().mockResolvedValue([]),
    createBundleFromRef: vi.fn<any>().mockResolvedValue(true),
    countCommitsNotOnAnyRemote: vi.fn<any>().mockResolvedValue(3),
  };
}

describe("TrashReaperService", () => {
  let worktreeDir: string;
  let config: Config;
  let gitStub: ReturnType<typeof makeGitStub>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let logger: Logger;
  let trashService: TrashService;
  let reaper: TrashReaperService;

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
    trashService = new TrashService(
      config,
      gitStub as unknown as GitService,
      logger,
      audit as unknown as RemovalAuditService,
    );
    reaper = new TrashReaperService(
      config,
      trashService,
      logger,
      audit as unknown as RemovalAuditService,
      gitStub as unknown as GitService,
    );
  });

  afterEach(async () => {
    vi.mocked(fs.rm).mockReset();
    vi.mocked(fs.rename).mockReset();
    await cleanupTempDirectories();
  });

  async function makeEntry(
    name: string,
    options: {
      ageDays: number;
      branch?: string;
      keepPinOnReap?: boolean;
      reason?: TrashReason;
      legacyFlatPinRef?: boolean;
    },
  ): Promise<TrashEntry> {
    const dir = path.join(worktreeDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "data");
    const entry = await trashService.trashDirectory({
      dirPath: dir,
      branch: options.branch ?? null,
      headOid: options.branch ? "abc123" : null,
      reason: options.reason ?? "prune",
      keepPinOnReap: options.keepPinOnReap,
    });
    const deletedAt = new Date(Date.now() - options.ageDays * DAY_MS);
    entry.manifest.deletedAt = deletedAt.toISOString();
    entry.manifest.expiresAt = new Date(deletedAt.getTime() + trashService.getRetentionDays() * DAY_MS).toISOString();
    if (options.legacyFlatPinRef) {
      entry.manifest.pinRef = `refs/sync-worktrees/trash/${entry.manifest.id}`;
    }
    await fs.writeFile(path.join(entry.containerPath, "manifest.json"), JSON.stringify(entry.manifest, null, 2));
    return entry;
  }

  function warningsMatching(pattern: RegExp): string[] {
    return vi
      .mocked(logger.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter((message) => pattern.test(message));
  }

  const rootHash = (root: string): string => createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);

  it("deletes only expired entries, each on its own clock, and removes their pin refs", async () => {
    const expired = await makeEntry("expired", { ageDays: 31, branch: "expired" });
    const fresh = await makeEntry("fresh", { ageDays: 5, branch: "fresh" });

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(fresh.containerPath)).resolves.toBeUndefined();
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(fresh.manifest.pinRef);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash_reap", result: "attempt", trashId: expired.manifest.id }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash_reap", result: "success", trashId: expired.manifest.id }),
    );
  });

  it("force-purges fresh entries without creating replacement keep refs", async () => {
    const fresh = await makeEntry("fresh-force-clean", {
      ageDays: 1,
      branch: "fresh-force-clean",
      keepPinOnReap: true,
    });
    const junkDir = path.join(trashService.getTrashRoot(), "not-owned");
    await fs.mkdir(junkDir, { recursive: true });
    await fs.writeFile(path.join(junkDir, "precious.txt"), "keep");
    gitStub.updateRef.mockClear();

    const result = await reaper.purgeAllUnlocked([fresh.manifest.id]);

    expect(result.deleted).toBe(1);
    await expect(fs.access(fresh.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(junkDir, "precious.txt"), "utf-8")).resolves.toBe("keep");
    expect(gitStub.updateRef).not.toHaveBeenCalled();
    expect(gitStub.deleteRef).toHaveBeenCalledWith(fresh.manifest.pinRef);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash_purge", result: "attempt", trashId: fresh.manifest.id }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash_purge", result: "success", trashId: fresh.manifest.id }),
    );
  });

  it("purges only the entries the confirmation named and reports the rest", async () => {
    const shownA = await makeEntry("shown-a", { ageDays: 1, branch: "shown-a" });
    const shownB = await makeEntry("shown-b", { ageDays: 1, branch: "shown-b" });
    const trashedAfterPreview = await makeEntry("unseen-c", { ageDays: 1, branch: "unseen-c", keepPinOnReap: true });
    const alsoTrashedAfterPreview = await makeEntry("unseen-d", { ageDays: 1, branch: "unseen-d" });

    const result = await reaper.purgeAllUnlocked([shownA.manifest.id, shownB.manifest.id]);

    expect(result.deleted).toBe(2);
    expect(result.skippedNotSelected).toBe(2);
    await expect(fs.access(alsoTrashedAfterPreview.containerPath)).resolves.toBeUndefined();
    expect(result.errors).toEqual([]);
    await expect(fs.access(shownA.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(shownB.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(trashedAfterPreview.containerPath)).resolves.toBeUndefined();
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(trashedAfterPreview.manifest.pinRef);
    expect(result.orphanedRefsDeleted).toBe(0);
  });

  it("tolerates named entries that are already gone or half-deleted", async () => {
    const survivor = await makeEntry("still-here", { ageDays: 1, branch: "still-here" });
    const reapedMeanwhile = await makeEntry("gone-already", { ageDays: 1, branch: "gone-already" });
    const halfDeleted = await makeEntry("mid-delete", { ageDays: 1, branch: "mid-delete" });
    await fs.rm(reapedMeanwhile.containerPath, { recursive: true, force: true });
    await fs.rm(path.join(halfDeleted.containerPath, "manifest.json"));

    const result = await reaper.purgeAllUnlocked([
      survivor.manifest.id,
      reapedMeanwhile.manifest.id,
      halfDeleted.manifest.id,
    ]);

    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.skippedNotSelected).toBe(0);
    await expect(fs.access(survivor.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(halfDeleted.payloadPath)).resolves.toBeUndefined();
  });

  it("blocks the delete when the audit attempt cannot be recorded — same gate as the prune flow", async () => {
    const expired = await makeEntry("audit-gated", { ageDays: 31 });
    audit.record.mockRejectedValue(new Error("disk full"));

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot write audit log"));
  });

  it("never deletes unmanifested content — the reaper only touches what the trash pipeline created", async () => {
    const junkDir = path.join(trashService.getTrashRoot(), "manually-placed");
    await fs.mkdir(junkDir, { recursive: true });
    await fs.writeFile(path.join(junkDir, "precious.txt"), "do not delete");

    await reaper.reapExpiredUnlocked();

    await expect(fs.readFile(path.join(junkDir, "precious.txt"), "utf-8")).resolves.toBe("do not delete");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("leaving unrecognized entry"));
  });

  it("removes an invalid container that is empty or holds only *.tmp leftovers, and leaves other manifest-less dirs alone", async () => {
    const root = trashService.getTrashRoot();
    const empty = path.join(root, "crashed-before-manifest");
    const tmpOnly = path.join(root, "crashed-mid-write");
    const kept = path.join(root, "manifest-less-with-content");
    await fs.mkdir(empty, { recursive: true });
    await fs.mkdir(tmpOnly, { recursive: true });
    await fs.writeFile(path.join(tmpOnly, "manifest.json.123.456.tmp"), "{");
    await fs.mkdir(kept, { recursive: true });
    await fs.writeFile(path.join(kept, "payload.txt"), "data");

    const result = await reaper.reapExpiredUnlocked();

    expect(result.errors).toEqual([]);
    await expect(fs.access(empty)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(tmpOnly)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(kept, "payload.txt"), "utf-8")).resolves.toBe("data");
    expect(warningsMatching(/crashed-/)).toEqual([]);
    expect(warningsMatching(/manifest-less-with-content/)).toHaveLength(1);
  });

  it("does not age out entries when trash is disabled — disabling means hands off, not silent cleanup", async () => {
    const expired = await makeEntry("kept-when-disabled", { ageDays: 31 });

    const disabledConfig: Config = { ...config, trash: { enabled: false } };
    const disabledTrash = new TrashService(
      disabledConfig,
      gitStub as unknown as GitService,
      logger,
      audit as unknown as RemovalAuditService,
    );
    const disabledReaper = new TrashReaperService(
      disabledConfig,
      disabledTrash,
      logger,
      audit as unknown as RemovalAuditService,
      gitStub as unknown as GitService,
    );

    await disabledReaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).resolves.toBeUndefined();
    expect(gitStub.listRefs).not.toHaveBeenCalled();
  });

  it("sweeps only own-namespace orphan pin refs, leaving foreign and legacy refs alone", async () => {
    const kept = await makeEntry("kept", { ageDays: 1, branch: "kept" });
    const invalidManifest = await makeEntry("invalid-manifest", { ageDays: 1, branch: "inv" });
    await fs.writeFile(path.join(invalidManifest.containerPath, "manifest.json"), "{not json");
    const ownPrefix = `refs/sync-worktrees/trash/${rootHash(trashService.getTrashRoot())}/`;
    const foreignPrefix = "refs/sync-worktrees/trash/0123456789abcdef/";
    gitStub.listRefs.mockResolvedValue([
      `${ownPrefix}${kept.manifest.id}`,
      `${ownPrefix}${invalidManifest.manifest.id}`,
      `${ownPrefix}gone-entry-id`,
      `${foreignPrefix}foreign-entry-id`,
      "refs/sync-worktrees/trash/legacy-flat-id",
    ]);

    await reaper.reapExpiredUnlocked();

    expect(gitStub.deleteRef).toHaveBeenCalledWith(`${ownPrefix}gone-entry-id`);
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(`${ownPrefix}${kept.manifest.id}`);
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(`${ownPrefix}${invalidManifest.manifest.id}`);
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(`${foreignPrefix}foreign-entry-id`);
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith("refs/sync-worktrees/trash/legacy-flat-id");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("legacy flat trash pin refs"));
  });

  it("reaps a legacy flat-pinned entry and releases its pin through the manifest, leaving unowned flat refs alone", async () => {
    const legacy = await makeEntry("legacy-expired", {
      ageDays: 31,
      branch: "legacy-expired",
      legacyFlatPinRef: true,
    });
    const legacyPinRef = `refs/sync-worktrees/trash/${legacy.manifest.id}`;
    gitStub.listRefs.mockResolvedValue([legacyPinRef, "refs/sync-worktrees/trash/unowned-flat-id"]);

    const result = await reaper.reapExpiredUnlocked();

    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    await expect(fs.access(legacy.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.deleteRef).toHaveBeenCalledWith(legacyPinRef);
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith("refs/sync-worktrees/trash/unowned-flat-id");
    expect(result.orphanedRefsDeleted).toBe(0);
  });

  it("keeps a legacy flat-pinned entry's commits alive when it reaps it", async () => {
    const legacy = await makeEntry("legacy-keep", {
      ageDays: 31,
      branch: "legacy-keep",
      keepPinOnReap: true,
      legacyFlatPinRef: true,
    });
    const legacyPinRef = `refs/sync-worktrees/trash/${legacy.manifest.id}`;

    const result = await reaper.reapExpiredUnlocked();

    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${legacy.manifest.id}`, "abc123");
    expect(gitStub.deleteRef).toHaveBeenCalledWith(legacyPinRef);
  });

  it("warns once per process about unrecognized content and legacy flat refs, and again only when they change", async () => {
    const junkDir = path.join(trashService.getTrashRoot(), "manually-placed");
    const makeJunk = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "keep.txt"), "x");
    };
    await makeJunk(junkDir);
    gitStub.listRefs.mockResolvedValue(["refs/sync-worktrees/trash/legacy-flat-id"]);

    await reaper.reapExpiredUnlocked();
    await reaper.reapExpiredUnlocked();

    expect(warningsMatching(/leaving unrecognized entry/)).toHaveLength(1);
    expect(warningsMatching(/legacy flat trash pin refs/)).toHaveLength(1);

    const secondJunkDir = path.join(trashService.getTrashRoot(), "another-manually-placed");
    await makeJunk(secondJunkDir);
    await reaper.reapExpiredUnlocked();

    expect(warningsMatching(/another-manually-placed/)).toHaveLength(1);
    expect(warningsMatching(/leaving unrecognized entry/)).toHaveLength(2);

    await fs.rm(junkDir, { recursive: true, force: true });
    await reaper.reapExpiredUnlocked();
    await makeJunk(junkDir);
    await reaper.reapExpiredUnlocked();

    expect(warningsMatching(/'.*manually-placed'/)).toHaveLength(3);
  });

  it("protects a pin ref behind any dirent name, even a non-directory — unpinning is irreversible, a ref is cheap", async () => {
    await fs.mkdir(trashService.getTrashRoot(), { recursive: true });
    await fs.writeFile(path.join(trashService.getTrashRoot(), "stray-id"), "not a container");
    gitStub.listRefs.mockResolvedValue(["refs/sync-worktrees/trash/stray-id"]);

    await reaper.reapExpiredUnlocked();

    expect(gitStub.deleteRef).not.toHaveBeenCalled();
  });

  it("leaves all pin refs alone when the trash root is missing — absence is not proof the trash is empty", async () => {
    gitStub.listRefs.mockResolvedValue(["refs/sync-worktrees/trash/orphan-1"]);

    await expect(reaper.reapExpiredUnlocked()).resolves.toMatchObject({ deleted: 0 });

    expect(gitStub.deleteRef).not.toHaveBeenCalled();
  });

  it("warns when retained trash exceeds warnSizeBytes so disk pressure is visible", async () => {
    config.trash = { warnSizeBytes: 1 };
    await makeEntry("big", { ageDays: 1 });
    await trashService.listEntriesWithSizes();

    await reaper.reapExpiredUnlocked();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Trash holds"));
  });

  it("names the entries it could not include in the total instead of silently counting them as zero", async () => {
    config.trash = { warnSizeBytes: 1 };
    await makeEntry("measured", { ageDays: 1 });
    await trashService.listEntriesWithSizes();
    await makeEntry("not-yet-measured", { ageDays: 1 });

    await reaper.reapExpiredUnlocked();

    const warning = warningsMatching(/Trash holds/)[0];
    expect(warning).toContain("plus 1 not yet measured");
    expect(warning).toContain("at least");
  });

  it("says nothing about unmeasured entries when every entry has a size", async () => {
    config.trash = { warnSizeBytes: 1 };
    await makeEntry("measured", { ageDays: 1 });
    await trashService.listEntriesWithSizes();

    await reaper.reapExpiredUnlocked();

    expect(warningsMatching(/Trash holds/)[0]).not.toContain("not yet measured");
  });

  it("moves the pin to a permanent keep ref when reaping a keepPinOnReap entry", async () => {
    const expired = await makeEntry("fully-pushed", { ageDays: 31, branch: "fully-pushed", keepPinOnReap: true });

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${expired.manifest.id}`, "abc123");
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
  });

  it("skips the keep ref when the commits have reached a remote since the worktree was pruned", async () => {
    const expired = await makeEntry("now-on-remote", { ageDays: 31, branch: "now-on-remote", keepPinOnReap: true });
    gitStub.countCommitsNotOnAnyRemote.mockResolvedValue(0);

    await reaper.reapExpiredUnlocked(new Date(), { remoteRefsFresh: true });

    expect(gitStub.countCommitsNotOnAnyRemote).toHaveBeenCalledWith("abc123");
    await expect(fs.access(expired.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.updateRef).not.toHaveBeenCalledWith(
      `refs/sync-worktrees/keep/${expired.manifest.id}`,
      expect.anything(),
    );
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
  });

  it("keeps minting the keep ref while the commits are on no remote", async () => {
    const expired = await makeEntry("still-local", { ageDays: 31, branch: "still-local", keepPinOnReap: true });
    gitStub.countCommitsNotOnAnyRemote.mockResolvedValue(2);

    await reaper.reapExpiredUnlocked(new Date(), { remoteRefsFresh: true });

    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${expired.manifest.id}`, "abc123");
  });

  it("mints the keep ref when the re-check itself fails", async () => {
    const expired = await makeEntry("recheck-fails", { ageDays: 31, branch: "recheck-fails", keepPinOnReap: true });
    gitStub.countCommitsNotOnAnyRemote.mockRejectedValue(new Error("bad object abc123"));

    await reaper.reapExpiredUnlocked(new Date(), { remoteRefsFresh: true });

    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${expired.manifest.id}`, "abc123");
  });

  it("never releases a keep ref when this tick's pruning fetch did not complete", async () => {
    const expired = await makeEntry("stale-refs", { ageDays: 31, branch: "stale-refs", keepPinOnReap: true });
    gitStub.countCommitsNotOnAnyRemote.mockResolvedValue(0);

    await reaper.reapExpiredUnlocked(new Date(), { remoteRefsFresh: false });

    expect(gitStub.countCommitsNotOnAnyRemote).not.toHaveBeenCalled();
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${expired.manifest.id}`, "abc123");
  });

  it("defaults to the unconditional keep ref when the caller says nothing about the remote refs", async () => {
    const expired = await makeEntry("no-opts", { ageDays: 31, branch: "no-opts", keepPinOnReap: true });
    gitStub.countCommitsNotOnAnyRemote.mockResolvedValue(0);

    await reaper.reapExpiredUnlocked();

    expect(gitStub.countCommitsNotOnAnyRemote).not.toHaveBeenCalled();
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${expired.manifest.id}`, "abc123");
  });

  it("defers the whole reap when the keep ref cannot be created — the pin may guard the last copy", async () => {
    const expired = await makeEntry("keep-fails", { ageDays: 31, branch: "keep-fails", keepPinOnReap: true });
    gitStub.updateRef.mockRejectedValue(new Error("ref store readonly"));

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).resolves.toBeUndefined();
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(expired.manifest.pinRef);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("deferring reap"));
  });

  it("mints the keep ref even when the commits look like they reached a remote", async () => {
    const named = await makeEntry("purge-stale-remote", {
      ageDays: 1,
      branch: "purge-stale-remote",
      keepPinOnReap: true,
    });
    gitStub.countCommitsNotOnAnyRemote.mockResolvedValue(0);
    gitStub.updateRef.mockClear();

    const result = await reaper.purgeEntryUnlocked(named.manifest.id);

    expect(result.deleted).toBe(1);
    expect(result.keepRefsMinted).toEqual([`refs/sync-worktrees/keep/${named.manifest.id}`]);
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${named.manifest.id}`, "abc123");
    expect(gitStub.countCommitsNotOnAnyRemote).not.toHaveBeenCalled();
  });

  it("mints the keep ref before it deletes anything when purging one named entry", async () => {
    const named = await makeEntry("purge-one", { ageDays: 1, branch: "purge-one", keepPinOnReap: true });
    const bystander = await makeEntry("untouched", { ageDays: 1, branch: "untouched", keepPinOnReap: true });
    gitStub.updateRef.mockClear();
    vi.mocked(fs.rename).mockClear();

    const result = await reaper.purgeEntryUnlocked(named.manifest.id);

    expect(result.deleted).toBe(1);
    expect(result.keepRefsMinted).toEqual([`refs/sync-worktrees/keep/${named.manifest.id}`]);
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${named.manifest.id}`, "abc123");
    expect(gitStub.updateRef.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fs.rename).mock.invocationCallOrder[0],
    );
    await expect(fs.access(named.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(bystander.containerPath)).resolves.toBeUndefined();
    expect(result.skippedNotSelected).toBe(1);
    expect(gitStub.updateRef).not.toHaveBeenCalledWith(
      `refs/sync-worktrees/keep/${bystander.manifest.id}`,
      expect.anything(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash_purge", result: "attempt", trashId: named.manifest.id }),
    );
  });

  it("deletes nothing when a purged entry's keep ref cannot be created", async () => {
    const named = await makeEntry("purge-keep-fails", {
      ageDays: 1,
      branch: "purge-keep-fails",
      keepPinOnReap: true,
    });
    gitStub.updateRef.mockRejectedValue(new Error("ref store readonly"));

    const result = await reaper.purgeEntryUnlocked(named.manifest.id);

    expect(result.deleted).toBe(0);
    expect(result.keepRefsMinted).toEqual([]);
    await expect(fs.access(named.payloadPath)).resolves.toBeUndefined();
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(named.manifest.pinRef);
    expect(result.errors.join(" ")).toContain("ref store readonly");
  });

  it("purges an ordinary entry without minting a recovery ref", async () => {
    const named = await makeEntry("purge-plain", { ageDays: 1, branch: "purge-plain" });
    gitStub.updateRef.mockClear();

    const result = await reaper.purgeEntryUnlocked(named.manifest.id);

    expect(result.deleted).toBe(1);
    expect(result.keepRefsMinted).toEqual([]);
    expect(gitStub.updateRef).not.toHaveBeenCalled();
    expect(gitStub.deleteRef).toHaveBeenCalledWith(named.manifest.pinRef);
    await expect(fs.access(named.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keep-refs any keepPinOnReap entry regardless of reason, but never ordinary entries", async () => {
    const ordinary = await makeEntry("ordinary", { ageDays: 31, branch: "ordinary" });
    const diverged = await makeEntry("diverged", {
      ageDays: 31,
      branch: "diverged",
      reason: "diverged-replace",
      keepPinOnReap: true,
    });

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(ordinary.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(diverged.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.updateRef).not.toHaveBeenCalledWith(
      `refs/sync-worktrees/keep/${ordinary.manifest.id}`,
      expect.anything(),
    );
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${diverged.manifest.id}`, "abc123");
    expect(gitStub.deleteRef).toHaveBeenCalledWith(ordinary.manifest.pinRef);
    expect(gitStub.deleteRef).toHaveBeenCalledWith(diverged.manifest.pinRef);
  });

  it("orphan pin-ref sweep never touches keep refs", async () => {
    gitStub.listRefs.mockResolvedValue(["refs/sync-worktrees/keep/some-old-id"]);

    await reaper.reapExpiredUnlocked();

    expect(gitStub.deleteRef).not.toHaveBeenCalledWith("refs/sync-worktrees/keep/some-old-id");
  });

  it("leaves the manifest in place when the payload resists deletion, and finishes the entry on the next run", async () => {
    const expired = await makeEntry("stuck", { ageDays: 31, branch: "stuck" });
    await fs.mkdir(path.join(expired.payloadPath, "dist"));
    await fs.writeFile(path.join(expired.payloadPath, "dist", "root-built.js"), "written by a root container");
    await mockUndeletableFile("root-built.js");

    const first = await reaper.reapExpiredUnlocked();

    expect(first.deleted).toBe(0);
    expect(first.errors).toHaveLength(1);
    const afterFailure = await trashService.listEntries();
    expect(afterFailure.entries.map((entry) => entry.manifest.id)).toEqual([expired.manifest.id]);
    expect(afterFailure.invalid).toEqual([]);
    expect(gitStub.deleteRef).not.toHaveBeenCalled();
    expect(warningsMatching(/root-built\.js/)).toHaveLength(1);
    expect(warningsMatching(/chattr -i/)).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "trash_reap", result: "failure", trashId: expired.manifest.id }),
    );

    allowDeletion();
    const second = await reaper.reapExpiredUnlocked();

    expect(second.deleted).toBe(1);
    await expect(fs.access(expired.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
  });

  it("finishes a payload an interrupted run already set aside, without putting the manifest in the delete's path", async () => {
    const expired = await makeEntry("interrupted", { ageDays: 31, branch: "interrupted" });
    const setAside = path.join(expired.containerPath, `${TRASH_CONSTANTS.DELETING_PREFIX}2026-01-01T00-00-00-000Z`);
    await fs.rename(expired.payloadPath, setAside);
    await fs.writeFile(path.join(setAside, "root-built.js"), "written by a root container");
    await mockUndeletableFile("root-built.js");

    const first = await reaper.reapExpiredUnlocked();

    expect(first.deleted).toBe(0);
    const afterFailure = await trashService.listEntries();
    expect(afterFailure.entries.map((entry) => entry.manifest.id)).toEqual([expired.manifest.id]);
    expect(afterFailure.invalid).toEqual([]);

    allowDeletion();
    const second = await reaper.reapExpiredUnlocked();

    expect(second.deleted).toBe(1);
    await expect(fs.access(expired.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
  });

  it("releases the pin once the payload is gone, even when the container itself cannot be deleted", async () => {
    const expired = await makeEntry("refused-container", { ageDays: 31, branch: "refused-container" });
    await mockUndeletableFile(TRASH_CONSTANTS.MANIFEST_FILENAME);

    const result = await reaper.reapExpiredUnlocked();

    expect(result.deleted).toBe(0);
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
    await expect(fs.access(expired.payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
    const { entries, invalid } = await trashService.listEntries();
    expect(entries.map((entry) => entry.manifest.id)).toEqual([expired.manifest.id]);
    expect(invalid).toEqual([]);
    expect(warningsMatching(/manifest\.json/)).toHaveLength(1);
  });

  it("deletes nothing at all when the payload cannot even be set aside", async () => {
    const expired = await makeEntry("locked-payload", { ageDays: 31, branch: "locked-payload" });
    vi.mocked(fs.rename).mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }),
    );

    const result = await reaper.reapExpiredUnlocked();

    expect(result.deleted).toBe(0);
    expect(fs.rm).not.toHaveBeenCalled();
    await expect(fs.access(path.join(expired.payloadPath, "file.txt"))).resolves.toBeUndefined();
    expect(gitStub.deleteRef).not.toHaveBeenCalled();
    expect(warningsMatching(/cannot set the payload/)).toHaveLength(1);
    expect((await trashService.listEntries()).entries).toHaveLength(1);
  });

  it("refuses to report the payload gone when a file blocks the set-aside name", async () => {
    const expired = await makeEntry("blocked-setaside", { ageDays: 31, branch: "blocked-setaside" });
    vi.mocked(fs.rename).mockRejectedValue(
      Object.assign(new Error("ENOTDIR: not a directory, rename"), { code: "ENOTDIR" }),
    );

    const result = await reaper.reapExpiredUnlocked();

    expect(result.deleted).toBe(0);
    await expect(fs.access(path.join(expired.payloadPath, "file.txt"))).resolves.toBeUndefined();
    expect(gitStub.deleteRef).not.toHaveBeenCalled();
    expect(warningsMatching(/cannot set the payload/)).toHaveLength(1);
    expect((await trashService.listEntries()).entries).toHaveLength(1);
  });

  it("skips entries whose expiry is unparseable instead of guessing", async () => {
    const entry = await makeEntry("bad-expiry", { ageDays: 31 });
    const manifestPath = path.join(entry.containerPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    manifest.expiresAt = "not-a-date";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(entry.containerPath)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no valid manifest"));
  });
});
