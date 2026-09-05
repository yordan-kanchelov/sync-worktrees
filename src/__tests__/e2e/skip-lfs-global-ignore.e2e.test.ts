import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRASH_CONSTANTS } from "../../constants";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// With `skipLfs: true` every status probe runs through a simple-git client
// carrying an explicit env, and simple-git replaces the child environment
// wholesale with it. If that env is only { GIT_LFS_SKIP_SMUDGE: "1" }, git runs
// without HOME / XDG_CONFIG_HOME and never sees the user's global excludes
// file: a globally-ignored `*.log` in a worktree reports as an untracked
// change, the worktree reads as dirty, and a branch deleted upstream is never
// pruned. The built CLI runs with HOME pointing at a directory whose
// `.config/git/ignore` ignores `*.log`.
describe("skipLfs status probes honour the global git excludes file", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let homeDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-skip-lfs-ignore-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");
    homeDir = path.join(tempDir, "home");

    await fs.mkdir(path.join(homeDir, ".config", "git"), { recursive: true });
    await fs.writeFile(path.join(homeDir, ".config", "git", "ignore"), "*.log\n");

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
    // feature-1 sits on main's tip, so once its remote ref is gone nothing on
    // it can read as unpushed — only the untracked-file check decides its fate.
    await initGit.branch(["feature-1"]);
    await initGit.push("origin", "feature-1");
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
      skipLfs: true,
      trash: { enabled: true },
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // HOME is the temp home so git resolves ~/.config/git/ignore there;
  // XDG_CONFIG_HOME is removed so an inherited value cannot redirect that
  // lookup and GIT_CONFIG_GLOBAL so an inherited global config cannot point
  // core.excludesFile elsewhere; XDG_STATE_HOME keeps the repo lock inside the
  // temp dir too.
  function runCli(): CliRun {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, XDG_STATE_HOME: path.join(tempDir, "state") };
    delete env.XDG_CONFIG_HOME;
    delete env.GIT_CONFIG_GLOBAL;
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      env,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("prunes a worktree whose only untracked file is ignored by ~/.config/git/ignore", async () => {
    const firstRun = runCli();
    expect(firstRun.status, firstRun.stderr).toBe(0);
    expect(firstRun.stdout).toContain("Synchronization finished");

    const featureDir = (await fs.readdir(worktreeDir)).find((d) => d.startsWith("feature-1-"));
    expect(featureDir).toBeDefined();
    const featurePath = path.join(worktreeDir, featureDir!);

    await fs.writeFile(path.join(featurePath, "x.log"), "build output\n");
    await simpleGit(bareRepo).branch(["-D", "feature-1"]);

    const secondRun = runCli();
    expect(secondRun.status, secondRun.stderr).toBe(0);
    expect(secondRun.stdout).toContain("Moved worktree for 'feature-1' to trash");
    expect(secondRun.stdout).not.toContain("uncommitted changes");
    await expect(fs.access(featurePath)).rejects.toThrow();

    const trashRoot = path.join(worktreeDir, ".trash");
    const pruned = await Promise.all(
      (await fs.readdir(trashRoot)).map(async (id) => {
        const manifest = JSON.parse(
          await fs.readFile(path.join(trashRoot, id, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf8"),
        ) as { reason: string; branch: string | null };
        return { id, manifest };
      }),
    );
    const entry = pruned.find(({ manifest }) => manifest.reason === "prune" && manifest.branch === "feature-1");
    expect(entry).toBeDefined();
    await expect(
      fs.readFile(path.join(trashRoot, entry!.id, TRASH_CONSTANTS.PAYLOAD_DIRNAME, "x.log"), "utf8"),
    ).resolves.toBe("build output\n");
  }, 60_000);
});
