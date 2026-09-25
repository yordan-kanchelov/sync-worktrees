import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";

// Real git, no mocks. simple-git only rejects a command that exits non-zero
// *and* wrote to stderr (`isTaskError` is `exitCode && stdErr.length`), so a
// probe that reports its answer through the exit code alone — `show-ref
// --verify --quiet`, `merge-base --is-ancestor` — resolves whatever the answer
// was and every ref reads as present. The ref probes must therefore keep stdout
// enabled so a missing ref produces `fatal: ... not a valid ref` on stderr.
describe("GitService ref existence probes (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let gitService: GitService;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-ref-probes-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

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
    await seed.raw(["push", "origin", "refs/heads/main:refs/heads/feature/only-on-origin"]);
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    gitService = new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir } satisfies GitServiceOptions,
      createMockLogger(),
    );
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports a branch that exists on neither side as missing", async () => {
    await expect(gitService.branchExists("nope")).resolves.toEqual({ local: false, remote: false });
  });

  it("reports a branch that only origin has as remote-only", async () => {
    // The local ref is genuinely absent here: a probe that cannot see a missing
    // ref would answer "local: true" and let a caller skip creating the branch.
    await expect(gitService.branchExists("feature/only-on-origin")).resolves.toEqual({ local: false, remote: true });
  });

  it("reports the checked-out default branch on both sides", async () => {
    await expect(gitService.branchExists("main")).resolves.toEqual({ local: true, remote: true });
  });

  // Why the probes above spell out `show-ref --verify <ref>` and never add
  // `--quiet`: git answers "missing" with exit 1 and an empty stderr, which
  // simple-git resolves. Pin the difference so the flag cannot come back.
  it("shows that --quiet would hide a missing ref from simple-git", async () => {
    const bareGit = simpleGit(bareRepoDir);

    await expect(bareGit.raw(["show-ref", "--verify", "--quiet", "refs/heads/nope"])).resolves.toBe("");
    await expect(bareGit.raw(["show-ref", "--verify", "refs/heads/nope"])).rejects.toThrow(/not a valid ref/);
  });
});
