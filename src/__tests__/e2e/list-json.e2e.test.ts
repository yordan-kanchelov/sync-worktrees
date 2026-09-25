import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { ListedRepository } from "../../cli/list";
import type { RepositoryConfig } from "../../types";

// The built CLI against real git: config discovery from a nested directory and
// through SYNC_WORKTREES_CONFIG, and `list --json` counting what a real sync
// left on disk — worktrees first, then a trash entry once a remote branch is
// pruned.
describe("sync-worktrees list --json and config discovery (E2E)", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let home: string;
  let project: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-list-json-")));
    home = path.join(tempDir, "home");
    project = path.join(home, "project");
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(project, "worktrees");
    bareRepoDir = path.join(project, ".bare", "app");
    await fs.mkdir(path.join(project, "deep", "er"), { recursive: true });

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);
    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.push("origin", "main:feature");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    configPath = path.join(project, "sync-worktrees.config.mjs");
    await fs.writeFile(
      configPath,
      `export default { repositories: [${JSON.stringify({
        name: "app",
        repoUrl: `file://${remote}`,
        worktreeDir,
        bareRepoDir,
        branchExclude: ["dependabot/*"],
      })}] };\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function run(args: string[], options: { cwd: string; env?: Record<string, string> }) {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: options.cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        SYNC_WORKTREES_CONFIG: undefined,
        SYNC_WORKTREES_UNIT_TEST: undefined,
        ...options.env,
      },
      input: "",
      timeout: 30000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function listJson(cwd: string): ListedRepository[] {
    const result = run(["list", "--json"], { cwd });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as ListedRepository[];
  }

  function makeService(): WorktreeSyncService {
    return new WorktreeSyncService({
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: project,
    } as RepositoryConfig);
  }

  it("finds the config from a nested directory and counts worktrees and trash from a real sync", async () => {
    const nested = path.join(project, "deep", "er");

    const before = listJson(nested);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      name: "app",
      mode: "worktree",
      worktreeDir,
      bareRepoDir,
      filters: { branchExclude: ["dependabot/*"] },
      counts: { worktrees: 0, trashEntries: 0, error: null },
    });

    const service = makeService();
    await service.initialize();
    await service.sync();
    expect(listJson(nested)[0].counts).toEqual({ worktrees: 2, trashEntries: 0, error: null });

    await simpleGit(remote).raw(["update-ref", "-d", "refs/heads/feature"]);
    await service.sync();
    expect(listJson(nested)[0].counts).toEqual({ worktrees: 1, trashEntries: 1, error: null });

    const human = run(["list"], { cwd: nested });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("(found in a parent directory)");
    expect(human.stdout).toContain("On disk: 1 worktree, 1 trash entry");
  });

  it("does not pick up a config above the home directory", async () => {
    await fs.rename(configPath, path.join(tempDir, "sync-worktrees.config.mjs"));

    const result = run(["list"], { cwd: path.join(project, "deep") });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No config file found");
    expect(result.stderr).toContain("SYNC_WORKTREES_CONFIG");
  });

  it("uses SYNC_WORKTREES_CONFIG over discovery, and --config over both", async () => {
    const other = path.join(tempDir, "other.config.mjs");
    await fs.writeFile(
      other,
      `export default { repositories: [${JSON.stringify({
        name: "other",
        repoUrl: "https://example.invalid/other.git",
        worktreeDir: path.join(tempDir, "other"),
      })}] };\n`,
    );

    const fromEnv = run(["list", "--json"], { cwd: project, env: { SYNC_WORKTREES_CONFIG: other } });
    expect(fromEnv.status).toBe(0);
    expect((JSON.parse(fromEnv.stdout) as ListedRepository[]).map((repo) => repo.name)).toEqual(["other"]);

    const fromFlag = run(["list", "--json", "--config", configPath], {
      cwd: project,
      env: { SYNC_WORKTREES_CONFIG: other },
    });
    expect(fromFlag.status).toBe(0);
    expect((JSON.parse(fromFlag.stdout) as ListedRepository[]).map((repo) => repo.name)).toEqual(["app"]);

    const human = run(["list"], { cwd: project, env: { SYNC_WORKTREES_CONFIG: other } });
    expect(human.stdout).toContain("(from SYNC_WORKTREES_CONFIG)");

    const missing = run(["list"], { cwd: project, env: { SYNC_WORKTREES_CONFIG: "nope.config.js" } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      `SYNC_WORKTREES_CONFIG points to a file that does not exist: ${path.join(project, "nope.config.js")}`,
    );
  });
});
