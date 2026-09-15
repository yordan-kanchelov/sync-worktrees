import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TRASH_CONSTANTS } from "../../constants";
import { TrashService, summarizeTrashEntries } from "../trash.service";

import type * as DiskSpace from "../../utils/disk-space";
import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";

// Shared with the module factory below. vitest hoists `vi.mock` above every
// import in this file, so the factory cannot close over ordinary module-scope
// bindings — only over a `vi.hoisted` value.
const probe = vi.hoisted(() => ({
  // One record per size scan: what was scanned, and whether the worktree the
  // payload came from was still on disk at that instant. The second field is
  // what makes these assertions impossible to satisfy vacuously — a scan of a
  // live worktree necessarily sees its source directory.
  scans: [] as { dirPath: string; sourceOnDisk: boolean }[],
  sourcePath: "",
  // When set, stands in for the real `du`.
  override: null as null | ((dirPath: string) => Promise<number>),
}));

vi.mock("../../utils/disk-space", async (importOriginal) => {
  const actual = await importOriginal<typeof DiskSpace>();
  return {
    ...actual,
    calculateDirectorySize: vi.fn(async (dirPath: string) => {
      probe.scans.push({ dirPath, sourceOnDisk: probe.sourcePath !== "" && existsSync(probe.sourcePath) });
      return probe.override ? probe.override(dirPath) : actual.calculateDirectorySize(dirPath);
    }),
  };
});

function makeGitStub() {
  return {
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    getWorktreeLock: vi.fn<any>().mockResolvedValue({ locked: false }),
    removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
    deleteLocalBranchIfAt: vi.fn<any>().mockResolvedValue(undefined),
    deleteLocalBranch: vi.fn<any>().mockResolvedValue(undefined),
  };
}

