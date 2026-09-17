import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { setEnvVar } from "../test-utils";

import type { ChildProcess } from "child_process";

const LOCK_DIR = ENV_CONSTANTS.LOCK_DIR;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What ended the wait below: a CLI that exited, or the budget running out. */
type RaceOutcome = "run" | "budget";

// How long to wait for one of the two CLIs to exit before releasing the parked
// fetch, so a broken lock cannot hang the run. It is a bound on the failure
// case rather than a sleep the passing run pays: nothing parks the loser, and
// it exits in about a second, some twenty times inside this budget. Reaching
// it is asserted as a failure — but it is reached whenever no child exits in
// time FOR ANY REASON, a cold or oversubscribed runner included, so the
// direction is a false failure and never a false green.
const LOSER_EXIT_BUDGET_MS = 8_000;

// How long to keep looking for a parked fetch once the loser has exited. The
// winner is already parked or a few git subprocesses away from it, so only a
// broken arrangement pays this budget in full.
const PARK_OBSERVATION_BUDGET_MS = 2_000;

// Two real `dist/index.js --runOnce` processes against one repository, which
// is the only arrangement that exercises the cross-process lock: everything
// else in the suite either runs the services in-process (where the lock is
// short-circuited for unit tests) or spawns the CLI one process at a time.
//
// Contention is made deterministic rather than raced. A `git` shim first on
// the children's PATH parks every `git fetch` until a gate file appears, and
// the gate is only written once one of the two processes has exited — so
// whichever process acquires the lock first holds it, parked, for as long as
// the other one is alive. Each process takes the lock twice, at `initialize()`
// and again at `sync()`, and a fetch follows each acquire closely enough that
// the release-and-reacquire window between the two cannot be reached while the
// loser is still alive: exactly one syncs and the other reports contention. If
// the lock stops working, neither process parks behind the other, the gate
// opens on the budget above, and both sync — which is what the assertions
// below catch.
//
// That arrangement is load-bearing, so the test observes it instead of
// assuming it: the shim records each fetch that arrives while the gate is
// still shut, and the test reads that record before opening the gate and fails
// if it is empty. Without the check, a shim that stopped engaging — a `noexec`
// tmpdir, or a git invocation it no longer recognises — would quietly turn
// this back into the plain race it was written to replace, and still pass.
describe("Two concurrent CLI processes contend for the repo lock (E2E)", () => {
  const binaryPath = path.join(__dirname, "../../../dist/index.js");
  const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();
  const originalLockDir = process.env[LOCK_DIR];
  const started = new Set<ChildProcess>();
  const settled: Array<Promise<CliRun>> = [];
  let tempDir = "";
  let bareRepo = "";
  let worktreeDir = "";
  let bareRepoDir = "";
  let configPath = "";
  let shimDir = "";
  let gatePath = "";
  let parkLogPath = "";

  beforeEach(async () => {
    // Cleared before anything here can throw: afterEach runs even when this
    // hook fails, and it must not chase paths from a previous iteration.
    tempDir = "";
    gatePath = "";
    parkLogPath = "";

    // The lock path is derived from the canonical worktreeDir; an inherited
    // override would move both children off the directory asserted below.
    delete process.env[LOCK_DIR];
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-concurrent-")));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");
    shimDir = path.join(tempDir, "shim");
    gatePath = path.join(tempDir, "release-fetch");
    parkLogPath = path.join(tempDir, "parked-fetches");

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

    // The shim parks a fetch until the gate exists, with a cap of its own so a
    // crashed test can never leave a git waiting forever. It appends a line
    // BEFORE it starts waiting, so the test can read the evidence while the
    // fetch is still parked rather than only once the gate has released it.
    //
    // It picks the SUBCOMMAND out of argv rather than matching argv as a
    // whole: simple-git's commandConfigPrefixingPlugin puts `-c key=value`
    // pairs ahead of the subcommand as soon as a `config` array is passed, and
    // a prefix match would stop recognising the fetch the day one is added,
    // parking nothing and leaving the assertions below with no arrangement to
    // rest on.
    await fs.mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await fs.writeFile(
      shim,
      `#!/bin/sh\n` +
        `subcommand=$(\n` +
        `  while [ "$#" -gt 0 ]; do\n` +
        `    case "$1" in\n` +
        `      -c|-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)\n` +
        `        shift\n` +
        `        [ "$#" -gt 0 ] && shift\n` +
        `        ;;\n` +
        `      -*) shift ;;\n` +
        `      *) printf '%s' "$1"; break ;;\n` +
        `    esac\n` +
        `  done\n` +
        `)\n` +
        `if [ "$subcommand" = "fetch" ]; then\n` +
        `  if [ ! -e '${gatePath}' ]; then printf 'parked\\n' >> '${parkLogPath}'; fi\n` +
        `  waited=0\n` +
        `  while [ ! -e '${gatePath}' ] && [ "$waited" -lt 200 ]; do sleep 0.1; waited=$((waited + 1)); done\n` +
        `fi\n` +
        `exec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    // Release before killing: the shim is a shell loop in a grandchild that
    // killing the CLI would orphan, and an open gate ends it immediately.
    if (gatePath) await fs.writeFile(gatePath, "").catch(() => undefined);
    for (const child of started) child.kill("SIGKILL");
    await Promise.allSettled(settled);
    settled.length = 0;
    started.clear();
    setEnvVar(LOCK_DIR, originalLockDir);
    // Guarded: if mkdtemp itself threw there is nothing to remove, and
    // fs.rm(undefined) would bury that failure under ERR_INVALID_ARG_TYPE.
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  // NODE_ENV is pinned to production the way a daemon or a cron tick runs, so
  // the test cannot be read as depending on the environment vitest happens to
  // export. The rest of the environment is inherited, with two deliberate
  // edits: SYNC_WORKTREES_LOCK_DIR is dropped so both children derive the lock
  // path asserted below, and PATH is prefixed with the shim. That leaves the
  // vitest worker's SYNC_WORKTREES_UNIT_TEST in place, whose value is that
  // worker's own pid and so never matches either child.
  function childEnv(usingShim: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete env[LOCK_DIR];
    if (usingShim) env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
    return env;
  }

  function startCli(usingShim = true): Promise<CliRun> {
    const child = spawn(process.execPath, [binaryPath, "--config", configPath, "--runOnce"], {
      env: childEnv(usingShim),
      stdio: ["ignore", "pipe", "pipe"],
    });
    started.add(child);
    const run = new Promise<CliRun>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        started.delete(child);
        reject(error);
      });
      child.on("close", (status) => {
        started.delete(child);
        resolve({ status, stdout, stderr });
      });
    });
    settled.push(run);
    return run;
  }

  async function raceOrBudget(runs: Array<Promise<CliRun>>): Promise<RaceOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<RaceOutcome>((resolve) => {
      timer = setTimeout(() => resolve("budget"), LOSER_EXIT_BUDGET_MS);
    });
    const exits = runs.map(async (run): Promise<RaceOutcome> => {
      await run;
      return "run";
    });
    try {
      return await Promise.race([...exits, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // One line per `git fetch` that reached the shim while the gate was shut.
  // Absent or empty means no fetch was ever parked — the shim never matched.
  async function countParkedFetches(): Promise<number> {
    const raw = await fs.readFile(parkLogPath, "utf8").catch(() => "");
    return raw.split("\n").filter((line) => line.length > 0).length;
  }

  // The winner is parked, or a couple of git subprocesses short of it, by the
  // time the loser exits — so this returns almost immediately whenever the
  // arrangement holds, and returns 0 only when nothing is parking fetches.
  async function waitForParkedFetch(): Promise<number> {
    const deadline = Date.now() + PARK_OBSERVATION_BUDGET_MS;
    for (;;) {
      const parked = await countParkedFetches();
      if (parked > 0 || Date.now() >= deadline) return parked;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("lets exactly one process sync and makes the other skip with exit code 0", async () => {
    // Clone once up front so both contenders reach the lock with the same work
    // ahead of them, which is the daemon-plus-cron-tick case the lock is for.
    const seed = await startCli(false);
    expect(seed.status, seed.stdout + seed.stderr).toBe(0);
    expect(seed.stdout).toContain("1 synced");
    settled.length = 0;

    const runs = [startCli(), startCli()];
    const raceOutcome = await raceOrBudget(runs);
    // Counted before the gate opens: after that every fetch sails through, and
    // a count taken then would say nothing about the contention above.
    const parkedWhileContending = await waitForParkedFetch();
    await fs.writeFile(gatePath, "");
    const results = await Promise.all(runs);

    const outputs = results.map((result) => result.stdout + result.stderr);
    const skippers = results.filter((result) => result.stderr.includes("Another process holds the sync lock"));
    const joined = [
      `race ended on: ${raceOutcome}; fetches parked while contending: ${parkedWhileContending}`,
      ...outputs,
    ].join("\n----\n");

    // The arrangement, before the outcome it produces: with no fetch parked,
    // nothing held the lock across the other process's lifetime, and whatever
    // the two did below they did by racing.
    expect(parkedWhileContending, joined).toBeGreaterThan(0);
    expect(raceOutcome, joined).toBe("run");

    expect(skippers, joined).toHaveLength(1);
    for (const result of results) expect(result.status, joined).toBe(0);

    const skipped = skippers[0];
    expect(skipped.stdout, joined).toContain("0 synced, 1 skipped, 0 failed");
    expect(skipped.stdout, joined).not.toContain("Synchronization finished");
    expect(skipped.stderr, joined).not.toContain("lock unavailable");

    const winner = results.find((result) => result !== skipped);
    expect(winner, joined).toBeDefined();
    expect(winner?.stdout, joined).toContain("Synchronization finished");
    expect(winner?.stdout, joined).toMatch(/1 synced, 0 (skipped|with clone-mode skips), 0 failed/);
    expect(winner?.stderr, joined).not.toContain("Another process holds the sync lock");

    // Where the worktreeDir-keyed lock file lands. It is NOT the file the two
    // contended on: worktree mode takes the bare-repo lock first and returns
    // early when it cannot, so the loser is ELOCKED on `<tempDir>/.bare.lock`
    // and never reaches this one, and the stat below is satisfied by the seed
    // run, which took and released this lock on its way through. What the two
    // assertions pin is the derivation — the directory the lock lives in, and
    // a filename keyed on the worktreeDir alone, so a pid or any other
    // per-process component creeping into it fails the stat, because the path
    // the test computes is the vitest worker's own.
    const target = getWorktreeDirLockTarget({
      repoUrl: `file://${bareRepo}`,
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    });
    expect(target.dir).toBe(path.join(tempDir, ".sync-worktrees-locks"));
    const lockStats = await fs.stat(path.join(target.dir, target.file));
    expect(lockStats.isFile()).toBe(true);
  }, 120_000);
});
