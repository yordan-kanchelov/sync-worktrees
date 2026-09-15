import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV_CONSTANTS } from "../../constants";
import { CloneSyncService } from "../../services/clone-sync.service";
import { GitService } from "../../services/git.service";
import { createMockLogger, setEnvVar } from "../test-utils";

import type { Config } from "../../types";
import type { Logger } from "../../services/logger.service";

// Real git, driven through a wrapper that stays silent before handing over —
// but only for `fetch --unshallow`, so everything else in the tick runs at full
// speed and the assertion can be about that one command.
//
// Removing `depth` is how a clone-mode repository is unshallowed, and that
// fetch transfers the entire history the shallow clone skipped: clone-sized
// work reached through a fetch. Running it on the fetch budget meant a repo
// whose full history took longer to enumerate than fetchTimeoutMs could never
// unshallow — SIGINT'd every tick, the partial pack thrown away, the error
// escaping as a hard sync failure — while the clone that first created it was
// allowed three times as long for the very same bytes. cloneTimeoutMs is what
// bounds it now; the two are set far apart here so which one is in force is
// decisive in both directions.
describe("Unshallow runs on the clone inactivity budget (E2E)", () => {
  const SILENCE_MS = 2000;
  const FETCH_TIMEOUT_MS = 1000;

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let shimDir: string;
  let logger: Logger;

  const originalPath = process.env.PATH;
  const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

  const makeConfig = (cloneTimeoutMs: number): Config =>
    ({
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir: path.join(tempDir, ".bare", "app"),
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      skipLfs: true,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      cloneTimeoutMs,
    }) as Config;

  const buildService = (cloneTimeoutMs: number): CloneSyncService => {
    const config = makeConfig(cloneTimeoutMs);
    return new CloneSyncService(config, new GitService(config, logger), logger);
  };

  const isShallow = async (): Promise<string> =>
    (await simpleGit(worktreeDir).raw(["rev-parse", "--is-shallow-repository"])).trim();

  // Puts the slow wrapper ahead of the real git on PATH. createGitClient hands
  // each child the (sanitized) process environment, so this reaches every git
  // the service spawns from here on.
  const useSlowGit = (): void => {
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-unshallow-timeout-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "clone");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    for (const n of [1, 2, 3]) {
      await fs.writeFile(path.join(seedDir, `file-${n}.txt`), `commit ${n}\n`);
      await seed.add(".");
      await seed.commit(`Commit ${n}`);
    }
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    // The shallow clone the config's `depth` would have produced, made with
    // plain git (no shim, no timeouts) so only the unshallow runs slowly.
    await simpleGit().clone(`file://${remote}`, worktreeDir, [
      "--branch",
      "main",
      "--single-branch",
      "--no-tags",
      "--depth",
      "1",
    ]);
    expect(await isShallow()).toBe("true");

    shimDir = path.join(tempDir, "shim");
    await fs.mkdir(shimDir);
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    await fs.writeFile(
      path.join(shimDir, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" --unshallow "*) sleep ${SILENCE_MS / 1000} ;;\nesac\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    // The unit suite disables the inactivity timeouts process-wide; this test
    // is about them, so it opts back out.
    delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

    logger = createMockLogger();
  });

  afterEach(async () => {
    setEnvVar("PATH", originalPath);
    setEnvVar(ENV_CONSTANTS.UNIT_TEST_SHORTCUT, originalShortcut);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("unshallows a clone whose fetch stays quiet for longer than fetchTimeoutMs", async () => {
    const service = buildService(SILENCE_MS * 10);
    await service.initialize();
    useSlowGit();

    await expect(service.runSyncAttempt()).resolves.toBeUndefined();

    expect(await isShallow()).toBe("false");
    expect((await simpleGit(worktreeDir).raw(["rev-list", "--count", "HEAD"])).trim()).toBe("3");
  });

  it("still kills an unshallow that goes quiet for longer than cloneTimeoutMs", async () => {
    // The other direction: raising the budget must not have disarmed the kill.
    // A wedged transfer produces no progress at all — `--progress` feeds the
    // timer only while bytes are actually moving — so the guard still ends the
    // attempt, just at the clone-sized budget.
    const service = buildService(FETCH_TIMEOUT_MS / 2);
    await service.initialize();
    useSlowGit();

    await expect(service.runSyncAttempt()).rejects.toThrow(/block timeout reached/i);
    expect(await isShallow()).toBe("true");
  });
});
