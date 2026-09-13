import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { METADATA_CONSTANTS } from "../../constants";
import { GitService } from "../git.service";
import { Logger } from "../logger.service";

import type { GitServiceOptions } from "../git.service";
import type { LogLevel } from "../logger.service";
import type { SimpleGit, SimpleGitOptions } from "simple-git";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

// The TUI hands its log-panel logger to an already-built GitService
// (updateLogger). Anything that kept the construction-time logger keeps writing
// to the console Ink has taken over, where the user never sees it — so these
// tests follow real log lines from the two sub-services GitService owns, and
// from a git client cached before the swap, rather than asserting on a spy.
describe("GitService logger propagation", () => {
  const BARE_REPO_PATH = "/test/.bare";
  const WORKTREE_PATH = "/test/worktrees/feature";
  const METADATA_PATH = path.join(
    BARE_REPO_PATH,
    METADATA_CONSTANTS.WORKTREE_METADATA_PATH,
    "feature",
    METADATA_CONSTANTS.METADATA_FILENAME,
  );

  const config: GitServiceOptions = {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/test/worktrees",
    bareRepoDir: BARE_REPO_PATH,
    debug: true,
  };

  interface CapturedLogger {
    logger: Logger;
    lines: string[];
  }

  const createCapturingLogger = (): CapturedLogger => {
    const lines: string[] = [];
    return {
      lines,
      logger: new Logger({
        debug: true,
        outputFn: (message: string, level: LogLevel) => lines.push(`${level}: ${message}`),
      }),
    };
  };

  // Options every simple-git client was built with, so a cached client's
  // progress handler can be fired the way simple-git fires it.
  let clientOptions: Array<Partial<SimpleGitOptions>>;

  beforeEach(() => {
    vi.clearAllMocks();
    clientOptions = [];

    (simpleGit as unknown as Mock).mockImplementation((...args: unknown[]) => {
      clientOptions.push((args.length > 1 ? args[1] : args[0]) as Partial<SimpleGitOptions>);
      return {
        // The status probe fails: "Error reading status for ...".
        status: vi.fn().mockRejectedValue(new Error("not a git repository")),
        branch: vi.fn().mockResolvedValue({ current: "feature", detached: false, all: [] }),
        stashList: vi.fn().mockResolvedValue({ total: 0 }),
        raw: vi.fn().mockResolvedValue(""),
        env: vi.fn().mockReturnThis(),
      } as unknown as SimpleGit;
    });

    // Corrupted metadata for the worktree: "Corrupted metadata for ...".
    (fs.readFile as Mock).mockImplementation((probed: string) =>
      probed === METADATA_PATH
        ? Promise.resolve("{}")
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    // The worktree directory exists; nothing else does.
    (fs.access as Mock).mockImplementation((probed: string) =>
      probed === WORKTREE_PATH
        ? Promise.resolve(undefined)
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    (fs.stat as Mock).mockResolvedValue({ isFile: () => false });
  });

  const metadataWarning = (lines: string[]): string | undefined =>
    lines.find((line) => line.startsWith("warn: ") && line.includes("Corrupted metadata for"));
  const statusError = (lines: string[]): string | undefined =>
    lines.find((line) => line.startsWith("error: ") && line.includes("Error reading status for"));

  it("routes sub-service logs to the logger it was constructed with", async () => {
    const first = createCapturingLogger();
    const gitService = new GitService(config, first.logger);

    await gitService.getFullWorktreeStatus(WORKTREE_PATH);

    expect(metadataWarning(first.lines)).toBeDefined();
    expect(statusError(first.lines)).toBeDefined();
  });

  it("moves metadata and status logs onto the logger updateLogger installs", async () => {
    const first = createCapturingLogger();
    const second = createCapturingLogger();
    const gitService = new GitService(config, first.logger);

    gitService.updateLogger(second.logger);
    await gitService.getFullWorktreeStatus(WORKTREE_PATH);

    expect(metadataWarning(second.lines)).toContain(WORKTREE_PATH);
    expect(statusError(second.lines)).toContain(WORKTREE_PATH);
    expect(first.lines).toEqual([]);
  });

  // The daemon builds GitService with no logger at all, so the sub-services
  // start on Logger.createDefault() -- console. Under the TUI that writes
  // beneath Ink's alternate screen, where the user never sees it, so the swap
  // has to leave the console silent and not merely reach the new logger.
  it("stops the console-default sub-services writing to the console", async () => {
    const ui = createCapturingLogger();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const gitService = new GitService(config);

    gitService.updateLogger(ui.logger);
    await gitService.getFullWorktreeStatus(WORKTREE_PATH);

    expect(metadataWarning(ui.lines)).toContain(WORKTREE_PATH);
    expect(statusError(ui.lines)).toContain(WORKTREE_PATH);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("moves the progress logs of an already-cached git client too", async () => {
    const first = createCapturingLogger();
    const second = createCapturingLogger();
    const gitService = new GitService(config, first.logger);

    // Caches the bare-repo client (and its progress handler) before the swap.
    await gitService.listRefs("refs/heads/");
    const progress = clientOptions.find((options) => options.progress)?.progress;
    gitService.updateLogger(second.logger);

    expect(progress).toBeDefined();
    progress?.({ method: "fetch", stage: "Receiving objects", progress: 50, processed: 5, total: 10 });

    expect(second.lines).toEqual([expect.stringContaining("fetch Receiving objects: 50%")]);
    expect(first.lines).toEqual([]);
  });
});
