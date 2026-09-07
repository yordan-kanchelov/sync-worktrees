import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { probePathExists } from "../../utils/file-exists";
import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";
import type { Logger } from "../logger.service";
import type * as fileExists from "../../utils/file-exists";
import type { Mock } from "vitest";

// probePathExists keeps its real behaviour here; only the "unknown" result —
// a probe that failed for a reason other than the path being gone, which a
// suite that may run as root cannot produce from the filesystem — is forced
// through the spy.
vi.mock("../../utils/file-exists", async (importOriginal) => {
  const actual = await importOriginal<typeof fileExists>();
  return { ...actual, probePathExists: vi.fn(actual.probePathExists) };
});

// Real git, no mocks. The default branch's worktree anchors every
// remote-facing command, so a long-lived process has to re-check it before
// each sync: initialize()'s heal runs once and isInitialized() never goes back
// to false, which left `rm -rf worktrees/main` failing every later fetch.
describe("GitService.ensureAnchorWorktree", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;
  let logger: Logger;
  let gitService: GitService;

  const loggedLines = (level: "info" | "warn"): string[] =>
    (logger[level] as Mock).mock.calls.map((call) => String(call[0]));

  const registeredWorktrees = async (): Promise<string> =>
    simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-anchor-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    mainPath = path.join(worktreeDir, "main");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    logger = createMockLogger();
    const options: GitServiceOptions = { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir };
    gitService = new GitService(options, logger);
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("leaves a present anchor alone", async () => {
    const before = await fs.readFile(path.join(mainPath, ".git"), "utf8");

    await expect(gitService.ensureAnchorWorktree()).resolves.toBe(false);

    await expect(fs.readFile(path.join(mainPath, ".git"), "utf8")).resolves.toBe(before);
    expect(loggedLines("warn").filter((line) => line.includes("missing"))).toEqual([]);
  });

  it("recreates an anchor whose directory was deleted out-of-band, naming it", async () => {
    await fs.rm(mainPath, { recursive: true, force: true });

    await expect(gitService.ensureAnchorWorktree()).resolves.toBe(true);

    await expect(fs.access(path.join(mainPath, ".git"))).resolves.toBeUndefined();
    expect(await registeredWorktrees()).toContain(mainPath);
    expect(loggedLines("warn").some((line) => line.includes(mainPath) && line.includes("missing"))).toBe(true);
    // The rebuilt worktree anchors fetches again.
    await expect(gitService.fetchAll()).resolves.toBeUndefined();
  });

  it("refuses to run git in an anchor it could not probe", async () => {
    vi.mocked(probePathExists).mockResolvedValueOnce("unknown");

    await expect(gitService.ensureAnchorWorktree()).rejects.toThrow(
      `Cannot determine whether the main worktree at '${mainPath}' still exists`,
    );
    // Nothing was rebuilt or unregistered on an unverifiable probe.
    expect(await registeredWorktrees()).toContain(mainPath);
  });

  it("names the missing working directory instead of reporting 'spawn git ENOENT'", async () => {
    await fs.rm(mainPath, { recursive: true, force: true });

    const error = await gitService.fetchAll().then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(String(error)).toContain(`working directory '${mainPath}' does not exist`);
    expect(String(error)).not.toContain("spawn git ENOENT");
  });
});
