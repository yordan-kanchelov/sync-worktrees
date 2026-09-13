import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CliRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

// A real SIGKILL in the window between `git clone` returning and the clone-init
// pending marker landing on disk. The clone is complete by then — a `.git` on
// the tracked branch next to a clean working tree — so the next run adopts it
// as a clone of ours or of the user's depending on one thing only: whether the
// marker got written before the process died. Without it the configured
// `filesToCopyOnBranchCreate` files are never copied, on that run or any later
// one, and nothing is logged about it.
//
// The kill is delivered by a `git` shim on PATH that kills its parent (the CLI)
// the moment git is asked to narrow `remote.origin.fetch` — the first git write
// of the post-clone setup. That is a genuine SIGKILL of the real CLI at a real
// point inside the window, not a mocked failure.
describe("CLI survives a kill between the clone and the clone-init marker", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  // Resolved lazily: at collection time a missing git would error the whole
  // file rather than fail as a test.
  let realGit: string;

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let configPath: string;
  let lockDir: string;
  let shimDir: string;

  beforeEach(async () => {
    realGit ??= execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-clone-init-window-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "checkout");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    lockDir = path.join(tempDir, "locks");
    shimDir = path.join(tempDir, "shim");

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
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });

    // The file the interrupted init owes the clone. It sits next to the config
    // file, which is the source directory clone mode copies from.
    await fs.writeFile(path.join(tempDir, ".env.local"), "SECRET=from-the-config-dir\n");
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
      filesToCopyOnBranchCreate: [".env.local"],
      retry: { maxAttempts: 1, initialDelayMs: 0 }
    }
  ]
};
`,
    );

    // `exec`s the real git for everything else, so the clone itself and every
    // later command are ordinary git. Only the refspec narrowing is replaced,
    // by a kill of the CLI that asked for it.
    await fs.mkdir(shimDir);
    await fs.writeFile(
      path.join(shimDir, "git"),
      `#!/bin/sh
case " $* " in
  *" --replace-all remote.origin.fetch "*)
    kill -9 "$PPID"
    exit 0
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(withKillShim: boolean): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      // Below the suite's own timeout, so a hung CLI surfaces as this spawn
      // timing out rather than as an opaque vitest timeout.
      timeout: 45_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SYNC_WORKTREES_LOCK_DIR: lockDir,
        PATH: withKillShim ? `${shimDir}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
      },
    });
    return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  }

  function pendingMarkerPath(): string {
    return path.join(worktreeDir, ".git", ".sync-worktrees-clone-init.pending");
  }

  it("resumes the dropped file copy on the next run", async () => {
    const killed = runCli(true);
    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL");

    // What the kill left behind: a finished clone that validates exactly like
    // one the user made, and no copied file.
    const status = await simpleGit(worktreeDir).raw(["status", "--short"]);
    expect(status.trim()).toBe("");
    expect((await simpleGit(worktreeDir).raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    await expect(fs.access(path.join(worktreeDir, "README.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(worktreeDir, ".env.local"))).rejects.toThrow();
    // The debt the next run has to find. Written before the narrowing, it is
    // already here; written after it, this is where the copy is lost for good.
    await expect(fs.access(pendingMarkerPath())).resolves.toBeUndefined();
    // The killed process never released its repo lock and nothing expires it
    // for ten minutes. Lock staleness is not what this test is about.
    await fs.rm(lockDir, { recursive: true, force: true });

    const resumed = runCli(false);
    const resumedOutput = resumed.stdout + resumed.stderr;
    expect(resumed.status, resumedOutput).toBe(0);
    expect(resumed.stdout).toContain("Completing interrupted initialization");
    expect(resumed.stdout).toContain(".env.local");
    await expect(fs.readFile(path.join(worktreeDir, ".env.local"), "utf8")).resolves.toBe(
      "SECRET=from-the-config-dir\n",
    );
    // Debt settled: the marker is gone, so a third run copies nothing again.
    await expect(fs.access(pendingMarkerPath())).rejects.toThrow();
  }, 60_000);
});
