import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GIT_CONSTANTS, TRASH_CONSTANTS } from "../../constants";
import { getRemovalAuditLogPath } from "../../utils/lock-path";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { RepositoryConfig } from "../../types";

describe("GitService.initialize with a stale default-branch directory", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-stale-main-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    mainPath = path.join(worktreeDir, "main");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# app");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("origin", remote);
    await initGit.push("origin", "main");
    await initGit.checkoutLocalBranch("feature-1");
    await fs.writeFile(path.join(initDir, "feature-1.txt"), "Content for feature-1");
    await initGit.add(".");
    await initGit.commit("Add feature-1");
    await initGit.push("origin", "feature-1");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<RepositoryConfig> = {}): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      __configFileDir: tempDir,
      ...overrides,
    };
  }

  async function registeredWorktreePaths(service: WorktreeSyncService): Promise<string[]> {
    return (await service.getWorktrees()).map((w) => path.resolve(w.path));
  }

  it("trashes a checkout left behind by a deleted bare repo, recreates the worktree and syncs", async () => {
    const config = makeConfig();
    const first = new WorktreeSyncService(config);
    await first.initialize();
    const originalGitFile = await fs.readFile(path.join(mainPath, ".git"), "utf8");
    expect(originalGitFile).toMatch(/^gitdir: /);

    const second = new WorktreeSyncService(makeConfig());
    await second.initialize();
    await expect(fs.access(path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME))).rejects.toThrow();

    await fs.rm(bareRepoDir, { recursive: true, force: true });
    await fs.writeFile(path.join(mainPath, "notes.txt"), "keep me");

    const third = new WorktreeSyncService(makeConfig());
    await expect(third.initialize()).resolves.toBeUndefined();

    const trashRoot = path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME);
    const entries = await fs.readdir(trashRoot);
    expect(entries).toHaveLength(1);
    const container = path.join(trashRoot, entries[0]);
    const payload = path.join(container, TRASH_CONSTANTS.PAYLOAD_DIRNAME);
    await expect(fs.readFile(path.join(payload, ".git.detached"), "utf8")).resolves.toBe(originalGitFile);
    await expect(fs.access(path.join(payload, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(payload, "notes.txt"), "utf8")).resolves.toBe("keep me");
    const manifest = JSON.parse(await fs.readFile(path.join(container, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf8"));
    expect(manifest).toMatchObject({ originalPath: mainPath, reason: "orphan" });
    const audit = await fs.readFile(getRemovalAuditLogPath(config), "utf8");
    expect(audit).toContain('"action":"trash_create"');
    expect(audit).toContain(mainPath);

    expect(await registeredWorktreePaths(third)).toContain(mainPath);
    const newGitFile = await fs.readFile(path.join(mainPath, ".git"), "utf8");
    const adminDir = newGitFile.replace(/^gitdir: /, "").trim();
    expect(adminDir).toContain(path.join(bareRepoDir, "worktrees"));
    await expect(fs.access(adminDir)).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(mainPath, "README.md"), "utf8")).resolves.toBe("# app");
    await expect(fs.access(path.join(mainPath, "notes.txt"))).rejects.toThrow();

    const result = await third.sync();
    expect(result.started).toBe(true);
    if (result.started) {
      expect(result.outcome.counts.failed).toBe(0);
    }
    const featureDir = (await fs.readdir(worktreeDir)).find((d) => d.startsWith("feature-1"));
    expect(featureDir).toBeDefined();
    await expect(fs.readFile(path.join(worktreeDir, featureDir ?? "", "feature-1.txt"), "utf8")).resolves.toBe(
      "Content for feature-1",
    );
  });

  it("quarantines a directory whose .git points nowhere when trash is disabled, then recreates the worktree", async () => {
    const danglingGitFile = `gitdir: ${path.join(tempDir, "gone", "worktrees", "main")}\n`;
    await fs.mkdir(mainPath, { recursive: true });
    await fs.writeFile(path.join(mainPath, ".git"), danglingGitFile);
    await fs.writeFile(path.join(mainPath, "notes.txt"), "keep me");

    const service = new WorktreeSyncService(makeConfig({ trash: { enabled: false } }));
    await expect(service.initialize()).resolves.toBeUndefined();

    const removedRoot = path.join(worktreeDir, GIT_CONSTANTS.REMOVED_DIR_NAME);
    const quarantined = await fs.readdir(removedRoot);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatch(/-main$/);
    await expect(fs.readFile(path.join(removedRoot, quarantined[0], ".git"), "utf8")).resolves.toBe(danglingGitFile);
    await expect(fs.readFile(path.join(removedRoot, quarantined[0], "notes.txt"), "utf8")).resolves.toBe("keep me");
    await expect(fs.access(path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME))).rejects.toThrow();

    const worktrees = await service.getWorktrees();
    expect(worktrees.find((w) => path.resolve(w.path) === mainPath)?.branch).toBe("main");
    await expect(fs.readFile(path.join(mainPath, ".git"), "utf8")).resolves.toContain(
      path.join(bareRepoDir, "worktrees"),
    );
    await expect(fs.readFile(path.join(mainPath, "README.md"), "utf8")).resolves.toBe("# app");
    await expect(service.getGitService().fetchAll()).resolves.toBeUndefined();
  });
});
