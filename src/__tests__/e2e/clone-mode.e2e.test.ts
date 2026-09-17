import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const shouldSkip = process.env.SKIP_E2E_TESTS === "true";
const describeOrSkip = shouldSkip ? describe.skip : describe;
const shouldRunNetworkE2E = process.env.RUN_NETWORK_E2E === "true";
const itNetwork = shouldRunNetworkE2E ? it : it.skip;

const HELLO_WORLD = "https://github.com/octocat/Hello-World.git";
const GITIGNORE = "https://github.com/github/gitignore.git";

describeOrSkip("Clone-mode E2E tests", () => {
  const cliPath = path.join(process.cwd(), "dist", "index.js");
  const tmpBase = path.join(process.cwd(), "tmp-e2e-clone-mode");

  beforeAll(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.mkdir(tmpBase, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  async function createLocalRemote(name: string): Promise<string> {
    const remoteBare = path.join(tmpBase, `${name}.git`);
    const seedDir = path.join(tmpBase, `${name}-seed`);

    await fs.mkdir(seedDir, { recursive: true });
    execSync(`git init --bare "${remoteBare}"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" init`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" config user.email "test@example.com"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(seedDir, "README.md"), "# Test Repository\n");
    execSync(`git -C "${seedDir}" add README.md`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Initial commit"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(seedDir, "one.txt"), "one\n");
    execSync(`git -C "${seedDir}" add one.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add one"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(seedDir, "two.txt"), "two\n");
    execSync(`git -C "${seedDir}" add two.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add two"`, { encoding: "utf-8" });

    execSync(`git -C "${seedDir}" branch -M main`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" remote add origin "${remoteBare}"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin main`, { encoding: "utf-8" });
    execSync(`git -C "${remoteBare}" symbolic-ref HEAD refs/heads/main`, { encoding: "utf-8" });

    return remoteBare;
  }

  async function pushCommit(remoteBare: string, name: string, fileName: string, message: string): Promise<string> {
    const pushDir = path.join(tmpBase, `${name}-push`);
    await fs.rm(pushDir, { recursive: true, force: true });

    execSync(`git clone "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(pushDir, fileName), `${message}\n`);
    execSync(`git -C "${pushDir}" add "${fileName}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" commit -m "${message}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" push origin main`, { encoding: "utf-8" });

    return execSync(`git -C "${pushDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
  }

  // Pushes `commits` extra commits onto main. Empty commits keep it cheap: what
  // the shallow-depth tests need is history length, not content. Returns the
  // working clone it pushed from, so a test can go on to rewrite that history.
  async function growRemote(remoteBare: string, name: string, commits: number): Promise<string> {
    const pushDir = path.join(tmpBase, `${name}-grow`);
    await fs.rm(pushDir, { recursive: true, force: true });
    execSync(`git clone "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });
    execSync(`for i in $(seq 1 ${commits}); do git commit -q --allow-empty -m "Grow $i"; done`, {
      encoding: "utf-8",
      cwd: pushDir,
    });
    execSync(`git -C "${pushDir}" push origin main`, { encoding: "utf-8" });
    return pushDir;
  }

  // Grows main by `rounds` merged pull requests: a two-commit side branch off
  // main, merged back with `--no-ff`. That is the commonest shape a real main
  // branch has, and the one that separates the two units `--depth` could be
  // ratcheted in: each round adds three commits but only one ancestry level.
  // Returns the working clone it pushed from, so a caller can keep growing it.
  async function growRemoteWithMerges(remoteBare: string, name: string, rounds: number): Promise<string> {
    const pushDir = path.join(tmpBase, `${name}-merge-grow`);
    await fs.rm(pushDir, { recursive: true, force: true });
    execSync(`git clone "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });
    pushMergeRounds(pushDir, `${name}-r`, rounds);
    return pushDir;
  }

  // One round of the same, pushed from an existing working clone.
  function pushMergeRounds(pushDir: string, prefix: string, rounds: number): void {
    execSync(
      `set -e
       for i in $(seq 1 ${rounds}); do
         git checkout -q -b "${prefix}$i"
         echo "$i" > "${prefix}$i-a.txt" && git add -A && git commit -q -m "${prefix}$i a"
         echo "$i" > "${prefix}$i-b.txt" && git add -A && git commit -q -m "${prefix}$i b"
         git checkout -q main
         git merge -q --no-ff -m "Merge ${prefix}$i" "${prefix}$i"
         git branch -q -D "${prefix}$i"
       done
       git push -q origin main`,
      { encoding: "utf-8", cwd: pushDir, shell: "/bin/bash" },
    );
  }

  async function writeSingleCloneConfig(
    name: string,
    repoUrl: string,
    worktreeDir: string,
    branch: string,
  ): Promise<string> {
    const configDir = path.dirname(worktreeDir);
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, `${name}.config.js`);
    const configContent = `
export default {
  defaults: { runOnce: true },
  repositories: [
    {
      name: "${name}",
      repoUrl: "${repoUrl}",
      worktreeDir: "${worktreeDir.replace(/\\/g, "/")}",
      mode: "clone",
      branch: "${branch}"
    }
  ]
};
`;
    await fs.writeFile(configPath, configContent);
    return configPath;
  }

  function writeCloneDepthConfig(
    configPath: string,
    repoUrl: string,
    worktreeDir: string,
    depthLine = "",
  ): Promise<void> {
    const configContent = `
export default {
  defaults: { runOnce: true },
  repositories: [
    {
      name: "depth-local",
      repoUrl: "${repoUrl}",
      worktreeDir: "${worktreeDir.replace(/\\/g, "/")}",
      mode: "clone",
      branch: "main"${depthLine}
    }
  ]
};
`;
    return fs.writeFile(configPath, configContent);
  }

  itNetwork(
    "clones directly into worktreeDir (no /branch subfolder, no .bare)",
    async () => {
      const worktreeDir = path.join(tmpBase, "single-clone", "wt");
      const configPath = await writeSingleCloneConfig("single", HELLO_WORLD, worktreeDir, "master");

      execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      const entries = await fs.readdir(worktreeDir);
      expect(entries).toContain(".git");
      expect(entries).toContain("README");
      expect(entries).not.toContain("master");
      expect(entries).not.toContain(".bare");

      const headBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, {
        encoding: "utf-8",
      }).trim();
      expect(headBranch).toBe("master");

      const remoteUrl = execSync(`git -C "${worktreeDir}" remote get-url origin`, {
        encoding: "utf-8",
      }).trim();
      expect(remoteUrl).toBe(HELLO_WORLD);
    },
    90000,
  );

  it("keeps shallow clone-mode materialized to the tracked branch only", async () => {
    const remoteBare = await createLocalRemote("remote-branches");
    const seedDir = path.join(tmpBase, "remote-branches-seed");
    execSync(`git -C "${seedDir}" switch -c "feat/cloudflare-deploys"`, { encoding: "utf-8" });
    await fs.writeFile(path.join(seedDir, "cloudflare.txt"), "cloudflare\n");
    execSync(`git -C "${seedDir}" add cloudflare.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add cloudflare deploys"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin "feat/cloudflare-deploys"`, { encoding: "utf-8" });

    const worktreeDir = path.join(tmpBase, "remote-branches", "wt");
    const configPath = path.join(tmpBase, "remote-branches", "remote-branches.config.js");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");

    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    const fetchRefspec = execSync(`git -C "${worktreeDir}" config --get-all remote.origin.fetch`, {
      encoding: "utf-8",
    }).trim();
    const remoteBranches = execSync(`git -C "${worktreeDir}" branch -r --list`, { encoding: "utf-8" });
    const discoveredBranches = execSync(`git -C "${worktreeDir}" ls-remote --heads origin`, { encoding: "utf-8" });
    const cloneHead = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf-8" }).trim();
    const isShallow = execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, {
      encoding: "utf-8",
    }).trim();

    expect(fetchRefspec).toBe("+refs/heads/main:refs/remotes/origin/main");
    expect(remoteBranches).not.toContain("origin/feat/cloudflare-deploys");
    expect(discoveredBranches).toContain("refs/heads/feat/cloudflare-deploys");
    expect(cloneHead).toBe("main");
    expect(isShallow).toBe("true");
  }, 60000);

  // A clone somebody is working in is not a reason to call the repository
  // out of sync: with nothing to merge, a dirty tree changes nothing about
  // where the clone stands relative to origin. It used to be asked first, so
  // every tick of a current-but-dirty clone printed a skip and the run summary
  // counted the repo as "with clone-mode skips" instead of synced (#T71).
  it("reports a dirty clone that is already at origin as up to date, and skips it once it could merge", async () => {
    const remoteBare = await createLocalRemote("dirty-current-remote");
    const configDir = path.join(tmpBase, "dirty-current");
    const worktreeDir = path.join(configDir, "wt");
    const configPath = path.join(configDir, "dirty-current.config.js");
    await fs.mkdir(configDir, { recursive: true });
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir);
    const command = `node "${cliPath}" --config "${configPath}" 2>&1`;
    const run = (): string =>
      execSync(command, { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });

    run();

    // Both kinds of local change `checkWorktreeStatus` looks for: a modified
    // tracked file and an untracked one.
    await fs.writeFile(path.join(worktreeDir, "README.md"), "# Locally edited\n");
    await fs.writeFile(path.join(worktreeDir, "scratch.txt"), "wip\n");
    const headBeforeTick = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();

    const dirtyButCurrent = run();

    expect(dirtyButCurrent).toContain("already up to date with origin/main");
    expect(dirtyButCurrent).not.toContain("working tree has local changes");
    expect(dirtyButCurrent).not.toContain("Clone-mode skips");
    expect(dirtyButCurrent).toMatch(/Processed 1 repo: 1 synced, 0 with clone-mode skips, 0 failed/);
    // Nothing was touched: the edits are still there and HEAD did not move.
    expect(await fs.readFile(path.join(worktreeDir, "README.md"), "utf-8")).toBe("# Locally edited\n");
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(headBeforeTick);

    // And the case the dirty check is actually for: once origin moves ahead,
    // the same dirty tree does block the fast-forward, and says so.
    await pushCommit(remoteBare, "dirty-current", "three.txt", "Add three");

    const dirtyAndBehind = run();

    expect(dirtyAndBehind).toContain("working tree has local changes");
    expect(dirtyAndBehind).toContain("Clone-mode skips");
    expect(dirtyAndBehind).toMatch(/Processed 1 repo: 0 synced, 1 with clone-mode skips, 0 failed/);
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(headBeforeTick);
  }, 90000);

  it("narrows legacy all-branches clone refspecs and deletes stale remote refs", async () => {
    const remoteBare = await createLocalRemote("legacy-remote-branches");
    const seedDir = path.join(tmpBase, "legacy-remote-branches-seed");
    execSync(`git -C "${seedDir}" switch -c "feat/cloudflare-deploys"`, { encoding: "utf-8" });
    await fs.writeFile(path.join(seedDir, "cloudflare.txt"), "cloudflare\n");
    execSync(`git -C "${seedDir}" add cloudflare.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add cloudflare deploys"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin "feat/cloudflare-deploys"`, { encoding: "utf-8" });

    const worktreeDir = path.join(tmpBase, "legacy-remote-branches", "wt");
    execSync(`git clone --branch main "file://${remoteBare}" "${worktreeDir}"`, {
      encoding: "utf-8",
    });

    const configPath = path.join(tmpBase, "legacy-remote-branches", "legacy.config.js");
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir);

    const beforeBranch = execSync(`git -C "${worktreeDir}" branch -r --list "origin/feat/cloudflare-deploys"`, {
      encoding: "utf-8",
    });
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    const fetchRefspec = execSync(`git -C "${worktreeDir}" config --get-all remote.origin.fetch`, {
      encoding: "utf-8",
    }).trim();
    const remoteBranches = execSync(`git -C "${worktreeDir}" branch -r --list`, { encoding: "utf-8" });

    expect(beforeBranch).toContain("origin/feat/cloudflare-deploys");
    expect(fetchRefspec).toBe("+refs/heads/main:refs/remotes/origin/main");
    expect(remoteBranches).not.toContain("origin/feat/cloudflare-deploys");
  }, 60000);

  // The sweep deletes in batches, and a batch has to stay best-effort: one ref
  // git refuses must not take the others down with it. A ref lock left behind
  // by a crashed git is the way that happens in the wild, and it is also what
  // separates the batch this ships from the single-transaction
  // `update-ref --stdin` — the measurement behind that choice is stated once,
  // beside the sweep in clone-sync.service.ts, and not repeated here.
  // Whether the locked ref itself survives is left unasserted:
  // it depends on where this git stores it — an entry in `packed-refs` is
  // removed by the transaction that rewrites that file, a loose ref is not.
  it("deletes the other stale remote refs when one of them is locked", async () => {
    const remoteBare = await createLocalRemote("locked-stale-ref");
    const seedDir = path.join(tmpBase, "locked-stale-ref-seed");
    for (const branch of ["stale-a", "stale-b", "stale-c"]) {
      execSync(`git -C "${seedDir}" push origin "main:${branch}"`, { encoding: "utf-8" });
    }

    const worktreeDir = path.join(tmpBase, "locked-stale-ref", "wt");
    execSync(`git clone --branch main "file://${remoteBare}" "${worktreeDir}"`, { encoding: "utf-8" });
    const lockDir = path.join(worktreeDir, ".git", "refs", "remotes", "origin");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "stale-b.lock"), "");

    const configPath = path.join(tmpBase, "locked-stale-ref", "locked.config.js");
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir);

    const output = execSync(`node "${cliPath}" --config "${configPath}" 2>&1`, {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const remoteBranches = execSync(`git -C "${worktreeDir}" branch -r --list`, { encoding: "utf-8" });
    expect(output).toMatch(/Processed 1 repo: 1 synced, 0 with clone-mode skips, 0 failed/);
    expect(remoteBranches).not.toContain("origin/stale-a");
    expect(remoteBranches).not.toContain("origin/stale-c");
    expect(remoteBranches).toContain("origin/main");
  }, 60000);

  itNetwork(
    "is idempotent on subsequent runs (no re-clone, fetch-only sync)",
    async () => {
      const worktreeDir = path.join(tmpBase, "idempotent-clone", "wt");
      const configPath = await writeSingleCloneConfig("idempotent", HELLO_WORLD, worktreeDir, "master");
      const command = `node "${cliPath}" --config "${configPath}"`;

      execSync(command, { encoding: "utf-8", timeout: 60000 });

      const secondRun = execSync(command, { encoding: "utf-8", timeout: 60000 });

      expect(secondRun).not.toContain("Cloning ");
      expect(secondRun).toContain("up to date with origin/master");
    },
    120000,
  );

  itNetwork(
    "soft-skips branch mismatch during initialize when checkout is on a different branch",
    async () => {
      const worktreeDir = path.join(tmpBase, "mismatch-clone", "wt");
      const configPath = await writeSingleCloneConfig("mismatch", HELLO_WORLD, worktreeDir, "master");
      const command = `node "${cliPath}" --config "${configPath}"`;

      execSync(command, { encoding: "utf-8", timeout: 60000 });

      execSync(`git -C "${worktreeDir}" checkout -b sidebranch`, { encoding: "utf-8" });

      const output = execSync(`${command} 2>&1`, {
        encoding: "utf-8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      expect(output).toMatch(/is on branch 'sidebranch', expected 'master'/);
      expect(output).toContain("Clone-mode skips");
      expect(output).toMatch(/clone is on 'sidebranch', expected 'master' \(since process start\)/);
      expect(output).toMatch(/Processed 1 repo: 0 synced, 1 with clone-mode skips, 0 failed/);
      expect(output).not.toContain("CONFIG_CLONE_BRANCH_MISMATCH");
    },
    120000,
  );

  itNetwork(
    "supports mixed config: one clone-mode repo + one worktree-mode repo",
    async () => {
      const configDir = path.join(tmpBase, "mixed-config");
      await fs.mkdir(configDir, { recursive: true });

      const cloneDir = path.join(configDir, "clone-repo");
      const worktreeRoot = path.join(configDir, "worktree-repo");
      const bareDir = path.join(configDir, ".bare-worktree");

      const configPath = path.join(configDir, "mixed.config.js");
      const configContent = `
export default {
  defaults: { cronSchedule: "0 * * * *", runOnce: true },
  repositories: [
    {
      name: "clone-side",
      repoUrl: "${HELLO_WORLD}",
      worktreeDir: "${cloneDir.replace(/\\/g, "/")}",
      mode: "clone",
      branch: "master"
    },
    {
      name: "worktree-side",
      repoUrl: "${GITIGNORE}",
      worktreeDir: "${worktreeRoot.replace(/\\/g, "/")}",
      bareRepoDir: "${bareDir.replace(/\\/g, "/")}",
      branchInclude: ["main"]
    }
  ]
};
`;
      await fs.writeFile(configPath, configContent);

      execSync(`node "${cliPath}" --config "${configPath}"`, {
        encoding: "utf-8",
        timeout: 180000,
        env: { ...process.env, NODE_ENV: "production" },
      });

      const cloneEntries = await fs.readdir(cloneDir);
      expect(cloneEntries).toContain(".git");
      expect(cloneEntries).toContain("README");
      expect(cloneEntries).not.toContain("master");
      const cloneHead = execSync(`git -C "${cloneDir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf-8" }).trim();
      expect(cloneHead).toBe("master");

      const bareExists = await fs
        .access(bareDir)
        .then(() => true)
        .catch(() => false);
      expect(bareExists).toBe(true);

      const worktreeEntries = await fs.readdir(worktreeRoot);
      expect(worktreeEntries).toContain("main");
      const mainWorktreePath = path.join(worktreeRoot, "main");
      const mainHead = execSync(`git -C "${mainWorktreePath}" rev-parse --abbrev-ref HEAD`, {
        encoding: "utf-8",
      }).trim();
      expect(mainHead).toBe("main");

      const lockDir = path.join(configDir, ".sync-worktrees-state");
      const lockExists = await fs
        .access(lockDir)
        .then(() => true)
        .catch(() => false);
      expect(lockExists).toBe(true);
    },
    240000,
  );

  it("creates a shallow clone from config depth and unshallows when depth is removed", async () => {
    const remoteBare = await createLocalRemote("depth-remote");
    const configDir = path.join(tmpBase, "depth-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "depth.config.js");
    const repoUrl = `file://${remoteBare}`;
    await fs.mkdir(configDir, { recursive: true });

    await writeCloneDepthConfig(configPath, repoUrl, worktreeDir, ",\n      depth: 1");

    execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    const shallowAfterClone = execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, {
      encoding: "utf-8",
    }).trim();
    expect(shallowAfterClone).toBe("true");
    expect(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim()).toBe("1");

    await writeCloneDepthConfig(configPath, repoUrl, worktreeDir);

    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    const shallowAfterDepthRemoval = execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, {
      encoding: "utf-8",
    }).trim();
    const commitCount = Number(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim());
    expect(secondRun).toContain("[deepen]");
    expect(shallowAfterDepthRemoval).toBe("false");
    expect(commitCount).toBeGreaterThan(1);
  }, 120000);

  // The sync fetch caps itself at `max(configured depth, the depth the clone
  // already has)`, so it bounds the transfer without ever asking for a shorter
  // window than the one the clone holds. Passing the configured depth on every
  // tick re-truncated instead: it re-grafted the tip it fetched, which cut the
  // parent link `merge-base HEAD origin/main` needs, so every remote advance
  // classified as indeterminate and bought the answer back with a 50-commit
  // deepen fetch that the next tick threw away again. What this pins is that
  // the deepen happens at most once: after it, the ratchet keeps asking for the
  // clone's own depth, so merge-base answers and the fast-forward path is
  // reached on the first try. The remote is grown past the first deepen target
  // on purpose — a remote shorter than 50 commits is completed by that deepen,
  // and a clone that is no longer shallow is not the case under test.
  it("deepens a shallow clone once and then fast-forwards later ticks without re-deepening", async () => {
    const remoteBare = await createLocalRemote("shallow-multi-commit-remote");
    await growRemote(remoteBare, "shallow-multi-commit", 60);
    const configDir = path.join(tmpBase, "shallow-multi-commit-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-multi-commit.config.js");
    const repoUrl = `file://${remoteBare}`;
    await fs.mkdir(configDir, { recursive: true });

    const countHead = (): number =>
      Number(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim());
    const countRemoteRef = (): number =>
      Number(
        execSync(`git -C "${worktreeDir}" rev-list --count refs/remotes/origin/main`, { encoding: "utf-8" }).trim(),
      );
    const readHead = (): string => execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
    const isShallow = (): string =>
      execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, { encoding: "utf-8" }).trim();

    await writeCloneDepthConfig(configPath, repoUrl, worktreeDir, ",\n      depth: 1");

    execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });
    expect(countHead()).toBe(1);
    expect(isShallow()).toBe("true");

    await pushCommit(remoteBare, "shallow-multi-commit", "three.txt", "Add three");
    await pushCommit(remoteBare, "shallow-multi-commit", "four.txt", "Add four");
    const headAfterThreePushes = await pushCommit(remoteBare, "shallow-multi-commit", "five.txt", "Add five");

    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    // A one-commit clone cannot classify anything: the remote moved past the
    // only commit it holds, so this tick does spend a deepen — once.
    expect(secondRun.match(/\[deepen]/g)).toHaveLength(1);
    expect(secondRun).toContain("refetching to depth 50 before deciding");
    expect(secondRun).not.toContain("Clone-mode skips");
    expect(readHead()).toBe(headAfterThreePushes);
    const countAfterSecondRun = countHead();
    expect(countAfterSecondRun).toBe(50);
    // The deepen bought a bounded amount of history, not the whole remote.
    expect(isShallow()).toBe("true");

    // Every later tick asks for the window the fetched ref holds, so merge-base
    // keeps answering and the deepen never repeats. Two more ticks, because the
    // reported defect was a deepen on *every* tick with new commits.
    let previousCount = countAfterSecondRun;
    for (const [index, file] of ["six.txt", "seven.txt"].entries()) {
      const pushedHead = await pushCommit(remoteBare, "shallow-multi-commit", file, `Add ${file}`);
      const run = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      expect(run, `tick ${index + 3}`).not.toContain("[deepen]");
      expect(run, `tick ${index + 3}`).not.toContain("Clone-mode skips");
      expect(readHead()).toBe(pushedHead);
      // The history the deepen paid for is never handed back. Both refs are
      // checked: these ticks end in a fast-forward, so HEAD is the fetched tip
      // here, and it is the fetched ref that the cap is measured from.
      expect(countHead(), `tick ${index + 3}`).toBeGreaterThanOrEqual(previousCount);
      expect(countRemoteRef(), `tick ${index + 3}`).toBeGreaterThanOrEqual(previousCount);
      expect(isShallow()).toBe("true");
      previousCount = countHead();
    }
  }, 300000);

  // The unit the cap is ratcheted in, end to end. `git fetch --depth N` counts N
  // ancestry *levels* from the fetched tip, and on a history built from merges a
  // level holds several commits — so a commit count is a much larger number than
  // the depth it was taken from. Feeding that back as the next `--depth` walks
  // the boundary deeper every tick until the clone holds the whole repository
  // and stops being shallow at all, at which point `depth` no longer bounds
  // anything: measured on git 2.43 over a 601-commit remote of merged
  // two-commit pull requests, a `depth: 1` clone ratcheted on `rev-list --count
  // HEAD` went 1 -> 147 -> 438 -> 610 commits in three ticks. Measuring levels
  // makes the cap a fixed point instead — the window a `--depth D` fetch
  // produced measures back as exactly D — which is what this pins: after the one
  // deepen the clone stops growing, and stays shallow.
  it("holds a merge-heavy shallow clone at the depth it deepened to", async () => {
    const remoteBare = await createLocalRemote("shallow-merge-growth-remote");
    const configDir = path.join(tmpBase, "shallow-merge-growth-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-merge-growth.config.js");
    await fs.mkdir(configDir, { recursive: true });

    // Deeper than the first deepen target on purpose: a remote inside 50 levels
    // would be completed by that deepen, and a clone that is no longer shallow
    // is not the case under test.
    const pushDir = await growRemoteWithMerges(remoteBare, "shallow-merge-growth", 120);
    const remoteTotal = Number(execSync(`git -C "${pushDir}" rev-list --count main`, { encoding: "utf-8" }).trim());
    expect(remoteTotal).toBe(363);

    const countHead = (): number =>
      Number(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim());
    const isShallow = (): string =>
      execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, { encoding: "utf-8" }).trim();
    const readHead = (): string => execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(countHead()).toBe(1);

    // Tick 2: the remote lands another pull request, the one-commit clone cannot
    // classify it, and the budget's first target resolves it — once.
    pushMergeRounds(pushDir, "shallow-merge-growth-t2", 1);
    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(secondRun.match(/\[deepen]/g)).toHaveLength(1);
    expect(secondRun).not.toContain("Clone-mode skips");
    const countAfterDeepen = countHead();
    expect(isShallow()).toBe("true");
    // 50 levels of this history is 147 commits — the two units are not the same
    // number — and still well under half the remote.
    expect(countAfterDeepen).toBeGreaterThan(50);
    expect(countAfterDeepen).toBeLessThan(remoteTotal / 2);

    // Three more pull requests, one per tick. Each one is a fast-forward on the
    // first classification, and leaves the clone exactly where the deepen put
    // it: no further deepening, no growth, still shallow.
    for (const tick of [3, 4, 5]) {
      pushMergeRounds(pushDir, `shallow-merge-growth-t${tick}`, 1);
      const remoteHead = execSync(`git -C "${pushDir}" rev-parse main`, { encoding: "utf-8" }).trim();
      const run = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      expect(run, `tick ${tick}`).not.toContain("[deepen]");
      expect(run, `tick ${tick}`).not.toContain("Clone-mode skips");
      expect(readHead(), `tick ${tick}`).toBe(remoteHead);
      expect(countHead(), `tick ${tick}`).toBe(countAfterDeepen);
      expect(isShallow(), `tick ${tick}`).toBe("true");
    }
  }, 300000);

  // The regression the cap exists for, end to end: a remote tip that is not a
  // descendant of the clone's tip. A shallow clone has no ancestors to offer as
  // `have`s, so an uncapped fetch has to pack the rewritten tip's whole
  // ancestry — measured on git 2.43 against a 199-commit remote of empty
  // commits force-pushed with `reset --hard HEAD~3` plus one commit, a
  // `depth: 1` clone took all 197 commits of the rewritten tip in a 201-object
  // pack uncapped, against 1 commit in a 3-object pack capped, and classified
  // `indeterminate_shallow` either way.
  // The device that lets the tick be observed: the clone is deepened first, by
  // an ordinary advance, so that the tick after the force-push can classify at
  // all. A decisive verdict — `diverged` here — ends the tick right after the
  // fetch, so what origin/main holds is exactly what the sync fetch asked for.
  // A one-commit clone cannot do that: it has no ancestry for merge-base to
  // answer with, so the tick spends the deepen budget instead and the budget's
  // own fetches overwrite the evidence.
  it("caps the sync fetch when the remote force-pushes off the clone's history", async () => {
    const remoteBare = await createLocalRemote("shallow-forcepush-remote");
    const configDir = path.join(tmpBase, "shallow-forcepush-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-forcepush.config.js");
    await fs.mkdir(configDir, { recursive: true });

    const countRemoteRef = (): number =>
      Number(
        execSync(`git -C "${worktreeDir}" rev-list --count refs/remotes/origin/main`, { encoding: "utf-8" }).trim(),
      );

    // Grow the remote well past the first deepen target, so the rewritten
    // ancestry is clearly bigger than the window the clone ends up holding.
    const pushDir = await growRemote(remoteBare, "shallow-forcepush", 60);

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim()).toBe("1");

    // One ordinary advance: the one-commit clone cannot classify it, the first
    // deepen target answers it, and the merge leaves HEAD on the fetched tip
    // with a window the ratchet will hold from here on.
    execSync(`git -C "${pushDir}" commit -q --allow-empty -m "Advance"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" push -q origin main`, { encoding: "utf-8" });
    const deepenRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    // Also the first proof that the sync fetch is capped: without `--depth` it
    // would have pulled the tip's whole ancestry and had no need to deepen.
    expect(deepenRun.match(/\[deepen]/g) ?? []).toHaveLength(1);
    const windowAfterDeepen = countRemoteRef();
    expect(windowAfterDeepen).toBe(50);

    execSync(`git -C "${pushDir}" reset --hard HEAD~3`, { encoding: "utf-8" });
    await fs.writeFile(path.join(pushDir, "rewritten.txt"), "rewritten\n");
    execSync(`git -C "${pushDir}" add rewritten.txt`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" commit -m "Rewrite history"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" push --force origin main`, { encoding: "utf-8" });
    const rewrittenAncestry = Number(
      execSync(`git -C "${pushDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim(),
    );
    expect(rewrittenAncestry).toBeGreaterThan(windowAfterDeepen);

    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    // The tick can tell what happened — the histories still meet, three commits
    // down — so it skips without spending the budget.
    expect(secondRun).toContain("has diverged from origin/main");
    expect(secondRun).not.toContain("[deepen]");
    // The cap held: the window the ratchet asks for, not the rewritten tip's
    // whole ancestry.
    expect(countRemoteRef()).toBe(windowAfterDeepen);
    expect(countRemoteRef()).toBeLessThan(rewrittenAncestry);

    // A second tick on the same divergence: the cap is measured from the ref it
    // caps, which now holds the rewritten tip, so it neither pulls the ancestry
    // the first tick refused nor cuts what was fetched.
    const thirdRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });
    expect(thirdRun).toContain("has diverged from origin/main");
    expect(thirdRun).not.toContain("[deepen]");
    expect(countRemoteRef()).toBe(windowAfterDeepen);
  }, 240000);

  // The ratchet measures the ref the fetch re-applies its depth to —
  // origin/<branch> — and not HEAD. The two are the same commit only on a tick
  // that ends in a fast-forward; a tick that fetches and then skips the merge
  // (a dirty tree here, but unpushed commits, a divergence or a tip too shallow
  // to classify do it too) leaves HEAD behind the fetched tip. Measuring HEAD
  // there reports less than the clone holds, so the cap asks for less than the
  // last fetch produced and the window shrinks — and shrinks further every
  // tick, because each truncation makes the next measurement smaller still.
  // Measured on git 2.43 against this shape, a HEAD-measured ratchet sent
  // `--depth` 50, 47, 41, 32, 20 and then 5 on successive dirty ticks, and
  // cleaning the tree afterwards cost a second deepen to buy the window back.
  it("holds the fetched window across ticks that fetch and skip the merge", async () => {
    const remoteBare = await createLocalRemote("shallow-dirty-window-remote");
    await growRemote(remoteBare, "shallow-dirty-window", 60);
    const configDir = path.join(tmpBase, "shallow-dirty-window-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-dirty-window.config.js");
    await fs.mkdir(configDir, { recursive: true });

    const countRef = (ref: string): number =>
      Number(execSync(`git -C "${worktreeDir}" rev-list --count ${ref}`, { encoding: "utf-8" }).trim());
    const isShallow = (): string =>
      execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, { encoding: "utf-8" }).trim();

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(countRef("HEAD")).toBe(1);

    // Tick 2 buys the window: the one-commit clone cannot classify the advance,
    // the budget's first target answers it, and the merge moves HEAD up to the
    // fetched tip.
    await growRemote(remoteBare, "shallow-dirty-window", 3);
    const deepenRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(deepenRun.match(/\[deepen]/g)).toHaveLength(1);
    const windowAfterDeepen = countRef("refs/remotes/origin/main");
    expect(windowAfterDeepen).toBe(50);

    // From here the worktree is dirty, so every tick fetches and stops before
    // the merge, leaving HEAD further behind the tip each time.
    await fs.writeFile(path.join(worktreeDir, "README.md"), "# Locally edited\n");

    for (const tick of [3, 4, 5]) {
      await growRemote(remoteBare, "shallow-dirty-window", 3);
      const run = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      expect(run, `tick ${tick}`).toContain("working tree has local changes");
      expect(run, `tick ${tick}`).not.toContain("[deepen]");
      // The window the deepen paid for is still there, undiminished, even
      // though HEAD has fallen behind it.
      expect(countRef("refs/remotes/origin/main"), `tick ${tick}`).toBe(windowAfterDeepen);
      expect(countRef("HEAD"), `tick ${tick}`).toBeLessThan(windowAfterDeepen);
      expect(isShallow(), `tick ${tick}`).toBe("true");
    }

    // And because the window held, the tick that finds the tree clean again
    // fast-forwards on the first classification instead of paying for a second
    // deepen.
    execSync(`git -C "${worktreeDir}" checkout -- README.md`, { encoding: "utf-8" });
    const cleanRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    expect(cleanRun).not.toContain("[deepen]");
    expect(cleanRun).not.toContain("Clone-mode skips");
    expect(countRef("refs/remotes/origin/main")).toBe(windowAfterDeepen);
    expect(countRef("HEAD")).toBe(windowAfterDeepen);
    expect(isShallow()).toBe("true");
  }, 300000);

  // The deepen budget is still spent for the case it exists for: a remote whose
  // branch was rewritten past the clone's shallow boundary, where the local tip
  // is no longer reachable from origin/main and merge-base cannot answer. The
  // deepening cannot un-graft a local tip the rewritten branch no longer
  // contains, so this one ends in the indeterminate skip — what it pins is that
  // the budget still runs, and that the clone is left exactly where it was.
  it("spends the deepen budget and skips when the remote branch was rewritten", async () => {
    const remoteBare = await createLocalRemote("shallow-rewritten-remote");
    const configDir = path.join(tmpBase, "shallow-rewritten-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-rewritten.config.js");
    await fs.mkdir(configDir, { recursive: true });

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    // Drop the two commits the clone's boundary sits on and build a different
    // history in their place.
    const pushDir = path.join(tmpBase, "shallow-rewritten-push");
    execSync(`git clone "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" reset --hard HEAD~2`, { encoding: "utf-8" });
    await fs.writeFile(path.join(pushDir, "rewritten.txt"), "rewritten\n");
    execSync(`git -C "${pushDir}" add rewritten.txt`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" commit -m "Rewrite history"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" push --force origin main`, { encoding: "utf-8" });

    const headBeforeSecondRun = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    expect(secondRun).toContain("refetching to depth 50 before deciding");
    expect(secondRun).toContain("could not classify origin/main");
    expect(secondRun).not.toContain("Fast-forwarding");
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(headBeforeSecondRun);
  }, 120000);

  // A merge is the case a capped fetch cannot classify on its own. The clone
  // never advertised the commits on the merged-in side, and the cap stops the
  // fetch from walking past the merge commit to reach the history the clone
  // does hold, so the tick starts out `indeterminate_shallow` where a linear
  // advance would have gone straight to `fast_forward`. What resolves it is the
  // deepen budget, and that is the point: the extra history comes in one
  // bounded 50-commit step, chosen by the budget, instead of being dragged in
  // by an uncapped fetch that follows the merged-in side down to wherever it
  // forked. This test pins the whole sequence so the README/changeset wording
  // cannot drift away from the behaviour.
  it("classifies a merge through the bounded deepen rather than an uncapped fetch", async () => {
    const remoteBare = await createLocalRemote("shallow-merge-remote");
    const configDir = path.join(tmpBase, "shallow-merge-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-merge.config.js");
    await fs.mkdir(configDir, { recursive: true });

    // Build this topology on the remote, with `side` forked below the commits
    // the clone's boundary will sit on:
    //   c1 - c2 - c3 - c4 - c5        <- main at clone time (boundary: c5)
    //         \
    //          s1 - s2                <- side
    const pushDir = path.join(tmpBase, "shallow-merge-push");
    execSync(`git clone "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });
    const gitRev = (ref: string): string =>
      execSync(`git -C "${pushDir}" rev-parse ${ref}`, { encoding: "utf-8" }).trim();
    const forkPoint = gitRev("HEAD~1");
    const commitOn = async (branchFile: string, message: string): Promise<void> => {
      await fs.writeFile(path.join(pushDir, branchFile), `${message}\n`);
      execSync(`git -C "${pushDir}" add "${branchFile}"`, { encoding: "utf-8" });
      execSync(`git -C "${pushDir}" commit -m "${message}"`, { encoding: "utf-8" });
    };
    await commitOn("four.txt", "Add four");
    await commitOn("five.txt", "Add five");
    execSync(`git -C "${pushDir}" push origin main`, { encoding: "utf-8" });
    // c4 and c3: the mainline commits that sit under the clone's shallow
    // boundary, so neither the clone nor the capped fetch has them.
    const cutMainlineCommits = [gitRev("HEAD~1"), gitRev("HEAD~2")];
    execSync(`git -C "${pushDir}" checkout -b side ${forkPoint}`, { encoding: "utf-8" });
    await commitOn("side-one.txt", "Add side one");
    await commitOn("side-two.txt", "Add side two");
    execSync(`git -C "${pushDir}" push origin side`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" checkout main`, { encoding: "utf-8" });

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    const countAfterClone = Number(
      execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim(),
    );
    expect(countAfterClone).toBe(1);

    execSync(`git -C "${pushDir}" merge --no-ff -m "Merge side" side`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" push origin main`, { encoding: "utf-8" });
    const mergeCommit = gitRev("HEAD");
    const remoteTotal = Number(execSync(`git -C "${pushDir}" rev-list --count main`, { encoding: "utf-8" }).trim());
    expect(remoteTotal).toBe(8);

    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    // The capped fetch brought the merge commit and nothing under it, so
    // merge-base could not answer and the budget's first target resolved it.
    expect(secondRun).toContain("[deepen]");
    expect(secondRun.match(/\[deepen]/g)).toHaveLength(1);
    expect(secondRun).toContain("refetching to depth 50 before deciding");
    expect(secondRun).not.toContain("Clone-mode skips");
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(mergeCommit);

    // One deepen to 50 over an eight-commit remote completes the clone: the
    // merged-in side, the fork point, and the two mainline commits that sat
    // under the old boundary all arrive together, and git drops the shallow
    // marker because nothing is left cut. A repository bigger than the target
    // would stop at 50 commits and stay shallow — the transfer is bounded by
    // the target either way, which is what the cap on the fetch preserves.
    const countAfterMerge = Number(
      execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim(),
    );
    expect(countAfterMerge).toBe(remoteTotal);
    for (const restored of cutMainlineCommits) {
      expect(() => execSync(`git -C "${worktreeDir}" cat-file -e ${restored}`, { stdio: "ignore" })).not.toThrow();
    }
    expect(execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, { encoding: "utf-8" }).trim()).toBe(
      "false",
    );
  }, 120000);

  // A directory whose `.git` is a gitdir pointer (a linked worktree, or a
  // submodule) shares the config and refs of the repository that owns it, so
  // clone mode's refspec narrowing and stale-ref deletion would land in THAT
  // repository — and repeat on every tick.
  it("refuses a linked worktree and leaves the parent repository's refspec and refs untouched", async () => {
    const remoteBare = await createLocalRemote("linked-worktree");
    const seedDir = path.join(tmpBase, "linked-worktree-seed");
    execSync(`git -C "${seedDir}" switch -c "feat/other"`, { encoding: "utf-8" });
    await fs.writeFile(path.join(seedDir, "other.txt"), "other\n");
    execSync(`git -C "${seedDir}" add other.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add other"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin "feat/other"`, { encoding: "utf-8" });

    const baseDir = path.join(tmpBase, "linked-worktree");
    const primaryDir = path.join(baseDir, "primary");
    const linkedDir = path.join(baseDir, "linked");
    await fs.mkdir(baseDir, { recursive: true });
    execSync(`git clone "file://${remoteBare}" "${primaryDir}"`, { encoding: "utf-8" });
    // Frees 'main' for the linked worktree — a branch can only be checked out once.
    execSync(`git -C "${primaryDir}" switch "feat/other"`, { encoding: "utf-8" });
    execSync(`git -C "${primaryDir}" worktree add "${linkedDir}" main`, { encoding: "utf-8" });

    const readPrimary = (): { refspec: string; refs: string } => ({
      refspec: execSync(`git -C "${primaryDir}" config --get-all remote.origin.fetch`, { encoding: "utf-8" }).trim(),
      refs: execSync(`git -C "${primaryDir}" for-each-ref --format="%(refname)" refs/remotes/origin`, {
        encoding: "utf-8",
      }).trim(),
    });
    const before = readPrimary();
    // Without a second remote-tracking ref to lose, the assertions below would
    // pass even with the guard removed.
    expect(before.refs).toContain("refs/remotes/origin/feat/other");
    expect(before.refspec).toBe("+refs/heads/*:refs/remotes/origin/*");
    const gitFile = await fs.readFile(path.join(linkedDir, ".git"), "utf-8");
    expect(gitFile).toMatch(/^gitdir: /);

    const configPath = await writeSingleCloneConfig("linked", `file://${remoteBare}`, linkedDir, "main");

    let status: number | undefined = 0;
    let output: string;
    try {
      output = execSync(`node "${cliPath}" --config "${configPath}"`, {
        encoding: "utf-8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
      status = err.status;
      output = String(err.stdout ?? "") + String(err.stderr ?? "");
    }

    expect(status).not.toBe(0);
    expect(output).toContain("CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT");
    expect(output).toContain(path.join(primaryDir, ".git"));
    expect(readPrimary()).toEqual(before);
  }, 60000);

  it("rejects clone mode combined with branchInclude (validation error)", async () => {
    const configPath = path.join(tmpBase, "bad-config.config.js");
    const configContent = `
export default {
  repositories: [
    {
      name: "bad-repo",
      repoUrl: "${HELLO_WORLD}",
      worktreeDir: "${path.join(tmpBase, "bad-repo-wt").replace(/\\/g, "/")}",
      mode: "clone",
      branchInclude: ["main"]
    }
  ]
};
`;
    await fs.writeFile(configPath, configContent);

    let stderr = "";
    try {
      execSync(`node "${cliPath}" list --config "${configPath}"`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
      stderr = String(err.stderr ?? "") + String(err.stdout ?? "");
      expect(err.status).not.toBe(0);
    }

    expect(stderr).toMatch(/branchInclude.*not supported when mode is 'clone'/);
  }, 30000);
});
