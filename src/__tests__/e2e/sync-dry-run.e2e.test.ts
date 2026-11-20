import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DryRunReport } from "../../cli/dry-run";
import type { SyncDryRunPlan, SyncDryRunStep } from "../../services/sync-plan";

describe("sync --dry-run (E2E)", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let remote: string;
  let seedDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-dry-run-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);
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
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: tempDir,
      encoding: "utf-8",
      env: { ...process.env, HOME: tempDir, SYNC_WORKTREES_CONFIG: undefined, SYNC_WORKTREES_UNIT_TEST: undefined },
      input: "",
      timeout: 60000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function dryRunJson(configPath: string, extra: string[] = []): DryRunReport[] {
    const result = run(["--config", configPath, "--dry-run", "--json", ...extra]);
    expect(result.stderr).not.toContain("❌");
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as DryRunReport[];
  }

  function planOf(report: DryRunReport | undefined): SyncDryRunPlan {
    expect(report?.status).toBe("planned");
    return (report as Extract<DryRunReport, { status: "planned" }>).plan;
  }

  function stepFor(plan: SyncDryRunPlan, branch: string): SyncDryRunStep | undefined {
    return plan.steps.find((step) => step.branch === branch);
  }

  async function writeConfig(configPath: string, repositories: Array<Record<string, unknown>>): Promise<void> {
    await fs.writeFile(configPath, `export default { repositories: ${JSON.stringify(repositories)} };\n`);
  }

  async function commitOnRemote(branch: string, file: string, options: { from?: string } = {}): Promise<void> {
    const seed = simpleGit(seedDir);
    await seed.fetch("origin");
    const branches = await seed.branchLocal();
    if (branches.all.includes(branch)) {
      await seed.checkout(branch);
      await seed.reset(["--hard", `origin/${branch}`]).catch(() => undefined);
    } else {
      await seed.checkout(["-B", branch, options.from ?? "origin/main"]);
    }
    await fs.writeFile(path.join(seedDir, file), `${file}\n`);
    await seed.add(".");
    await seed.commit(`${branch}: ${file}`);
    await seed.push(["origin", `${branch}:${branch}`, "--force"]);
    await seed.checkout("main");
  }

  async function snapshot(root: string, ignore: (rel: string) => boolean = () => false): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    async function walk(dir: string): Promise<void> {
      for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, dirent.name);
        const rel = path.relative(root, full);
        if (ignore(rel)) continue;
        if (dirent.isSymbolicLink()) {
          entries.set(rel, `link:${await fs.readlink(full)}`);
        } else if (dirent.isDirectory()) {
          entries.set(rel, "dir");
          await walk(full);
        } else if (dirent.name === "packed-refs") {
          const kept = (await fs.readFile(full, "utf-8"))
            .split("\n")
            .filter((line) => !ignore("refs/remotes/") || !line.includes(" refs/remotes/"));
          entries.set(rel, createHash("sha256").update(kept.join("\n")).digest("hex"));
        } else {
          entries.set(
            rel,
            createHash("sha256")
              .update(await fs.readFile(full))
              .digest("hex"),
          );
        }
      }
    }
    await walk(root);
    return entries;
  }

  const fetchOwned = (rel: string): boolean =>
    /(^|\/)refs\/remotes(\/|$)/.test(rel) ||
    /(^|\/)objects(\/|$)/.test(rel) ||
    /(^|\/)FETCH_HEAD$/.test(rel) ||
    /(^|\/)logs\/refs\/remotes(\/|$)/.test(rel);

  it("plans creates, fast-forwards, prunes, diverged replacements and skips, and changes nothing", async () => {
    const project = path.join(tempDir, "project");
    const worktreeDir = path.join(project, "worktrees");
    const bareRepoDir = path.join(project, ".bare", "app");
    const configPath = path.join(project, "sync-worktrees.config.mjs");
    await fs.mkdir(project, { recursive: true });
    const repo = { name: "app", repoUrl: `file://${remote}`, worktreeDir, bareRepoDir };
    await writeConfig(configPath, [repo]);

    for (const branch of ["behind", "gone", "dirty", "diverged", "excluded"]) {
      await commitOnRemote(branch, `${branch}-1.txt`);
    }
    const first = run(["--config", configPath, "--run-once"]);
    expect(first.status).toBe(0);

    const worktreeOf = async (branch: string): Promise<string> => {
      const list = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
      const block = list
        .split("\n\n")
        .find(
          (entry) => entry.includes(`branch refs/heads/${branch}\n`) || entry.endsWith(`branch refs/heads/${branch}`),
        );
      const match = block ? /^worktree (.+)$/m.exec(block) : null;
      if (!match) throw new Error(`no worktree for ${branch}`);
      return match[1];
    };
    const paths = Object.fromEntries(
      await Promise.all(
        ["main", "behind", "gone", "dirty", "diverged", "excluded"].map(async (b) => [b, await worktreeOf(b)] as const),
      ),
    );

    await commitOnRemote("fresh", "fresh-1.txt");
    await commitOnRemote("behind", "behind-2.txt");
    await commitOnRemote("dirty", "dirty-2.txt");
    await commitOnRemote("diverged", "diverged-remote.txt");
    await simpleGit(remote).raw(["branch", "-D", "gone"]);
    await fs.writeFile(path.join(paths.dirty, "dirty-1.txt"), "edited locally\n");
    const divergedGit = simpleGit(paths.diverged);
    await divergedGit.addConfig("user.name", "Test User");
    await divergedGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(paths.diverged, "local.txt"), "local\n");
    await divergedGit.add(".");
    await divergedGit.commit("local work");
    const later = new Date(Date.now() + 60_000);
    for (const branch of ["behind", "excluded", "gone"]) {
      await fs.utimes(path.join(paths[branch], "README.md"), later, later);
    }
    await writeConfig(configPath, [{ ...repo, branchExclude: ["excluded"] }]);

    const before = await snapshot(
      tempDir,
      (rel) => rel.startsWith("remote") || rel.startsWith("seed") || fetchOwned(rel),
    );

    const [report] = dryRunJson(configPath);
    const plan = planOf(report);
    expect(plan.mode).toBe("worktree");
    expect(plan.fetched).toBe(true);
    expect(stepFor(plan, "fresh")).toMatchObject({ kind: "create", reason: "new_branch" });
    expect(stepFor(plan, "behind")).toMatchObject({ kind: "update", reason: "fast_forward", path: paths.behind });
    expect(stepFor(plan, "dirty")).toMatchObject({ kind: "skip", reason: "dirty_worktree" });
    expect(stepFor(plan, "diverged")).toMatchObject({
      kind: "replace",
      reason: "diverged_local_changes",
      preservedIn: "trash",
    });
    expect(stepFor(plan, "gone")).toMatchObject({
      kind: "remove",
      reason: "deleted_on_remote",
      basis: "fully_pushed_remote_deleted",
      disposal: "trash",
    });
    expect((stepFor(plan, "gone") as { message: string }).message).toContain("fully pushed, remote branch deleted");
    expect(stepFor(plan, "excluded")).toMatchObject({
      kind: "remove",
      reason: "excluded_by_filters",
      basis: "clean_and_pushed",
    });
    expect(stepFor(plan, "main")).toMatchObject({ kind: "noop", reason: "already_up_to_date" });

    const after = await snapshot(
      tempDir,
      (rel) => rel.startsWith("remote") || rel.startsWith("seed") || fetchOwned(rel),
    );
    expect(after).toEqual(before);
    await expect(fs.access(path.join(worktreeDir, ".trash"))).rejects.toThrow();

    const settled = await snapshot(tempDir, (rel) => rel.startsWith("remote") || rel.startsWith("seed"));
    const [again] = dryRunJson(configPath);
    expect(planOf(again).steps).toEqual(plan.steps);
    expect(await snapshot(tempDir, (rel) => rel.startsWith("remote") || rel.startsWith("seed"))).toEqual(settled);

    const text = run(["--config", configPath, "--dry-run"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/\+ create\s+fresh/);
    expect(text.stdout).toMatch(/↑ update\s+behind\s+fast-forward: 1 commit behind origin\/behind/);
    expect(text.stdout).toMatch(/✗ remove\s+gone\s+fully pushed, remote branch deleted; moved to trash/);
    expect(text.stdout).toMatch(/⇄ replace\s+diverged/);
    expect(text.stdout).toMatch(/⏭ skip\s+dirty\s+working tree has local changes/);
    expect(text.stdout).toContain("1 to create, 1 to update, 2 to remove, 1 to replace, 1 skipped");

    const sync = run(["--config", configPath, "--run-once"]);
    expect(sync.status).toBe(0);
    await expect(fs.access(paths.gone)).rejects.toThrow();
    await expect(fs.access(paths.excluded)).rejects.toThrow();
    await expect(fs.access(path.join(await worktreeOf("fresh"), "fresh-1.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(paths.behind, "behind-2.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(paths.diverged, "diverged-remote.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(paths.diverged, "local.txt"))).rejects.toThrow();
    expect(await fs.readFile(path.join(paths.dirty, "dirty-1.txt"), "utf-8")).toBe("edited locally\n");

    const [settledReport] = dryRunJson(configPath);
    const settledPlan = planOf(settledReport);
    expect(settledPlan.counts).toMatchObject({ create: 0, update: 0, remove: 0, replace: 0, skip: 1 });
  }, 120000);

  it("plans a repository that has not been cloned yet without creating anything", async () => {
    const project = path.join(tempDir, "project");
    const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await writeConfig(configPath, [
      {
        name: "app",
        repoUrl: `file://${remote}`,
        worktreeDir: path.join(project, "worktrees"),
        bareRepoDir: path.join(project, ".bare", "app"),
      },
      { name: "clone", mode: "clone", repoUrl: `file://${remote}`, worktreeDir: path.join(project, "clone") },
    ]);

    const reports = dryRunJson(configPath);
    expect(planOf(reports.find((r) => r.name === "app")).steps).toEqual([
      expect.objectContaining({ kind: "clone", path: path.join(project, ".bare", "app") }),
    ]);
    expect(planOf(reports.find((r) => r.name === "clone")).steps).toEqual([
      expect.objectContaining({ kind: "clone", branch: "main", path: path.join(project, "clone") }),
    ]);
    await expect(fs.access(project)).rejects.toThrow();
  }, 60000);

  function failedDryRun(configPath: string): string {
    const result = run(["--config", configPath, "--dry-run", "--json"]);
    expect(result.status).toBe(1);
    const [report] = JSON.parse(result.stdout) as DryRunReport[];
    expect(report?.status).toBe("failed");
    return (report as Extract<DryRunReport, { status: "failed" }>).error;
  }

  it("fails the plan, as the sync fails, for a clone destination that is not empty and not a repository", async () => {
    const cloneDir = path.join(tempDir, "project", "clone");
    const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await writeConfig(configPath, [
      { name: "clone", mode: "clone", repoUrl: `file://${remote}`, worktreeDir: cloneDir },
    ]);
    await fs.mkdir(cloneDir, { recursive: true });
    await fs.writeFile(path.join(cloneDir, "notes.txt"), "mine\n");

    expect(failedDryRun(configPath)).toContain("directory exists and is not empty");
    const sync = run(["--config", configPath, "--run-once"]);
    expect(sync.status).not.toBe(0);
    expect(sync.stdout + sync.stderr).toContain("directory exists and is not empty");
  }, 60000);

  it("fails the plan, as the sync fails, for a clone carrying the incomplete-clone marker", async () => {
    const cloneDir = path.join(tempDir, "project", "clone");
    const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await writeConfig(configPath, [
      { name: "clone", mode: "clone", repoUrl: `file://${remote}`, worktreeDir: cloneDir },
    ]);
    expect(run(["--config", configPath, "--run-once"]).status).toBe(0);
    await fs.writeFile(
      path.join(cloneDir, ".git", ".sync-worktrees-clone-incomplete"),
      `${new Date().toISOString()}\ncheckout failed\n`,
    );

    expect(failedDryRun(configPath)).toContain("did not complete (checkout failed)");
    const sync = run(["--config", configPath, "--run-once"]);
    expect(sync.status).not.toBe(0);
    expect(sync.stdout + sync.stderr).toContain("did not complete (checkout failed)");
  }, 60000);

  it("plans a clone-mode fast-forward, honours --filter, and leaves the clone as it was", async () => {
    const project = path.join(tempDir, "project");
    const cloneDir = path.join(project, "clone");
    const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await writeConfig(configPath, [
      { name: "clone", mode: "clone", repoUrl: `file://${remote}`, worktreeDir: cloneDir },
      { name: "other", repoUrl: `file://${remote}`, worktreeDir: path.join(project, "other") },
    ]);
    expect(run(["--config", configPath, "--run-once", "--filter", "clone"]).status).toBe(0);

    await commitOnRemote("main", "main-2.txt", { from: "origin/main" });
    const before = await snapshot(cloneDir, fetchOwned);

    const reports = dryRunJson(configPath, ["--filter", "clone"]);
    expect(reports.map((r) => r.name)).toEqual(["clone"]);
    const plan = planOf(reports[0]);
    expect(plan).toMatchObject({ mode: "clone", fetched: true });
    expect(plan.steps).toEqual([expect.objectContaining({ kind: "update", reason: "fast_forward", branch: "main" })]);
    expect(await snapshot(cloneDir, fetchOwned)).toEqual(before);
    await expect(fs.access(path.join(cloneDir, "main-2.txt"))).rejects.toThrow();

    await fs.writeFile(path.join(cloneDir, "README.md"), "edited\n");
    const dirty = planOf(dryRunJson(configPath, ["--filter", "clone"])[0]);
    expect(dirty.steps).toEqual([expect.objectContaining({ kind: "skip", reason: "clone_dirty_tree" })]);
  }, 60000);

  it("plans a depth-configured clone that is too shallow to classify, and says the sync deepens first", async () => {
    const project = path.join(tempDir, "project");
    const cloneDir = path.join(project, "clone");
    const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await writeConfig(configPath, [
      { name: "clone", mode: "clone", repoUrl: `file://${remote}`, worktreeDir: cloneDir, depth: 1 },
    ]);
    expect(run(["--config", configPath, "--run-once"]).status).toBe(0);

    await commitOnRemote("main", "main-2.txt", { from: "origin/main" });
    await commitOnRemote("main", "main-3.txt");
    const shallowFetchOwned = (rel: string): boolean => fetchOwned(rel) || rel === path.join(".git", "shallow");
    const before = await snapshot(cloneDir, shallowFetchOwned);

    const plan = planOf(dryRunJson(configPath)[0]);
    expect(plan.steps).toEqual([
      expect.objectContaining({ kind: "skip", reason: "clone_indeterminate_shallow", branch: "main" }),
    ]);
    const message = (plan.steps[0] as { message?: string }).message ?? "";
    expect(message).toContain("deepening up to 1000 commits is not simulated");
    expect(message).toContain("may then fast-forward");
    expect(message).not.toContain("no deepening attempted");
    expect(await snapshot(cloneDir, shallowFetchOwned)).toEqual(before);

    expect(run(["--config", configPath, "--run-once"]).status).toBe(0);
    await expect(fs.access(path.join(cloneDir, "main-3.txt"))).resolves.toBeUndefined();

    await simpleGit(cloneDir).raw([
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    const configBefore = await fs.readFile(path.join(cloneDir, ".git", "config"), "utf-8");
    const wide = planOf(dryRunJson(configPath)[0]);
    expect(wide.notes).toEqual([expect.stringContaining("narrows it to 'main'")]);
    expect(await fs.readFile(path.join(cloneDir, ".git", "config"), "utf-8")).toBe(configBefore);
  }, 90000);

  it("refuses --json without --dry-run", () => {
    const result = run(["--run-once", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--json is only available with --dry-run");
  });
});
