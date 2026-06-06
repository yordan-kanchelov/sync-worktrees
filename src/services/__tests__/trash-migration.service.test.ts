import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TrashMigrationService } from "../trash-migration.service";
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

  it("adopts .removed/ quarantines: payload preserved, deletion time parsed from the dirname, original path reconstructed", async () => {
    const legacyName = "2026-06-01T10-30-00-500Z-feature-x";
    const legacyDir = path.join(worktreeDir, ".removed", legacyName);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "file.txt"), "quarantined");

    await migration.migrateLegacyUnlocked();

    const { entries } = await trashService.listEntries();
    expect(entries).toHaveLength(1);
    const manifest = entries[0].manifest;
    expect(manifest.reason).toBe("legacy-adopt");
    expect(manifest.source).toBe(".removed");
    expect(manifest.deletedAt).toBe("2026-06-01T10:30:00.500Z");
    expect(manifest.originalPath).toBe(path.join(worktreeDir, "feature-x"));
    expect(manifest.legacyOriginalName).toBe(legacyName);
    expect(manifest.headOid).toBeNull();
    await expect(fs.readFile(path.join(entries[0].payloadPath, "file.txt"), "utf-8")).resolves.toBe("quarantined");
    // The emptied legacy dir is removed so the migration converges.
    await expect(fs.access(path.join(worktreeDir, ".removed"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "trash_adopt", result: "success" }));
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
    expect(manifest.deletedAt).toBe("2026-06-02T08:00:00.000Z");
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
