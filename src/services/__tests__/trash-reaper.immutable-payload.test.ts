import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TrashReaperService } from "../trash-reaper.service";
import { TrashService } from "../trash.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;

// The unit tests replace fs.rm to model a file this process cannot unlink.
// This one does not model anything: a real immutable file, a real recursive
// delete, a real refusal. Whether that is even possible is a property of the
// host — the attribute needs CAP_LINUX_IMMUTABLE and a filesystem that
// implements it, so an unprivileged runner, a container without the
// capability, or tmpfs/overlay/macOS all legitimately cannot run it, and it
// skips there rather than failing.
async function immutableAttributeWorks(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-immutable-probe-"));
  const probe = path.join(probeDir, "probe.txt");
  try {
    await fs.writeFile(probe, "probe");
    await execFileAsync("chattr", ["+i", probe]);
    try {
      await fs.rm(probe, { force: true });
      // The attribute was accepted but did not actually protect the file.
      return false;
    } catch {
      return true;
    } finally {
      await execFileAsync("chattr", ["-i", probe]).catch(() => undefined);
    }
  } catch {
    return false;
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, dirent.name);
    if (dirent.name === name) return child;
    if (dirent.isDirectory()) {
      const found = await findFile(child, name);
      if (found !== null) return found;
    }
  }
  return null;
}

describe("TrashReaperService against a real immutable payload file", () => {
  let worktreeDir: string;
  let gitStub: {
    getCurrentCommit: ReturnType<typeof vi.fn>;
    updateRef: ReturnType<typeof vi.fn>;
    deleteRef: ReturnType<typeof vi.fn>;
    listRefs: ReturnType<typeof vi.fn>;
  };
  let logger: Logger;
  let trashService: TrashService;
  let reaper: TrashReaperService;
  let immutablePath: string | null = null;

  beforeEach(async () => {
    worktreeDir = await createTempDirectory();
    const config: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    };
    gitStub = {
      getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
      updateRef: vi.fn<any>().mockResolvedValue(undefined),
      deleteRef: vi.fn<any>().mockResolvedValue(undefined),
      listRefs: vi.fn<any>().mockResolvedValue([]),
    };
    logger = createMockLogger();
    const audit = { record: vi.fn<any>().mockResolvedValue(undefined) };
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
    // Without this the temp tree itself cannot be removed either.
    if (immutablePath !== null) {
      await execFileAsync("chattr", ["-i", immutablePath]).catch(() => undefined);
      immutablePath = null;
    }
    await cleanupTempDirectories();
  });

  it("warns and keeps a valid manifest, then completes once the attribute is cleared", async (ctx) => {
    if (!(await immutableAttributeWorks())) {
      ctx.skip("the immutable attribute is unavailable on this host");
      return;
    }

    const source = path.join(worktreeDir, "feature-x");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    await fs.writeFile(path.join(source, "README.md"), "docs");
    await fs.writeFile(path.join(source, "dist", "root-built.js"), "written by a root container");

    const entry = await trashService.trashDirectory({
      dirPath: source,
      branch: "feature-x",
      headOid: "abc123",
      reason: "prune",
    });
    const deletedAt = new Date(Date.now() - 31 * DAY_MS);
    entry.manifest.deletedAt = deletedAt.toISOString();
    entry.manifest.expiresAt = new Date(deletedAt.getTime() + trashService.getRetentionDays() * DAY_MS).toISOString();
    await fs.writeFile(path.join(entry.containerPath, "manifest.json"), JSON.stringify(entry.manifest, null, 2));

    immutablePath = path.join(entry.payloadPath, "dist", "root-built.js");
    await execFileAsync("chattr", ["+i", immutablePath]);

    const first = await reaper.reapExpiredUnlocked();

    expect(first.deleted).toBe(0);
    expect(first.errors).toHaveLength(1);
    const warnings = vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings.some((message) => message.includes("root-built.js"))).toBe(true);
    expect(warnings.some((message) => message.includes("chattr -i"))).toBe(true);
    const afterFailure = await trashService.listEntries();
    expect(afterFailure.entries.map((listed) => listed.manifest.id)).toEqual([entry.manifest.id]);
    expect(afterFailure.invalid).toEqual([]);
    expect(gitStub.deleteRef).not.toHaveBeenCalled();

    // The user does what the warning told them to.
    const moved = await findFile(entry.containerPath, "root-built.js");
    expect(moved).not.toBeNull();
    await execFileAsync("chattr", ["-i", moved as string]);
    immutablePath = null;

    const second = await reaper.reapExpiredUnlocked();

    expect(second.deleted).toBe(1);
    expect(second.errors).toEqual([]);
    await expect(fs.access(entry.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(gitStub.deleteRef).toHaveBeenCalledWith(entry.manifest.pinRef);
  });
});
