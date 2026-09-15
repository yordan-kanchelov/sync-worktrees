import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TrashMigrationService } from "../trash-migration.service";
import { TrashReaperService } from "../trash-reaper.service";
import { TrashService } from "../trash.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    listRefs: vi.fn<any>().mockResolvedValue([]),
    createBundleFromRef: vi.fn<any>().mockResolvedValue(true),
  };
}

describe("TrashMigrationService", () => {
  let worktreeDir: string;
  let config: Config;
  let gitStub: ReturnType<typeof makeGitStub>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let logger: Logger;
  let trashService: TrashService;
  let migration: TrashMigrationService;

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
    migration = new TrashMigrationService(config, trashService, logger);
  });

  afterEach(async () => {
    await cleanupTempDirectories();
  });

  it("adopts .removed/ quarantines: payload preserved, retention restarts at adoption, legacy time kept for forensics", async () => {
    const legacyName = "2026-06-01T10-30-00-500Z-feature-x";
    const legacyDir = path.join(worktreeDir, ".removed", legacyName);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "file.txt"), "quarantined");

    const before = Date.now();
    await migration.migrateLegacyUnlocked();
    const after = Date.now();

    const { entries } = await trashService.listEntries();
    expect(entries).toHaveLength(1);
    const manifest = entries[0].manifest;
    expect(manifest.reason).toBe("legacy-adopt");
    expect(manifest.source).toBe(".removed");
    // Retention counts from adoption, not the legacy quarantine time — the
    // original timestamp is kept only as a forensic field.
    expect(new Date(manifest.deletedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(manifest.deletedAt).getTime()).toBeLessThanOrEqual(after);
    expect(manifest.legacyQuarantinedAt).toBe("2026-06-01T10:30:00.500Z");
    expect(manifest.originalPath).toBe(path.join(worktreeDir, "feature-x"));
    expect(manifest.legacyOriginalName).toBe(legacyName);
    expect(manifest.headOid).toBeNull();
    expect(manifest.keepPinOnReap).toBe(false);
    await expect(fs.readFile(path.join(entries[0].payloadPath, "file.txt"), "utf-8")).resolves.toBe("quarantined");
    // The emptied legacy dir is removed so the migration converges.
    await expect(fs.access(path.join(worktreeDir, ".removed"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "trash_adopt", result: "success" }));
  });

  it("gives a 31-day-old legacy quarantine a full retention window — never expired in the adopting tick", async () => {
    const DAY_MS = 86_400_000;
    const quarantinedAt = new Date(Date.now() - 31 * DAY_MS);
    const legacyName = `${quarantinedAt.toISOString().replace(/[:.]/g, "-")}-feature-old`;
    const legacyDir = path.join(worktreeDir, ".removed", legacyName);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "file.txt"), "still precious");

    await migration.migrateLegacyUnlocked();

    // Backdating deletedAt to the quarantine time would make this entry
    // expired on arrival and a same-tick reap would delete it with zero grace.
    const reaper = new TrashReaperService(
      config,
      trashService,
      logger,
      audit as unknown as RemovalAuditService,
      gitStub as unknown as GitService,
    );
    await reaper.reapExpiredUnlocked();

    const { entries } = await trashService.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].manifest.legacyQuarantinedAt).toBe(quarantinedAt.toISOString());
    await expect(fs.readFile(path.join(entries[0].payloadPath, "file.txt"), "utf-8")).resolves.toBe("still precious");
  });

  it("leaves entries it cannot positively identify — adoption is exact-format only", async () => {
    const unknownDir = path.join(worktreeDir, ".removed", "hand-made-backup");
    await fs.mkdir(unknownDir, { recursive: true });

    await migration.migrateLegacyUnlocked();

    await expect(fs.access(unknownDir)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Leaving unrecognized entry"));
    const { entries } = await trashService.listEntries();
    expect(entries).toHaveLength(0);
  });

  it("adopts .diverged/ backups from their info file, pinning the recorded local commit", async () => {
    const legacyDir = path.join(worktreeDir, ".diverged", "2026-06-02-feat-abc12");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "work.txt"), "diverged work");
    await fs.writeFile(
      path.join(legacyDir, ".diverged-info.json"),
      JSON.stringify({
        originalBranch: "feat",
        divergedAt: "2026-06-02T08:00:00.000Z",
        originalPath: path.join(worktreeDir, "feat"),
        localCommit: "deadbeef",
      }),
    );

    await migration.migrateLegacyUnlocked();

    const { entries } = await trashService.listEntries();
    expect(entries).toHaveLength(1);
    const manifest = entries[0].manifest;
    expect(manifest.branch).toBe("feat");
    expect(manifest.source).toBe(".diverged");
    // Retention counts from adoption, never from the legacy timestamp — a
    // backdated deletedAt would let the reaper delete the entry the same tick.
    expect(new Date(manifest.deletedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(manifest.legacyQuarantinedAt).toBe("2026-06-02T08:00:00.000Z");
    expect(manifest.headOid).toBe("deadbeef");
    expect(gitStub.updateRef).toHaveBeenCalledWith(manifest.pinRef, "deadbeef");
  });

  it("leaves .diverged/ entries without a parseable info file alone", async () => {
    const legacyDir = path.join(worktreeDir, ".diverged", "2026-06-02-mystery-x1y2z");
    await fs.mkdir(legacyDir, { recursive: true });

    await migration.migrateLegacyUnlocked();

    await expect(fs.access(legacyDir)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no parseable"));
  });

  it("leaves .diverged/ entries whose info file lacks an originalPath — adoption must know where restore goes", async () => {
    const legacyDir = path.join(worktreeDir, ".diverged", "2026-06-02-feat-nopath");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, ".diverged-info.json"),
      JSON.stringify({ originalBranch: "feat", divergedAt: "2026-06-02T08:00:00.000Z", localCommit: "deadbeef" }),
    );

    await migration.migrateLegacyUnlocked();

    await expect(fs.access(legacyDir)).resolves.toBeUndefined();
    const { entries } = await trashService.listEntries();
    expect(entries).toHaveLength(0);
  });

  describe("legacy .diverged/ keep refs", () => {
    const NAME = "2026-06-02-feat-abc12";
    const LEGACY_KEEP_REF = `refs/sync-worktrees/keep/${NAME}`;

    async function writeLegacyDiverged(keepRef?: unknown): Promise<string> {
      const legacyDir = path.join(worktreeDir, ".diverged", NAME);
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, "work.txt"), "diverged work");
      await fs.writeFile(
        path.join(legacyDir, ".diverged-info.json"),
        JSON.stringify({
          originalBranch: "feat",
          divergedAt: "2026-06-02T08:00:00.000Z",
          originalPath: path.join(worktreeDir, "feat"),
          localCommit: "deadbeef",
          remoteCommit: "cafe1234",
          ...(keepRef === undefined ? {} : { keepRef }),
          instruction: "3. Discard changes: use the TUI worktree status view so the keep ref is released safely",
        }),
      );
      return legacyDir;
    }

    function deleteRefCalls(ref: string): number {
      return gitStub.deleteRef.mock.calls.filter((args: unknown[]) => args[0] === ref).length;
    }

    it("releases the legacy keep ref, but only after the replacement pin and bundle are in place", async () => {
      await writeLegacyDiverged(LEGACY_KEEP_REF);

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      expect(entries).toHaveLength(1);
      const pinRef = entries[0].manifest.pinRef;
      expect(pinRef).toBeTruthy();

      // Deleted exactly once — not twice, and not left behind for the reaper
      // to shadow with a second permanent keep/<trashId>.
      expect(deleteRefCalls(LEGACY_KEEP_REF)).toBe(1);

      const deleteOrder =
        gitStub.deleteRef.mock.invocationCallOrder[
          gitStub.deleteRef.mock.calls.findIndex((args: unknown[]) => args[0] === LEGACY_KEEP_REF)
        ];
      const pinOrder =
        gitStub.updateRef.mock.invocationCallOrder[
          gitStub.updateRef.mock.calls.findIndex((args: unknown[]) => args[0] === pinRef)
        ];
      // The ref that exists to stop never-pushed commits being collected is
      // released only once something else is holding them.
      expect(pinOrder).toBeLessThan(deleteOrder);
      expect(gitStub.createBundleFromRef.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
      // ...and the manifest that survives a crash already records both.
      expect(entries[0].manifest.bundleFile).toBe("commits.bundle");
    });

    it("leaves the legacy keep ref alone when the adoption's pin ref cannot be created", async () => {
      await writeLegacyDiverged(LEGACY_KEEP_REF);
      gitStub.updateRef.mockRejectedValue(new Error("refs are read-only"));

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      expect(entries).toHaveLength(0);
      expect(deleteRefCalls(LEGACY_KEEP_REF)).toBe(0);
      // The backup — and the ref holding its commits — are both still there.
      await expect(fs.access(path.join(worktreeDir, ".diverged", NAME, "work.txt"))).resolves.toBeUndefined();
    });

    it("leaves the legacy keep ref alone when the adoption's bundle cannot be created", async () => {
      await writeLegacyDiverged(LEGACY_KEEP_REF);
      gitStub.createBundleFromRef.mockRejectedValue(new Error("bundle failed"));

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      expect(entries).toHaveLength(0);
      expect(deleteRefCalls(LEGACY_KEEP_REF)).toBe(0);
      await expect(fs.access(path.join(worktreeDir, ".diverged", NAME, "work.txt"))).resolves.toBeUndefined();
    });

    it.each([
      ["a ref outside the keep namespace", "refs/heads/main"],
      ["a traversal that only shares the keep prefix", `refs/sync-worktrees/keep/${NAME}/../../heads/main`],
      ["another entry's keep ref", "refs/sync-worktrees/keep/2026-06-02-other-zzz99"],
      ["a non-string", 42],
    ])("refuses to delete %s named by the info file", async (_label, keepRef) => {
      await writeLegacyDiverged(keepRef);

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      expect(entries).toHaveLength(1);
      // Nothing outside this entry's own pin ref was ever deleted.
      const pinRef = entries[0].manifest.pinRef;
      for (const [name] of gitStub.deleteRef.mock.calls) expect(name).toBe(pinRef);
      if (typeof keepRef === "string") expect(deleteRefCalls(keepRef)).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("is not the keep ref"));
    });

    it("does nothing and warns nothing when the info file names no keep ref", async () => {
      await writeLegacyDiverged(undefined);

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      expect(entries).toHaveLength(1);
      expect(gitStub.deleteRef).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("is not the keep ref"));
    });

    it("reports a refused keep ref deletion without calling the adoption failed", async () => {
      await writeLegacyDiverged(LEGACY_KEEP_REF);
      gitStub.deleteRef.mockRejectedValue(new Error("ref locked"));

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      expect(entries).toHaveLength(1);
      expect(deleteRefCalls(LEGACY_KEEP_REF)).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not delete its legacy keep ref"));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Failed to adopt"));
      // The ref may still exist, so the payload must keep pointing at it.
      const info = JSON.parse(await fs.readFile(path.join(entries[0].payloadPath, ".diverged-info.json"), "utf-8"));
      expect(info.keepRef).toBe(LEGACY_KEEP_REF);
    });

    it("rewrites the adopted payload's info file onto the trash recovery flow", async () => {
      await writeLegacyDiverged(LEGACY_KEEP_REF);

      await migration.migrateLegacyUnlocked();

      const { entries } = await trashService.listEntries();
      const id = entries[0].manifest.id;
      const info = JSON.parse(await fs.readFile(path.join(entries[0].payloadPath, ".diverged-info.json"), "utf-8"));
      // The released ref is no longer advertised as a way back...
      expect(info.keepRef).toBeNull();
      // ...and the instruction no longer points at a TUI view that lists only
      // `.diverged/` directories, which this payload has left.
      expect(info.instruction).not.toContain("TUI");
      expect(info.instruction).toContain(`sync-worktrees trash --restore ${id}`);
      // An adopted backup is keepPinOnReap: the reaper mints a permanent
      // `keep/<id>` for its never-pushed commits rather than letting expiry
      // collect them, so only the FILES age out. An instruction that says
      // discarding needs nothing done would be the same defect as the TUI one
      // above — a payload describing a flow that does not apply to it.
      expect(info.instruction).not.toContain("nothing to do");
      expect(info.instruction).toContain(`sync-worktrees trash --dropKeepRef ${id}`);
      expect(info.trashId).toBe(id);
      // Everything else the diverge flow recorded is preserved verbatim.
      expect(info.originalBranch).toBe("feat");
      expect(info.localCommit).toBe("deadbeef");
      expect(info.remoteCommit).toBe("cafe1234");
      expect(info.divergedAt).toBe("2026-06-02T08:00:00.000Z");
      // The user's own files are untouched.
      await expect(fs.readFile(path.join(entries[0].payloadPath, "work.txt"), "utf-8")).resolves.toBe("diverged work");
    });
  });

  it("is inert when migrateLegacy is off or trash is disabled", async () => {
    const legacyDir = path.join(worktreeDir, ".removed", "2026-06-01T10-30-00-500Z-feature-x");
    await fs.mkdir(legacyDir, { recursive: true });

    config.trash = { migrateLegacy: false };
    await migration.migrateLegacyUnlocked();
    await expect(fs.access(legacyDir)).resolves.toBeUndefined();

    config.trash = { enabled: false };
    await migration.migrateLegacyUnlocked();
    await expect(fs.access(legacyDir)).resolves.toBeUndefined();
  });
});
