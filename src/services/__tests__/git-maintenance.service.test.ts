import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { MAINTENANCE_CONSTANTS } from "../../constants";
import { GitMaintenanceService } from "../git-maintenance.service";

import type { Config } from "../../types";
import type { MaintenanceState } from "../git-maintenance.service";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-03T12:00:00.000Z").getTime();

function createGitFactory() {
  const raw = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue("");
  const factory = vi.fn((_cwd: string) => ({ raw }) as unknown);
  return { factory: factory as unknown as (cwd: string) => never, raw, factoryMock: factory };
}

async function readState(statePath: string): Promise<MaintenanceState> {
  return JSON.parse(await fs.readFile(statePath, "utf-8")) as MaintenanceState;
}

describe("GitMaintenanceService", () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swt-maint-"));
    logger = createMockLogger();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("worktree mode", () => {
    let barePath: string;
    let gitService: GitService;

    beforeEach(async () => {
      barePath = path.join(tmpDir, ".bare");
      await fs.mkdir(barePath, { recursive: true });
      gitService = { getBareRepoPath: () => barePath } as unknown as GitService;
    });

    const config = (maintenance?: Config["maintenance"]): Config =>
      ({ mode: "worktree", repoUrl: "https://example.com/r.git", worktreeDir: tmpDir, maintenance }) as Config;

    it("runs `git gc` in the bare repo when due and persists success", async () => {
      const { factory, raw, factoryMock } = createGitFactory();
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(factoryMock).toHaveBeenCalledWith(barePath);
      expect(raw).toHaveBeenCalledWith(["gc"]);
      const state = await readState(path.join(barePath, MAINTENANCE_CONSTANTS.STATE_FILENAME));
      expect(state.lastAttemptAt).toBe(new Date(NOW).toISOString());
      expect(state.lastSuccessAt).toBe(new Date(NOW).toISOString());
      expect(state.lastFailureAt).toBeUndefined();
    });
  });

  describe("clone mode", () => {
    let gitService: GitService;

    beforeEach(async () => {
      await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
      gitService = { getBareRepoPath: () => path.join(tmpDir, ".bare") } as unknown as GitService;
    });

    const config = (maintenance?: Config["maintenance"]): Config =>
      ({ mode: "clone", repoUrl: "https://example.com/r.git", worktreeDir: tmpDir, maintenance }) as Config;

    it("runs `git gc` in the working dir and stores state under .git", async () => {
      const { factory, raw, factoryMock } = createGitFactory();
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(factoryMock).toHaveBeenCalledWith(tmpDir);
      expect(raw).toHaveBeenCalledWith(["gc"]);
      const statePath = path.join(tmpDir, ".git", MAINTENANCE_CONSTANTS.STATE_FILENAME);
      await expect(readState(statePath)).resolves.toMatchObject({ lastSuccessAt: new Date(NOW).toISOString() });
    });

    it("skips when the repo is not initialized (no .git dir)", async () => {
      await fs.rm(path.join(tmpDir, ".git"), { recursive: true, force: true });
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(raw).not.toHaveBeenCalled();
    });

    it("uses `git gc --prune=now` when aggressive", async () => {
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config({ aggressive: true }), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(raw).toHaveBeenCalledWith(["gc", "--prune=now"]);
    });
  });

  describe("enable / throttle", () => {
    let gitService: GitService;
    const config = (maintenance?: Config["maintenance"]): Config =>
      ({ mode: "worktree", repoUrl: "https://example.com/r.git", worktreeDir: tmpDir, maintenance }) as Config;

    beforeEach(async () => {
      await fs.mkdir(path.join(tmpDir, ".bare"), { recursive: true });
      gitService = { getBareRepoPath: () => path.join(tmpDir, ".bare") } as unknown as GitService;
    });

    it("does nothing when disabled", async () => {
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config({ enabled: false }), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(raw).not.toHaveBeenCalled();
      await expect(fs.access(path.join(tmpDir, ".bare", MAINTENANCE_CONSTANTS.STATE_FILENAME))).rejects.toThrow();
    });

    it("skips when last attempt is within the interval", async () => {
      const statePath = path.join(tmpDir, ".bare", MAINTENANCE_CONSTANTS.STATE_FILENAME);
      const recent = new Date(NOW - 1 * DAY_MS).toISOString();
      await fs.writeFile(statePath, JSON.stringify({ lastAttemptAt: recent }), "utf-8");
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(raw).not.toHaveBeenCalled();
    });

    it("runs again once the interval has elapsed", async () => {
      const statePath = path.join(tmpDir, ".bare", MAINTENANCE_CONSTANTS.STATE_FILENAME);
      const old = new Date(NOW - 8 * DAY_MS).toISOString();
      await fs.writeFile(statePath, JSON.stringify({ lastAttemptAt: old }), "utf-8");
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(raw).toHaveBeenCalledWith(["gc"]);
    });

    it("honors a custom interval", async () => {
      const statePath = path.join(tmpDir, ".bare", MAINTENANCE_CONSTANTS.STATE_FILENAME);
      await fs.writeFile(
        statePath,
        JSON.stringify({ lastAttemptAt: new Date(NOW - 2 * DAY_MS).toISOString() }),
        "utf-8",
      );
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config({ interval: "24h" }), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);

      expect(raw).toHaveBeenCalledWith(["gc"]);
    });

    it("recovers from a corrupt (array) state file without breaking throttling", async () => {
      const statePath = path.join(tmpDir, ".bare", MAINTENANCE_CONSTANTS.STATE_FILENAME);
      await fs.writeFile(statePath, "[]", "utf-8");
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);
      // The persisted timestamp must survive (not be swallowed by the array), so an
      // immediate second run is throttled instead of running gc again every tick.
      await svc.runIfDueUnlocked(NOW + 60_000);

      expect(raw).toHaveBeenCalledTimes(1);
      const state = await readState(statePath);
      expect(state.lastAttemptAt).toBe(new Date(NOW).toISOString());
    });
  });

  describe("failure isolation", () => {
    let gitService: GitService;
    const config = (): Config =>
      ({ mode: "worktree", repoUrl: "https://example.com/r.git", worktreeDir: tmpDir }) as Config;

    beforeEach(async () => {
      await fs.mkdir(path.join(tmpDir, ".bare"), { recursive: true });
      gitService = { getBareRepoPath: () => path.join(tmpDir, ".bare") } as unknown as GitService;
    });

    it("never throws on gc failure and records the failure while still throttling", async () => {
      const raw = vi.fn<(args: string[]) => Promise<string>>().mockRejectedValue(new Error("gc boom"));
      const factory = (() => ({ raw })) as unknown as (cwd: string) => never;
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await expect(svc.runIfDueUnlocked(NOW)).resolves.toBeUndefined();

      const state = await readState(path.join(tmpDir, ".bare", MAINTENANCE_CONSTANTS.STATE_FILENAME));
      expect(state.lastAttemptAt).toBe(new Date(NOW).toISOString());
      expect(state.lastFailureAt).toBe(new Date(NOW).toISOString());
      expect(state.lastError).toContain("gc boom");
      expect(state.lastSuccessAt).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("a perpetually-failing gc is throttled, not retried every tick", async () => {
      const raw = vi.fn<(args: string[]) => Promise<string>>().mockRejectedValue(new Error("gc boom"));
      const factory = (() => ({ raw })) as unknown as (cwd: string) => never;
      const svc = new GitMaintenanceService(config(), gitService, logger, factory);

      await svc.runIfDueUnlocked(NOW);
      await svc.runIfDueUnlocked(NOW + 60_000); // one minute later, well within 7d

      expect(raw).toHaveBeenCalledTimes(1);
    });

    it("never throws when target resolution itself fails (warns and returns)", async () => {
      const throwingGitService = {
        getBareRepoPath: () => {
          throw new Error("no bare path");
        },
      } as unknown as GitService;
      const { factory, raw } = createGitFactory();
      const svc = new GitMaintenanceService(config(), throwingGitService, logger, factory);

      await expect(svc.runIfDueUnlocked(NOW)).resolves.toBeUndefined();

      expect(raw).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unexpected error"));
    });
  });

  describe("process-restart throttling", () => {
    it("a fresh service instance respects a timestamp written by a prior run", async () => {
      const barePath = path.join(tmpDir, ".bare");
      await fs.mkdir(barePath, { recursive: true });
      const gitService = { getBareRepoPath: () => barePath } as unknown as GitService;
      const config = { mode: "worktree", repoUrl: "https://example.com/r.git", worktreeDir: tmpDir } as Config;

      const first = createGitFactory();
      await new GitMaintenanceService(config, gitService, logger, first.factory).runIfDueUnlocked(NOW);
      expect(first.raw).toHaveBeenCalledTimes(1);

      const second = createGitFactory();
      await new GitMaintenanceService(config, gitService, logger, second.factory).runIfDueUnlocked(NOW + 60_000);
      expect(second.raw).not.toHaveBeenCalled();
    });
  });
});
