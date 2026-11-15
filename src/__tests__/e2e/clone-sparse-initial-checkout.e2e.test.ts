import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A smudge filter that logs every path it is asked to produce stands in for
// git-lfs downloading an object. With sparseCheckout set, the initial clone
// must only ever produce the paths the cone keeps, each exactly once: a full
// checkout narrowed afterwards writes (and downloads) everything first.
describe("clone-mode initial clone with sparseCheckout", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let configPath: string;
  let gitConfigPath: string;
  let smudgeLog: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-sparse-clone-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "checkout");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    gitConfigPath = path.join(tempDir, "count.gitconfig");
    smudgeLog = path.join(tempDir, "smudge.log");
    const smudgeScript = path.join(tempDir, "count-smudge.sh");

    await fs.writeFile(smudgeScript, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(smudgeLog)}\nexec cat\n`, {
      mode: 0o755,
    });
    await fs.writeFile(
      gitConfigPath,
      `[filter "count"]\n\tsmudge = ${smudgeScript} %f\n\tclean = cat\n\trequired = true\n`,
    );

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(path.join(seedDir, "pkg", "sub"), { recursive: true });
    await fs.mkdir(path.join(seedDir, "other"), { recursive: true });
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, ".gitattributes"), "*.dat filter=count\n");
    await fs.writeFile(path.join(seedDir, "top.dat"), "top\n");
    await fs.writeFile(path.join(seedDir, "pkg", "a.dat"), "a\n");
    await fs.writeFile(path.join(seedDir, "pkg", "sub", "b.dat"), "b\n");
    await fs.writeFile(path.join(seedDir, "other", "c.dat"), "c\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });

    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: ${JSON.stringify(`file://${remote}`)},
      worktreeDir: ${JSON.stringify(worktreeDir)},
      mode: "clone",
      branch: "main",
      sparseCheckout: { include: ["pkg"] },
      retry: { maxAttempts: 1, initialDelayMs: 0 }
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("never smudges out-of-cone paths and smudges in-cone paths once", async () => {
    const run = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("1 synced");

    const smudged = (await fs.readFile(smudgeLog, "utf8")).split("\n").filter(Boolean).sort();
    // Cone mode always keeps top-level files.
    expect(smudged).toEqual(["pkg/a.dat", "pkg/sub/b.dat", "top.dat"]);

    await expect(fs.readFile(path.join(worktreeDir, "pkg", "sub", "b.dat"), "utf8")).resolves.toBe("b\n");
    await expect(fs.access(path.join(worktreeDir, "other"))).rejects.toThrow();
    const status = execFileSync("git", ["-C", worktreeDir, "status", "--porcelain"], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    expect(status.trim()).toBe("");
  }, 60_000);
});
