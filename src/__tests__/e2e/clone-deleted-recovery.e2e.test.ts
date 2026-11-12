import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

// A long-lived process (daemon, TUI, MCP server) reuses one service. A clone
// removed out-of-band between ticks has to be re-cloned on the next sync
// rather than failing (directory gone) or soft-skipping forever (.git gone).
describe("Clone mode recovers a clone deleted out-of-band (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let seed: string;
  let cloneDir: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

  const makeConfig = (): Config =>
    ({
      repoUrl: `file://${remote}`,
      worktreeDir: cloneDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      skipLfs: true,
      __configFileDir: tempDir,
    }) as Config;

  const syncOutcome = async (service: WorktreeSyncService) => {
    const result = await service.sync();
    if (!result.started) throw new Error(`sync did not start: ${result.reason}`);
    return result.outcome;
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-clone-recover-")));
    remote = path.join(tempDir, "app.git");
    seed = path.join(tempDir, "app-seed");
    cloneDir = path.join(tempDir, "checkout");

    execFileSync("git", ["init", "--bare", "-q", remote]);
    await fs.mkdir(seed, { recursive: true });
    execFileSync("git", ["init", "-q", seed]);
    git(seed, "config", "user.name", "Test User");
    git(seed, "config", "user.email", "test@example.com");
    await fs.writeFile(path.join(seed, "one.txt"), "one\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "one");
    git(seed, "branch", "-M", "main");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-q", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("re-clones on the next sync after the whole directory is removed", async () => {
    const service = new WorktreeSyncService(makeConfig());
    expect((await syncOutcome(service)).counts.created).toBe(1);

    await fs.rm(cloneDir, { recursive: true, force: true });

    const outcome = await syncOutcome(service);
    expect(outcome.counts.created).toBe(1);
    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("re-clones into the emptied directory after its contents (and .git) are removed", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await syncOutcome(service);

    for (const entry of await fs.readdir(cloneDir)) {
      await fs.rm(path.join(cloneDir, entry), { recursive: true, force: true });
    }

    const outcome = await syncOutcome(service);
    expect(outcome.counts.created).toBe(1);
    expect(outcome.counts.skipped).toBe(0);
    expect(await fs.readdir(cloneDir)).toEqual(expect.arrayContaining([".git", "one.txt"]));
  });
});