describe("TrashService payload sizing", () => {
  let worktreeDir: string;
  let service: TrashService;

  beforeEach(async () => {
    worktreeDir = await createTempDirectory();
    const config: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    };
    const audit = { record: vi.fn<any>().mockResolvedValue(undefined) };
    service = new TrashService(
      config,
      makeGitStub() as unknown as GitService,
      createMockLogger() as Logger,
      audit as unknown as RemovalAuditService,
    );
    probe.scans = [];
    probe.sourcePath = "";
    probe.override = null;
  });

  afterEach(async () => {
    await cleanupTempDirectories();
  });

  async function makeSourceDir(name: string): Promise<string> {
    const dir = path.join(worktreeDir, name);
    await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "data");
    await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "x".repeat(4096));
    probe.sourcePath = dir;
    return dir;
  }

  async function readManifestFromDisk(containerPath: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await fs.readFile(path.join(containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf-8"),
    ) as Record<string, unknown>;
  }

  it("moves a worktree to trash without scanning anything", async () => {
    const entry = await service.trashDirectory({
      dirPath: await makeSourceDir("feature-x"),
      branch: "feature-x",
      reason: "prune",
    });

    // The removal path holds the repository lock from end to end, so the one
    // thing it must never do is exec `du` over a worktree.
    expect(probe.scans).toEqual([]);
    expect(entry.manifest.sizeBytes).toBeNull();
    expect(await readManifestFromDisk(entry.containerPath)).toMatchObject({ sizeBytes: null });
  });

  it("measures the payload, never the worktree it came from, and writes the size back once", async () => {
    const entry = await service.trashDirectory({
      dirPath: await makeSourceDir("feature-y"),
      branch: "feature-y",
      reason: "prune",
    });

    const { entries } = await service.listEntriesWithSizes();

    // `sourceOnDisk: false` is the load-bearing half: a scan that ran before
    // the rename would have found the worktree still in place.
    expect(probe.scans).toEqual([{ dirPath: entry.payloadPath, sourceOnDisk: false }]);
    expect(entries[0].manifest.sizeBytes).toBeGreaterThan(0);
    expect(await readManifestFromDisk(entry.containerPath)).toMatchObject({
      sizeBytes: entries[0].manifest.sizeBytes,
    });

    // Persisted, so the next pass is free.
    const again = await service.listEntriesWithSizes();
    expect(probe.scans).toHaveLength(1);
    expect(again.entries[0].manifest.sizeBytes).toBe(entries[0].manifest.sizeBytes);
  });

  it("leaves a valid, unsized entry when the scan fails and measures it on a later pass", async () => {
    const entry = await service.trashDirectory({
      dirPath: await makeSourceDir("feature-z"),
      branch: "feature-z",
      reason: "prune",
    });
    probe.override = () => Promise.reject(new Error("du: cannot read directory"));

    // listEntries only returns containers whose manifest passes every schema
    // check, so an entry appearing here at all is the assertion that the
    // manifest is valid, not merely present.
    const failed = await service.listEntriesWithSizes();
    expect(failed.invalid).toEqual([]);
    expect(failed.entries.map((listed) => listed.manifest.id)).toEqual([entry.manifest.id]);
    expect(failed.entries[0].manifest.sizeBytes).toBeNull();
    await expect(fs.readFile(path.join(entry.payloadPath, "file.txt"), "utf-8")).resolves.toBe("data");

    probe.override = null;
    const retried = await service.listEntriesWithSizes();
    expect(retried.entries[0].manifest.sizeBytes).toBeGreaterThan(0);
  });

  it("does not scan a payload that has already been set aside for deletion", async () => {
    const entry = await service.trashDirectory({
      dirPath: await makeSourceDir("feature-w"),
      branch: "feature-w",
      reason: "prune",
    });
    await fs.rename(entry.payloadPath, path.join(entry.containerPath, `${TRASH_CONSTANTS.DELETING_PREFIX}20240101`));

    const { entries } = await service.listEntriesWithSizes();

    expect(probe.scans).toEqual([]);
    expect(entries[0].manifest.sizeBytes).toBeNull();
  });

  it("never resurrects a container that was removed while its payload was being scanned", async () => {
    const entry = await service.trashDirectory({
      dirPath: await makeSourceDir("feature-v"),
      branch: "feature-v",
      reason: "prune",
    });
    // A restore or a reap — both of which hold the repo lock this sizing pass
    // deliberately does not — emptying the container mid-scan.
    probe.override = async (dirPath) => {
      await fs.rm(path.dirname(dirPath), { recursive: true, force: true });
      return 4096;
    };

    const measured = await service.listEntriesWithSizes();

    expect(measured.entries[0].manifest.sizeBytes).toBeNull();
    expect(existsSync(entry.containerPath)).toBe(false);
    // Neither a listed entry nor an unrecognized container the reaper would
    // warn about forever.
    expect(await service.listEntries()).toEqual({ entries: [], invalid: [] });
  });

  it("merges the size into the manifest as it reads now, not into the copy the scan started from", async () => {
    const entry = await service.trashDirectory({
      dirPath: await makeSourceDir("feature-u"),
      branch: "feature-u",
      reason: "diverged-replace",
    });
    probe.override = async (dirPath) => {
      // The diverged-replace flow reaching markReplacementCreated under the
      // repo lock, while this scan runs without it. A size written onto the
      // manifest this pass listed would erase that.
      const { entries } = await service.listEntries();
      await service.markReplacementCreated(entries[0], new Date("2026-01-02T03:04:05.000Z"));
      return path.basename(dirPath) === "payload" ? 4096 : 0;
    };

    const { entries } = await service.listEntriesWithSizes();

    expect(entries[0].manifest.sizeBytes).toBe(4096);
    expect(await readManifestFromDisk(entry.containerPath)).toMatchObject({
      sizeBytes: 4096,
      replacedAt: "2026-01-02T03:04:05.000Z",
    });
  });

  // An unknown size is what the force-clean confirmation shows next to its
  // byte total and what the reaper's warning threshold has to ignore. Folding
  // it in as zero would understate both without ever saying so.
  it("counts an unsized entry as an unknown size rather than as zero bytes", async () => {
    await service.trashDirectory({ dirPath: await makeSourceDir("measured"), reason: "orphan" });
    await service.listEntriesWithSizes();
    probe.override = () => Promise.reject(new Error("du: cannot read directory"));
    await service.trashDirectory({ dirPath: await makeSourceDir("unmeasured"), reason: "orphan" });

    const { entries } = await service.listEntriesWithSizes();
    const summary = summarizeTrashEntries(entries);
    const measuredBytes = entries.find((entry) => entry.manifest.sizeBytes !== null)?.manifest.sizeBytes;

    expect(measuredBytes).toBeGreaterThan(0);
    expect(summary.itemCount).toBe(2);
    expect(summary.unknownSizeCount).toBe(1);
    expect(summary.totalSizeBytes).toBe(measuredBytes);
  });

  // Before the scan moved off the repository lock it ran inside the removal
  // fan-out, so a large prune sized maxWorktreeRemoval worktrees at a time.
  // Running them one after another here would multiply the wall clock of that
  // prune by the same factor — off the lock, but still inside the sync that is
  // waiting on it.
  it("scans up to maxWorktreeRemoval payloads at once — neither serial nor unbounded", async () => {
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await service.trashDirectory({ dirPath: await makeSourceDir(name), reason: "prune" });
    }

    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    probe.override = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Hold every scan open until all six have been admitted or the limiter
      // has refused to admit more: a serial implementation parks on the first
      // and never reaches the release below, so the peak it reports is 1.
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return 4096;
    };

    const scanning = service.listEntriesWithSizes();
    // Let the limiter admit everything it is willing to admit while nothing is
    // allowed to finish: whatever is parked after the event loop has gone
    // quiet is the cap.
    await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    const admittedBeforeAnyCompleted = release.length;

    let draining = true;
    const drain = (async (): Promise<void> => {
      while (draining) {
        while (release.length > 0) release.pop()?.();
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await scanning;
    draining = false;
    await drain;

    expect(admittedBeforeAnyCompleted).toBe(3);
    expect(peak).toBe(3);
    expect(probe.scans).toHaveLength(6);
  });
});
