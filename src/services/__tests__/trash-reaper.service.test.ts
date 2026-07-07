import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TrashReaperService } from "../trash-reaper.service";
import { TrashService } from "../trash.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashEntry, TrashReason } from "../trash.service";

const DAY_MS = 86_400_000;

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    listRefs: vi.fn<any>().mockResolvedValue([]),
    createBundleFromRef: vi.fn<any>().mockResolvedValue(true),
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
    await cleanupTempDirectories();
  });

  async function makeEntry(
    name: string,
    options: { ageDays: number; branch?: string; keepPinOnReap?: boolean; reason?: TrashReason },
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
    // trashDirectory always stamps "now"; backdate the manifest on disk to
    // simulate an entry trashed ageDays ago.
    const deletedAt = new Date(Date.now() - options.ageDays * DAY_MS);
    entry.manifest.deletedAt = deletedAt.toISOString();
    entry.manifest.expiresAt = new Date(deletedAt.getTime() + trashService.getRetentionDays() * DAY_MS).toISOString();
    await fs.writeFile(path.join(entry.containerPath, "manifest.json"), JSON.stringify(entry.manifest, null, 2));
    return entry;
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

  it("protects a pin ref behind any dirent name, even a non-directory — unpinning is irreversible, a ref is cheap", async () => {
    await fs.mkdir(trashService.getTrashRoot(), { recursive: true });
    await fs.writeFile(path.join(trashService.getTrashRoot(), "stray-id"), "not a container");
    gitStub.listRefs.mockResolvedValue(["refs/sync-worktrees/trash/stray-id"]);

    await reaper.reapExpiredUnlocked();

    expect(gitStub.deleteRef).not.toHaveBeenCalled();
  });

  it("leaves all pin refs alone when the trash root is missing — absence is not proof the trash is empty", async () => {
    // worktreeDir may be an unmounted volume that sync recreated empty;
    // sweeping pins here would let gc collect objects whose manifests
    // reappear on remount.
    gitStub.listRefs.mockResolvedValue(["refs/sync-worktrees/trash/orphan-1"]);

    await expect(reaper.reapExpiredUnlocked()).resolves.toBeUndefined();

    expect(gitStub.deleteRef).not.toHaveBeenCalled();
  });

  it("warns when retained trash exceeds warnSizeBytes so disk pressure is visible", async () => {
    config.trash = { warnSizeBytes: 1 };
    await makeEntry("big", { ageDays: 1 });

    await reaper.reapExpiredUnlocked();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Trash holds"));
  });

  it("moves the pin to a permanent keep ref when reaping a keepPinOnReap entry", async () => {
    const expired = await makeEntry("fully-pushed", { ageDays: 31, branch: "fully-pushed", keepPinOnReap: true });

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.updateRef).toHaveBeenCalledWith(`refs/sync-worktrees/keep/${expired.manifest.id}`, "abc123");
    expect(gitStub.deleteRef).toHaveBeenCalledWith(expired.manifest.pinRef);
  });

  it("defers the whole reap when the keep ref cannot be created — the pin may guard the last copy", async () => {
    const expired = await makeEntry("keep-fails", { ageDays: 31, branch: "keep-fails", keepPinOnReap: true });
    gitStub.updateRef.mockRejectedValue(new Error("ref store readonly"));

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(expired.containerPath)).resolves.toBeUndefined();
    expect(gitStub.deleteRef).not.toHaveBeenCalledWith(expired.manifest.pinRef);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("deferring reap"));
  });

  it("keep-refs any keepPinOnReap entry regardless of reason, but never ordinary entries", async () => {
    const ordinary = await makeEntry("ordinary", { ageDays: 31, branch: "ordinary" });
    // Diverged removals set keepPinOnReap too — the trashed commits may exist
    // nowhere else, so they must never become gc-eligible silently.
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

  it("skips entries whose expiry is unparseable instead of guessing", async () => {
    const entry = await makeEntry("bad-expiry", { ageDays: 31 });
    const manifestPath = path.join(entry.containerPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    manifest.expiresAt = "not-a-date";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await reaper.reapExpiredUnlocked();

    await expect(fs.access(entry.containerPath)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unparseable expiry"));
  });
});
