import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { WorktreeMetadataService } from "../worktree-metadata.service";

// Real filesystem. Older versions wrote `createdFrom` and `syncHistory` into
// every record; nothing reads them. New records must not carry them, and an
// old record must load, validate and be rewritten exactly as before.
describe("WorktreeMetadataService and the retired createdFrom/syncHistory fields", () => {
  let bareRepoPath: string;
  const worktreePath = "/somewhere/worktrees/feature-a";
  let service: WorktreeMetadataService;

  const legacyRecord = {
    lastSyncCommit: "0123abcd",
    lastSyncDate: "2024-01-14T10:00:00.000Z",
    upstreamBranch: "origin/feature-a",
    createdFrom: { branch: "main", commit: "fedc9876" },
    syncHistory: [{ date: "2024-01-14T10:00:00.000Z", commit: "0123abcd", action: "created" }],
    lastKnownRemoteTip: { ref: "origin/feature-a", oid: "4567beef", recordedAt: "2024-01-14T10:00:00.000Z" },
  };

  async function metadataFile(): Promise<string> {
    return service.getMetadataPathFromWorktreePath(bareRepoPath, worktreePath);
  }

  async function writeRaw(record: object): Promise<void> {
    const file = await metadataFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2));
  }

  async function readRaw(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(await metadataFile(), "utf-8")) as Record<string, unknown>;
  }

  beforeEach(async () => {
    bareRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-legacy-metadata-"));
    service = new WorktreeMetadataService(createMockLogger());
  });

  afterEach(async () => {
    await fs.rm(bareRepoPath, { recursive: true, force: true });
  });

  it("writes new records without createdFrom or syncHistory", async () => {
    const written = await service.createInitialMetadataFromPath(
      bareRepoPath,
      worktreePath,
      "abc123",
      "origin/feature-a",
    );

    expect(written).toBe(true);
    const raw = await readRaw();
    expect(Object.keys(raw).sort()).toEqual(["lastSyncCommit", "lastSyncDate", "upstreamBranch"]);
    expect(raw.lastSyncCommit).toBe("abc123");
  });

  it("still loads an old record with the fields, with the same safety inputs and owner", async () => {
    await writeRaw(legacyRecord);

    const loaded = await service.loadMetadataFromPath(bareRepoPath, worktreePath);

    // lastSyncCommit and lastKnownRemoteTip are what the removal checks read.
    expect(loaded?.lastSyncCommit).toBe("0123abcd");
    expect(loaded?.lastKnownRemoteTip).toEqual(legacyRecord.lastKnownRemoteTip);
    expect(await service.readMetadataOwner(bareRepoPath, "feature-a")).toBe("feature-a");
    expect(
      await service.saveMetadata(bareRepoPath, "feature-a", {
        lastSyncCommit: "abc",
        lastSyncDate: new Date().toISOString(),
        upstreamBranch: "origin/feature-b",
      }),
    ).toBe(false);
  });

  it("updates an old record without appending to its syncHistory, and it stays valid", async () => {
    await writeRaw(legacyRecord);

    await service.updateLastSyncFromPath(bareRepoPath, worktreePath, "89abcdef");

    const raw = await readRaw();
    expect(raw.lastSyncCommit).toBe("89abcdef");
    expect(raw.lastKnownRemoteTip).toEqual(legacyRecord.lastKnownRemoteTip);
    expect(raw.syncHistory).toEqual(legacyRecord.syncHistory);
    const reloaded = await service.loadMetadataFromPath(bareRepoPath, worktreePath);
    expect(reloaded?.lastSyncCommit).toBe("89abcdef");
  });
});
