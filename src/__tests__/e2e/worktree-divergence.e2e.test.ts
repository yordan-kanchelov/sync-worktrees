import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RefScanScope, WorktreeStatusService } from "../../services/worktree-status.service";
import { createMockLogger } from "../test-utils";

import type { SimpleGit } from "simple-git";

// Real git, answering for itself how far a worktree is from its upstream.
//
// `git status -b` already prints `## <branch>...<upstream> [ahead N, behind M]`
// and simple-git parses it, so the status snapshot can report ahead/behind
// without the separate `rev-list --left-right --count HEAD...@{upstream}` the
// MCP layer used to spawn per worktree on a client of its own. What that
// rev-list is owed is its tolerance: a worktree with nothing to compare against
// answered null rather than throwing, and null is what every caller reads as
// "cannot say". A fabricated 0/0 there would read as "in sync".
//
// Spawns are counted with a `git` shim first on PATH: every client the service
// builds carries the parent environment (see sanitizeGitEnv), so a shim
// installed before the service is constructed sees every git process it runs.
describe("Worktree divergence from the status snapshot (E2E)", () => {
  let tempDir: string;
  let worktreesDir: string;
  let shimLog: string;
  let originalPath: string | undefined;

  const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();

  // Named so each case says what it is measuring; the branch name is the
  // worktree directory name.
  const AHEAD = "ahead-two";
  const BEHIND = "behind-one";
  const DIVERGED = "diverged-one-one";
  const IN_SYNC = "in-sync";
  const NO_UPSTREAM = "no-upstream";
  const GONE = "gone-upstream";
  // Tracks a local branch (`branch.<name>.remote = "."`), not a remote-tracking
  // ref. `git status -b` prints the same ahead/behind header for it, and the
  // rev-list this replaced answered for it too -- so it is a real divergence,
  // even though the upstream is nothing `git branch -r` will ever list. A
  // guard that demanded a remote-tracking upstream would quietly turn this
  // into null, and judging it against the remote-tracking refs used to call
  // it gone (FU-T101-1).
  const LOCAL_UPSTREAM = "local-upstream";
  // Tracks a local branch that has since been deleted.
  const LOCAL_GONE = "local-upstream-gone";
  const BRANCHES = [AHEAD, BEHIND, DIVERGED, IN_SYNC, NO_UPSTREAM, GONE, LOCAL_UPSTREAM, LOCAL_GONE];

  const worktreeFor = (branch: string): string => path.join(worktreesDir, branch);

  async function commitIn(git: SimpleGit, name: string): Promise<void> {
    await fs.writeFile(path.join(await git.revparse(["--show-toplevel"]), `${name}.txt`), `${name}\n`);
    await git.add(".");
    await git.commit(name);
  }

  // Pushes a commit straight to the upstream repository, behind the bare
  // clone's back, so the bare clone can then fetch it and be "behind".
  async function pushRemoteCommitTo(upstream: string, branch: string, name: string): Promise<void> {
    const scratch = path.join(tempDir, `scratch-${branch}`);
    await simpleGit().clone(upstream, scratch, ["--branch", branch]);
    const git = simpleGit(scratch);
    await git.addConfig("user.name", "Test User");
    await git.addConfig("user.email", "test@example.com");
    await commitIn(git, name);
    await git.push("origin", branch);
    await fs.rm(scratch, { recursive: true, force: true });
  }

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-divergence-")));
    worktreesDir = path.join(tempDir, "worktrees");
    await fs.mkdir(worktreesDir, { recursive: true });

    const upstream = path.join(tempDir, "upstream.git");
    await simpleGit().init(["--bare", upstream]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await commitIn(seed, "initial");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", upstream);
    await seed.push("origin", "main");
    for (const branch of BRANCHES) {
      await seed.checkoutBranch(branch, "main");
      await commitIn(seed, `seed-${branch}`);
      await seed.push("origin", branch);
    }
    await fs.rm(seedDir, { recursive: true, force: true });

    const bareRepo = path.join(tempDir, "app.git");
    await simpleGit().clone(upstream, bareRepo, ["--bare"]);
    const bare = simpleGit(bareRepo);
    // `clone --bare` records no fetch refspec, so remote-tracking refs (which
    // is what @{upstream} resolves to) would never appear without this.
    await bare.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await bare.fetch("origin");

    for (const branch of BRANCHES) {
      await bare.raw(["worktree", "add", worktreeFor(branch), branch]);
      const wt = simpleGit(worktreeFor(branch));
      await wt.addConfig("user.name", "Test User");
      await wt.addConfig("user.email", "test@example.com");
      await wt.raw(["branch", `--set-upstream-to=origin/${branch}`, branch]);
    }

    await commitIn(simpleGit(worktreeFor(AHEAD)), "local-a");
    await commitIn(simpleGit(worktreeFor(AHEAD)), "local-b");
    await commitIn(simpleGit(worktreeFor(DIVERGED)), "local-c");
    await pushRemoteCommitTo(upstream, BEHIND, "remote-a");
    await pushRemoteCommitTo(upstream, DIVERGED, "remote-b");
    await bare.fetch("origin");

    await simpleGit(worktreeFor(NO_UPSTREAM)).raw(["branch", "--unset-upstream", NO_UPSTREAM]);
    // Each branch is main plus its own seed commit, so this one is exactly one
    // commit ahead of the local branch it now tracks.
    await simpleGit(worktreeFor(LOCAL_UPSTREAM)).raw(["branch", "--set-upstream-to=main", LOCAL_UPSTREAM]);
    await bare.raw(["branch", "doomed-base", "main"]);
    await simpleGit(worktreeFor(LOCAL_GONE)).raw(["branch", "--set-upstream-to=doomed-base", LOCAL_GONE]);
    await bare.raw(["branch", "-D", "doomed-base"]);
    await simpleGit(upstream).raw(["branch", "-D", GONE]);
    await bare.fetch(["--prune", "origin"]);

    // Install the shim last: nothing above it should be counted.
    const shimDir = path.join(tempDir, "shim");
    await fs.mkdir(shimDir, { recursive: true });
    shimLog = path.join(tempDir, "spawns.log");
    await fs.writeFile(
      path.join(shimDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(shimLog, "");
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  }, 120_000);

  afterAll(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    originalPath = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function spawnedCommands(): Promise<string[]> {
    return (await fs.readFile(shimLog, "utf-8")).split("\n").filter((line) => line.length > 0);
  }

  it.each([
    { branch: IN_SYNC, expected: { ahead: 0, behind: 0 } },
    { branch: AHEAD, expected: { ahead: 2, behind: 0 } },
    { branch: BEHIND, expected: { ahead: 0, behind: 1 } },
    { branch: DIVERGED, expected: { ahead: 1, behind: 1 } },
    { branch: LOCAL_UPSTREAM, expected: { ahead: 1, behind: 0 } },
  ])("reports $branch as $expected", async ({ branch, expected }) => {
    const service = new WorktreeStatusService({}, createMockLogger());

    const status = await service.getFullWorktreeStatus(worktreeFor(branch));

    expect(status.divergence).toEqual(expected);
    // The same numbers git itself produces from the command this replaced.
    const counts = await simpleGit(worktreeFor(branch)).raw([
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ]);
    expect(counts.trim().split(/\s+/)).toEqual([String(expected.ahead), String(expected.behind)]);
  });

  // Strictly null, never undefined and never 0/0: a caller distinguishes "no
  // upstream to compare against" from "level with its upstream".
  it.each([{ branch: NO_UPSTREAM }, { branch: GONE }, { branch: LOCAL_GONE }])(
    "reports $branch divergence as null rather than zero",
    async ({ branch }) => {
      const service = new WorktreeStatusService({}, createMockLogger());

      const status = await service.getFullWorktreeStatus(worktreeFor(branch));

      expect(status.divergence).toBeNull();
      // Precondition: the command this replaced could not answer here either.
      await expect(
        simpleGit(worktreeFor(branch)).raw(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
      ).rejects.toThrow();
    },
  );

  it("answers without spawning a rev-list against @{upstream}", async () => {
    await fs.writeFile(shimLog, "");
    const service = new WorktreeStatusService({}, createMockLogger());

    const status = await service.getFullWorktreeStatus(worktreeFor(DIVERGED));
    expect(status.divergence).toEqual({ ahead: 1, behind: 1 });

    const commands = await spawnedCommands();
    // Guard the guard: if the shim ever stopped being seen, the assertions
    // below would pass while proving nothing.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((command) => command.includes("@{upstream}") && command.startsWith("rev-list"))).toEqual([]);
    expect(commands.filter((command) => command.includes("--left-right"))).toEqual([]);
    // One `status` is what carries the answer, and there is only one.
    expect(commands.filter((command) => command.startsWith("status "))).toHaveLength(1);
  });

  // upstreamGone is judged against the upstream git itself derives from
  // branch.<b>.remote/merge (see RefScan): a remote-tracking ref for a remote,
  // a local branch for `remote = .`.
  it.each([
    { branch: IN_SYNC, gone: false },
    { branch: AHEAD, gone: false },
    { branch: NO_UPSTREAM, gone: false },
    // FU-T101-1: a healthy branch tracking a local branch is not stale.
    { branch: LOCAL_UPSTREAM, gone: false },
    // FU-T101-2: a pruned upstream, where `rev-parse @{upstream}` exits 128.
    { branch: GONE, gone: true },
    { branch: LOCAL_GONE, gone: true },
  ])("reports upstreamGone=$gone for $branch", async ({ branch, gone }) => {
    const service = new WorktreeStatusService({}, createMockLogger());

    const status = await service.getFullWorktreeStatus(worktreeFor(branch));

    expect(status.upstreamGone).toBe(gone);
    expect(status.reasons.includes("upstream gone")).toBe(gone);
  });

  it("confirms the pruned upstream is one `rev-parse @{upstream}` cannot name", async () => {
    await expect(
      simpleGit(worktreeFor(GONE)).raw(["rev-parse", "--abbrev-ref", `${GONE}@{upstream}`]),
    ).rejects.toThrow();
  });

  // The per-tick cost: what a pass over every worktree of the repository
  // spawns. `branch`, `branch -r` and `rev-parse @{upstream}` are gone from
  // every snapshot, and the branch/remote-ref listing runs once for the
  // repository when the pass shares a RefScanScope.
  it("scans the repository's refs once per pass, not once per worktree", async () => {
    const worktrees = BRANCHES.map(worktreeFor);
    const probeAll = async (refScans?: RefScanScope): Promise<string[]> => {
      await fs.writeFile(shimLog, "");
      const service = new WorktreeStatusService({}, createMockLogger());
      await Promise.all(worktrees.map((wt) => service.getFullWorktreeStatus(wt, false, { refScans })));
      return spawnedCommands();
    };
    const count = (commands: string[], prefix: string): number =>
      commands.filter((command) => command.startsWith(prefix)).length;

    const shared = await probeAll(new RefScanScope());
    const unshared = await probeAll();

    expect(count(shared, "for-each-ref ")).toBe(1);
    expect(count(unshared, "for-each-ref ")).toBe(worktrees.length);
    for (const commands of [shared, unshared]) {
      expect(count(commands, "status ")).toBe(worktrees.length);
      expect(count(commands, "branch")).toBe(0);
      expect(count(commands, "rev-parse")).toBe(0);
    }
    // Per worktree: status, stash list, submodule status and one unpushed
    // rev-list; plus the one scan. It used to be seven per worktree.
    expect(shared).toHaveLength(4 * worktrees.length + 1);
    expect(unshared).toHaveLength(5 * worktrees.length);
  });
});
