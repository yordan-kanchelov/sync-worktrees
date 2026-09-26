import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DryRunReport } from "../../cli/dry-run";
import type { SyncDryRunPlan, SyncDryRunStep } from "../../services/sync-plan";

// `sync --dry-run` through the built CLI against real git. What it must
// promise: the plan names what the next sync does — and the sync that follows
// does exactly that — while the dry run itself leaves every worktree, branch,
// registration, config and trash entry byte-for-byte as it found them. The one
// documented write is the fetch, which moves remote-tracking refs (and brings
// in their objects); a second dry run, with nothing new to fetch, leaves the
// whole tree identical including those.
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

  // Every file under `root` by relative path, as a content hash (symlinks by
  // their target), plus every directory. `ignore` drops paths the one
  // documented write — the fetch — may touch.
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
          // A pruning fetch rewrites packed-refs when the ref it drops was
          // packed, so its remote-tracking lines belong to the fetch too.
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

  // Files the dry run's fetch owns: remote-tracking refs, the objects they
  // brought, FETCH_HEAD. Everything else in the bare repository — local
  // branches, config, worktree registrations and their indexes — is compared.
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

    // Origin moves on: a new branch, new commits on three, one deleted.
    await commitOnRemote("fresh", "fresh-1.txt");
    await commitOnRemote("behind", "behind-2.txt");
    await commitOnRemote("dirty", "dirty-2.txt");
    await commitOnRemote("diverged", "diverged-remote.txt");
    await simpleGit(remote).raw(["branch", "-D", "gone"]);
    // Local state: uncommitted work in one worktree, a local commit in another.
    await fs.writeFile(path.join(paths.dirty, "dirty-1.txt"), "edited locally\n");
    const divergedGit = simpleGit(paths.diverged);
    await divergedGit.addConfig("user.name", "Test User");
    await divergedGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(paths.diverged, "local.txt"), "local\n");
    await divergedGit.add(".");
    await divergedGit.commit("local work");
    // Same content, new mtime: the status checks a dry run makes would
    // rewrite these worktrees' index with the new stat data unless the dry
    // run keeps git's optional locks off.
    const later = new Date(Date.now() + 60_000);
    for (const branch of ["behind", "excluded", "gone"]) {
      await fs.utimes(path.join(paths[branch], "README.md"), later, later);
    }
    // And the config stops wanting one branch.
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

    // Nothing but what the fetch owns has changed.
    const after = await snapshot(
      tempDir,
      (rel) => rel.startsWith("remote") || rel.startsWith("seed") || fetchOwned(rel),
    );
    expect(after).toEqual(before);
    await expect(fs.access(path.join(worktreeDir, ".trash"))).rejects.toThrow();

    // With nothing new to fetch, a second dry run leaves the whole tree —
    // remote-tracking refs, objects and FETCH_HEAD included — identical.
    const settled = await snapshot(tempDir, (rel) => rel.startsWith("remote") || rel.startsWith("seed"));
    const [again] = dryRunJson(configPath);
    expect(planOf(again).steps).toEqual(plan.steps);
    expect(await snapshot(tempDir, (rel) => rel.startsWith("remote") || rel.startsWith("seed"))).toEqual(settled);

    // The human report says the same.
    const text = run(["--config", configPath, "--dry-run"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/\+ create\s+fresh/);
    expect(text.stdout).toMatch(/↑ update\s+behind\s+fast-forward: 1 commit behind origin\/behind/);
    expect(text.stdout).toMatch(/✗ remove\s+gone\s+fully pushed, remote branch deleted; moved to trash/);
    expect(text.stdout).toMatch(/⇄ replace\s+diverged/);
    expect(text.stdout).toMatch(/⏭ skip\s+dirty\s+working tree has local changes/);
    expect(text.stdout).toContain("1 to create, 1 to update, 2 to remove, 1 to replace, 1 skipped");

    // And the sync that follows does what the plan said.
    const sync = run(["--config", configPath, "--run-once"]);
    expect(sync.status).toBe(0);
    await expect(fs.access(paths.gone)).rejects.toThrow();
    await expect(fs.access(paths.excluded)).rejects.toThrow();
    await expect(fs.access(path.join(await worktreeOf("fresh"), "fresh-1.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(paths.behind, "behind-2.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(paths.diverged, "diverged-remote.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(paths.diverged, "local.txt"))).rejects.toThrow();
    expect(await fs.readFile(path.join(paths.dirty, "dirty-1.txt"), "utf-8")).toBe("edited locally\n");

    // A plan after that sync has nothing left but the dirty skip.
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
    // Not even the lock directory: the project directory was never created.
    await expect(fs.access(project)).rejects.toThrow();
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

    // Local changes: the same skip the sync would record.
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
    // Under `depth` the fetch may move the shallow boundary, as documented.
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

    // The sync the plan warned about: it deepens and fast-forwards.
    expect(run(["--config", configPath, "--run-once"]).status).toBe(0);
    await expect(fs.access(path.join(cloneDir, "main-3.txt"))).resolves.toBeUndefined();

    // A wide refspec is narrowed by the sync first; the plan says so and
    // leaves the config alone.
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
