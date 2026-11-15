import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { symlinksSupported } from "../helpers/symlink-support";

// git records canonical (realpath) worktree paths. A worktreeDir reached
// through a symlink (every path under /tmp on macOS) used to fail the first
// run with "main worktree ... is not registered ... after creation".
describe("worktreeDir under a symlinked directory (E2E)", async () => {
  const canSymlink = await symlinksSupported();
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let linkDir: string;
  let worktreeDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-symlinked-dir-")));
    const remote = path.join(tempDir, "remote", "app.git");
    await fs.mkdir(path.join(tempDir, "real"));
    linkDir = path.join(tempDir, "link");
    if (canSymlink) await fs.symlink(path.join(tempDir, "real"), linkDir, "dir");
    worktreeDir = path.join(linkDir, "wt");
    configPath = path.join(tempDir, "sync-worktrees.config.js");

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
    await seed.checkoutLocalBranch("feature/a");
    await seed.push("origin", "feature/a");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: ${JSON.stringify(`file://${remote}`)},
      worktreeDir: ${JSON.stringify(worktreeDir)},
      bareRepoDir: ${JSON.stringify(path.join(linkDir, ".bare", "app"))},
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(): { status: number | null; output: string; stdout: string } {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
  }

  it.skipIf(!canSymlink)(
    "syncs on the first run and leaves live worktrees in place on the next",
    async () => {
      const first = runCli();
      expect(first.status, first.output).toBe(0);
      expect(first.stdout).toContain("1 synced");
      expect(first.output).not.toContain("not registered");

      const featurePath = new PathResolutionService().getBranchWorktreePath(worktreeDir, "feature/a");
      await fs.writeFile(path.join(featurePath, "work.txt"), "kept");

      const second = runCli();
      expect(second.status, second.output).toBe(0);
      expect(second.stdout).toContain("1 synced");
      expect(second.output).not.toContain("orphaned directory");
      expect(await fs.readdir(worktreeDir)).not.toContain(".removed");
      await expect(fs.readFile(path.join(featurePath, "work.txt"), "utf8")).resolves.toBe("kept");
    },
    120_000,
  );
});
