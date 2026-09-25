import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV_CONSTANTS } from "../../constants";
import { ConfigLoaderService } from "../../services/config-loader.service";
import { GitService } from "../../services/git.service";
import { createMockLogger, setEnvVar } from "../test-utils";

import type { GitServiceOptions } from "../../services/git.service";
import type { Logger } from "../../services/logger.service";

// Real git, driven through a wrapper that stays silent for 400 ms before
// handing over. simple-git's `timeout.block` resets only on stdout/stderr
// data, so any command that quiet is killed with SIGINT once the window
// passes: that is exactly what `git worktree add` looks like while it checks
// out a large repository, and a monorepo whose checkout took longer than
// fetchTimeoutMs (5 min by default) could never be created — every tick
// SIGINT'd it, every tick recorded create_failed. Local commands therefore run
// on clients built without the inactivity kill, while network commands keep
// it. fetchTimeoutMs is set to 100 ms here so the 400 ms silence is decisive
// in both directions.
describe("Inactivity timeout applies to network commands only (E2E)", () => {
  const SILENCE_MS = 400;
  const FETCH_TIMEOUT_MS = 100;

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featPath: string;
  let shimDir: string;
  let logger: Logger;
  let gitService: GitService;

  const originalPath = process.env.PATH;
  const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

  // Puts the slow wrapper ahead of the real git on PATH. createGitClient hands
  // each child the (sanitized) process environment, so this reaches every git
  // the service spawns from here on.
  const useSlowGit = (): void => {
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-block-timeout-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featPath = path.join(worktreeDir, "feat");

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
    await seed.checkoutLocalBranch("feat");
    await fs.writeFile(path.join(seedDir, "feat.txt"), "feat work");
    await seed.add(".");
    await seed.commit("Add feat");
    await seed.push("origin", "feat");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    // The bare repository is prepared with plain git (no shim, no timeouts) so
    // only the commands under test run slowly.
    await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
    await simpleGit().clone(`file://${remote}`, bareRepoDir, ["--bare"]);
    const bare = simpleGit(bareRepoDir);
    await bare.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await bare.fetch(["--all"]);

    shimDir = path.join(tempDir, "shim");
    await fs.mkdir(shimDir);
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    await fs.writeFile(path.join(shimDir, "git"), `#!/bin/sh\nsleep ${SILENCE_MS / 1000}\nexec "${realGit}" "$@"\n`, {
      mode: 0o755,
    });

    // The unit suite disables the inactivity timeouts process-wide; this test
    // is about them, so it opts back out.
    delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

    logger = createMockLogger();
    const options: GitServiceOptions = {
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      skipLfs: true,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
    };
    gitService = new GitService(options, logger);
  });

  afterEach(async () => {
    setEnvVar("PATH", originalPath);
    setEnvVar(ENV_CONSTANTS.UNIT_TEST_SHORTCUT, originalShortcut);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates a worktree whose git commands stay silent longer than fetchTimeoutMs", async () => {
    useSlowGit();

    await expect(gitService.addWorktree("feat", featPath)).resolves.toEqual({
      status: "created",
      head: expect.stringMatching(/^[0-9a-f]{7,40}$/),
    });

    await expect(fs.access(path.join(featPath, ".git"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(featPath, "feat.txt"))).resolves.toBeUndefined();
  });

  it("still kills a network command that goes quiet for longer than fetchTimeoutMs", async () => {
    useSlowGit();

    // initialize() reaches `git fetch --all` on the bare repository — a network
    // command, so the inactivity kill is still armed there.
    await expect(gitService.initialize()).rejects.toThrow(/block timeout reached/i);
  });

  /**
   * Everything above hands GitService a Config built in the test. That is how
   * both timeouts were only ever exercised, and it is why nobody noticed that
   * resolveRepositoryConfig rebuilt the repository config from an allowlist
   * that named neither of them: a config file could say anything it liked and
   * every run still used the 5- and 15-minute built-ins. These go through the
   * real loader instead, so the window under test is the one a written config
   * file actually produces.
   */
  describe("configured through a config file", () => {
    // The loader only accepts a non-zero window of at least one second, so
    // these run with a 1 s window behind a wrapper that is silent for 1.5 s —
    // but only in front of `fetch` and `clone`, the commands under test, so a
    // run that has to get all the way through initialize() does not pay the
    // silence on every local command.
    const CONFIG_TIMEOUT_MS = 1_000;
    const NETWORK_SILENCE_MS = 1_500;

    const useSlowNetworkGit = async (): Promise<void> => {
      const networkShimDir = path.join(tempDir, "network-shim");
      await fs.mkdir(networkShimDir, { recursive: true });
      const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
      await fs.writeFile(
        path.join(networkShimDir, "git"),
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          `  case "$arg" in fetch|clone) sleep ${NETWORK_SILENCE_MS / 1000}; break ;; esac`,
          "done",
          `exec "${realGit}" "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${networkShimDir}${path.delimiter}${originalPath ?? ""}`;
    };

    // Builds the service the CLI would build: a config file on disk, resolved
    // by ConfigLoaderService, and the resolved repository handed straight to
    // GitService the way WorktreeSyncService does.
    const serviceFromConfigFile = async (options: {
      defaults?: string;
      repo?: string;
      bareRepoDirOverride?: string;
    }): Promise<GitService> => {
      const configPath = path.join(tempDir, "sync-worktrees.config.js");
      await fs.writeFile(
        configPath,
        `export default {\n` +
          `  ${options.defaults ?? ""}repositories: [\n` +
          `    {\n` +
          `      name: "app",\n` +
          `      repoUrl: ${JSON.stringify(`file://${remote}`)},\n` +
          `      worktreeDir: ${JSON.stringify(worktreeDir)},\n` +
          `      bareRepoDir: ${JSON.stringify(options.bareRepoDirOverride ?? bareRepoDir)},\n` +
          `      skipLfs: true,\n` +
          `      ${options.repo ?? ""}\n` +
          `    },\n` +
          `  ],\n` +
          `};\n`,
      );

      const { repositories } = await new ConfigLoaderService().buildRepositories(configPath);
      expect(repositories).toHaveLength(1);
      return new GitService(repositories[0], logger);
    };

    it("kills a silent fetch at the fetchTimeoutMs written on the repository entry", async () => {
      const service = await serviceFromConfigFile({ repo: `fetchTimeoutMs: ${CONFIG_TIMEOUT_MS},` });
      await useSlowNetworkGit();

      await expect(service.initialize()).rejects.toThrow(/block timeout reached/i);
    });

    it("kills a silent fetch at a fetchTimeoutMs inherited from defaults", async () => {
      const service = await serviceFromConfigFile({
        defaults: `defaults: { fetchTimeoutMs: ${CONFIG_TIMEOUT_MS} },\n  `,
      });
      await useSlowNetworkGit();

      await expect(service.initialize()).rejects.toThrow(/block timeout reached/i);
    });

    it("disables the kill entirely at fetchTimeoutMs 0, which beats a defaults value", async () => {
      // 0 has to mean "no inactivity kill", not "kill immediately": simple-git
      // only installs its timeout plugin for a positive block, and so do both
      // services. With the same silence that fails the two tests above, this
      // one has to get all the way through initialize().
      const service = await serviceFromConfigFile({
        defaults: `defaults: { fetchTimeoutMs: ${CONFIG_TIMEOUT_MS} },\n  `,
        repo: "fetchTimeoutMs: 0,",
      });
      await useSlowNetworkGit();

      await expect(service.initialize()).resolves.toBeDefined();
    });

    it("kills the silent bare clone at the cloneTimeoutMs written in defaults", async () => {
      // A bare repository that does not exist yet, so initialize() clones it —
      // the one command on the clone budget. fetchTimeoutMs is disabled here so
      // that nothing else in the run can produce a block timeout.
      const service = await serviceFromConfigFile({
        defaults: `defaults: { fetchTimeoutMs: 0, cloneTimeoutMs: ${CONFIG_TIMEOUT_MS} },\n  `,
        bareRepoDirOverride: path.join(tempDir, ".bare", "fresh-clone"),
      });
      await useSlowNetworkGit();

      await expect(service.initialize()).rejects.toThrow(/block timeout reached/i);
    });
  });
});
