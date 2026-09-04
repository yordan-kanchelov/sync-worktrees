import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV_CONSTANTS, MAINTENANCE_CONSTANTS, TRASH_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { setEnvVar } from "../test-utils";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  pid: number;
}

// The built CLI must take the cross-process lock, reap expired trash and run
// gc no matter what NODE_ENV the caller's shell exported, and no matter whether
// the vitest worker's SYNC_WORKTREES_UNIT_TEST reached it through env
// inheritance — that value names the worker's pid, never the child's.
describe("CLI safety features are independent of NODE_ENV", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let stateHome: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-node-env-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");
    stateHome = path.join(tempDir, "state");

    await simpleGit().init(["--bare", bareRepo]);
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# Test Repository");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("origin", bareRepo);
    await initGit.push("origin", "main");
    await simpleGit(bareRepo).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(initDir, { recursive: true });

    configPath = path.join(tempDir, "sync-worktrees.config.js");
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "test-repo",
      repoUrl: "file://${bareRepo}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${bareRepoDir}",
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(args: string[], env: NodeJS.ProcessEnv): CliRun {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      encoding: "utf8",
      env,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, pid: result.pid };
  }

  async function seedExpiredTrashEntry(): Promise<string> {
    const id = "expired-entry";
    const containerPath = path.join(worktreeDir, ".trash", id);
    const payloadPath = path.join(containerPath, TRASH_CONSTANTS.PAYLOAD_DIRNAME);
    await fs.mkdir(payloadPath, { recursive: true });
    await fs.writeFile(path.join(payloadPath, "stale.txt"), "expired");
    const manifest = {
      schemaVersion: TRASH_CONSTANTS.SCHEMA_VERSION,
      id,
      deletedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      originalPath: path.join(worktreeDir, "old-branch"),
      branch: null,
      reason: "prune",
      sizeBytes: null,
      headOid: null,
      pinRef: null,
      source: "worktree",
      legacyOriginalName: null,
    };
    await fs.writeFile(path.join(containerPath, TRASH_CONSTANTS.MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
    return containerPath;
  }

  // getWorktreeDirLockTarget reads XDG_STATE_HOME from this process; point it at
  // the child's state dir just long enough to derive the path the child used.
  function expectedLockFile(): string {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const target = getWorktreeDirLockTarget({
        repoUrl: `file://${bareRepo}`,
        worktreeDir,
        cronSchedule: "0 * * * *",
        runOnce: true,
      });
      expect(target.dir).toBe(path.join(stateHome, "sync-worktrees", "locks"));
      return path.join(target.dir, target.file);
    } finally {
      setEnvVar("XDG_STATE_HOME", previous);
    }
  }

  it.each([
    { variant: "stripped from the environment", inherit: false },
    { variant: "inherited verbatim from the vitest worker", inherit: true },
  ])(
    "locks, reaps expired trash and runs gc under NODE_ENV=test with the unit-test shortcut $variant",
    async ({ inherit }) => {
      const containerPath = await seedExpiredTrashEntry();
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", XDG_STATE_HOME: stateHome };
      if (inherit) {
        expect(env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT]).toBe(String(process.pid));
      } else {
        delete env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
      }

      const run = runCli(["--config", configPath, "--runOnce"], env);

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("Synchronization finished");
      expect(run.stderr).not.toContain(ENV_CONSTANTS.UNIT_TEST_SHORTCUT);

      // Cross-process lock: the worktreeDir-keyed lock file is created on acquire.
      const lockStats = await fs.stat(expectedLockFile());
      expect(lockStats.isFile()).toBe(true);

      // Trash reaper: the pre-seeded expired entry is gone.
      expect(run.stdout).toContain("Trash reaper: deleted expired entry 'expired-entry'");
      await expect(fs.access(containerPath)).rejects.toThrow();

      // Periodic gc: ran and persisted its state next to the bare repo.
      expect(run.stdout).toContain("Running git gc (maintenance)");
      const state = JSON.parse(
        await fs.readFile(path.join(bareRepoDir, MAINTENANCE_CONSTANTS.STATE_FILENAME), "utf8"),
      ) as { lastSuccessAt?: string };
      expect(state.lastSuccessAt).toBeTruthy();
    },
    60_000,
  );

  it("warns at startup when the unit-test shortcut is genuinely active for the CLI process", async () => {
    // Only a value equal to the CLI's own pid activates the shortcut, so it has
    // to be set from inside the process before the CLI entry point loads.
    const wrapper = path.join(tempDir, "shortcut-wrapper.mjs");
    await fs.writeFile(
      wrapper,
      `process.env[${JSON.stringify(ENV_CONSTANTS.UNIT_TEST_SHORTCUT)}] = String(process.pid);\n` +
        `await import(${JSON.stringify(pathToFileURL(binPath).href)});\n`,
    );

    const result = spawnSync(process.execPath, [wrapper, "list", "--config", configPath], {
      encoding: "utf8",
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Configured repositories");
    expect(result.stderr).toContain(
      `${ENV_CONSTANTS.UNIT_TEST_SHORTCUT} is active for this process (pid ${result.pid})`,
    );
    expect(result.stderr).toContain("DISABLED");
  }, 60_000);
});
