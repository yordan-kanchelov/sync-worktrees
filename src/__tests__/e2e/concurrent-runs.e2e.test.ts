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

type RaceOutcome = "run" | "budget";

const LOSER_EXIT_BUDGET_MS = 8_000;

const PARK_OBSERVATION_BUDGET_MS = 2_000;

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
    tempDir = "";
    gatePath = "";
    parkLogPath = "";

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

    await fs.mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await fs.writeFile(
      shim,
      `#!/bin/sh\n` +
        `subcommand=$(\n` +
        `  while [ "$#" -gt 0 ]; do\n` +
        `    case "$1" in\n` +
        `      (-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)\n` +
        `        shift\n` +
        `        [ "$#" -gt 0 ] && shift\n` +
        `        ;;\n` +
        `      (-*) shift ;;\n` +
        `      (*) printf '%s' "$1"; break ;;\n` +
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
    if (gatePath) await fs.writeFile(gatePath, "").catch(() => undefined);
    for (const child of started) child.kill("SIGKILL");
    await Promise.allSettled(settled);
    settled.length = 0;
    started.clear();
    setEnvVar(LOCK_DIR, originalLockDir);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

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

  async function countParkedFetches(): Promise<number> {
    const raw = await fs.readFile(parkLogPath, "utf8").catch(() => "");
    return raw.split("\n").filter((line) => line.length > 0).length;
  }

  async function waitForParkedFetch(): Promise<number> {
    const deadline = Date.now() + PARK_OBSERVATION_BUDGET_MS;
    for (;;) {
      const parked = await countParkedFetches();
      if (parked > 0 || Date.now() >= deadline) return parked;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("lets exactly one process sync and makes the other skip with exit code 0", async () => {
    const seed = await startCli(false);
    expect(seed.status, seed.stdout + seed.stderr).toBe(0);
    expect(seed.stdout).toContain("1 synced");
    settled.length = 0;

    const runs = [startCli(), startCli()];
    const raceOutcome = await raceOrBudget(runs);
    const parkedWhileContending = await waitForParkedFetch();
    await fs.writeFile(gatePath, "");
    const results = await Promise.all(runs);

    const outputs = results.map((result) => result.stdout + result.stderr);
    const skippers = results.filter((result) => result.stderr.includes("Another process holds the sync lock"));
    const joined = [
      `race ended on: ${raceOutcome}; fetches parked while contending: ${parkedWhileContending}`,
      ...outputs,
    ].join("\n----\n");

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
    expect(winner?.stdout, joined).toMatch(/: 1 synced, 0 failed/);
    expect(winner?.stderr, joined).not.toContain("Another process holds the sync lock");

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
