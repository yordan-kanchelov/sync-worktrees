import { execFileSync, execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const shouldRunNetworkE2E = process.env.RUN_NETWORK_E2E === "true";
const itNetwork = shouldRunNetworkE2E ? it : it.skip;

const HELLO_WORLD = "https://github.com/octocat/Hello-World.git";
const GITIGNORE = "https://github.com/github/gitignore.git";

describe("Clone-mode E2E tests", () => {
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

  async function growRemoteWithMerges(remoteBare: string, name: string, rounds: number): Promise<string> {
    const pushDir = path.join(tmpBase, `${name}-merge-grow`);
    await fs.rm(pushDir, { recursive: true, force: true });
    execSync(`git clone "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });
    pushMergeRounds(pushDir, `${name}-r`, rounds);
    return pushDir;
  }

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

    await fs.writeFile(path.join(worktreeDir, "README.md"), "# Locally edited\n");
    await fs.writeFile(path.join(worktreeDir, "scratch.txt"), "wip\n");
    const headBeforeTick = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();

    const dirtyButCurrent = run();

    expect(dirtyButCurrent).toContain("already up to date with origin/main");
    expect(dirtyButCurrent).not.toContain("working tree has local changes");
    expect(dirtyButCurrent).not.toContain("Clone-mode skips");
    expect(dirtyButCurrent).toMatch(/Processed 1 repo in \S+: 1 synced, 0 failed/);
    expect(await fs.readFile(path.join(worktreeDir, "README.md"), "utf-8")).toBe("# Locally edited\n");
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(headBeforeTick);

    await pushCommit(remoteBare, "dirty-current", "three.txt", "Add three");

    const dirtyAndBehind = run();

    expect(dirtyAndBehind).toContain("working tree has local changes");
    expect(dirtyAndBehind).toContain("Clone-mode skips");
    expect(dirtyAndBehind).toMatch(/Processed 1 repo in \S+: 0 synced, 1 with clone-mode skips, 0 failed/);
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(headBeforeTick);
  }, 90000);

  it("keeps syncing the clone-time default branch after the remote HEAD moves", async () => {
    const remoteBare = await createLocalRemote("default-moved-remote");
    const configDir = path.join(tmpBase, "default-moved");
    const worktreeDir = path.join(configDir, "wt");
    const configPath = path.join(configDir, "default-moved.config.js");
    await fs.mkdir(configDir, { recursive: true });
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir);
    const config = await fs.readFile(configPath, "utf-8");
    await fs.writeFile(configPath, config.replace(/,\s*branch: "main"/, ""));
    expect(await fs.readFile(configPath, "utf-8")).not.toContain("branch:");
    const run = (): string =>
      execSync(`node "${cliPath}" --config "${configPath}" 2>&1`, {
        encoding: "utf-8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });

    run();
    expect(execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf-8" }).trim()).toBe("main");
    expect(
      execSync(`git -C "${worktreeDir}" symbolic-ref refs/remotes/origin/HEAD`, { encoding: "utf-8" }).trim(),
    ).toBe("refs/remotes/origin/main");

    const pushedHead = await pushCommit(remoteBare, "default-moved", "three.txt", "Add three");
    execSync(`git -C "${remoteBare}" branch trunk main`, { encoding: "utf-8" });
    execSync(`git -C "${remoteBare}" symbolic-ref HEAD refs/heads/trunk`, { encoding: "utf-8" });

    const output = run();

    expect(output).not.toContain("expected 'trunk'");
    expect(output).not.toContain("Clone-mode skips");
    expect(output).toMatch(/Processed 1 repo in \S+: 1 synced, 0 failed/);
    expect(execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf-8" }).trim()).toBe("main");
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(pushedHead);
  }, 90000);

  it("skips a clone whose tracked file was replaced by a symlink once origin moves ahead", async () => {
    const remoteBare = await createLocalRemote("typechange-remote");
    const configDir = path.join(tmpBase, "typechange");
    const worktreeDir = path.join(configDir, "wt");
    const configPath = path.join(configDir, "typechange.config.js");
    await fs.mkdir(configDir, { recursive: true });
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir);
    const command = `node "${cliPath}" --config "${configPath}" 2>&1`;
    const run = (): string =>
      execSync(command, { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });

    run();

    await fs.rm(path.join(worktreeDir, "one.txt"));
    await fs.symlink("two.txt", path.join(worktreeDir, "one.txt"));
    expect(execSync(`git -C "${worktreeDir}" status --porcelain`, { encoding: "utf-8" })).toBe(" T one.txt\n");
    const headBeforeTick = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();

    await pushCommit(remoteBare, "typechange", "three.txt", "Add three");

    const output = run();

    expect(output).toContain("working tree has local changes");
    expect(output).toMatch(/Processed 1 repo in \S+: 0 synced, 1 with clone-mode skips, 0 failed/);
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(headBeforeTick);
    expect((await fs.lstat(path.join(worktreeDir, "one.txt"))).isSymbolicLink()).toBe(true);
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
    execFileSync("git", ["clone", "--branch", "main", `file://${remoteBare}`, worktreeDir], {
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

  it("deletes the other stale remote refs when one of them is locked", async () => {
    const remoteBare = await createLocalRemote("locked-stale-ref");
    const seedDir = path.join(tmpBase, "locked-stale-ref-seed");
    for (const branch of ["stale-a", "stale-b", "stale-c"]) {
      execSync(`git -C "${seedDir}" push origin "main:${branch}"`, { encoding: "utf-8" });
    }

    const worktreeDir = path.join(tmpBase, "locked-stale-ref", "wt");
    execFileSync("git", ["clone", "--branch", "main", `file://${remoteBare}`, worktreeDir], { encoding: "utf-8" });
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
    expect(output).toMatch(/Processed 1 repo in \S+: 1 synced, 0 failed/);
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
      expect(output).toMatch(
        /mismatch — clone is on 'sidebranch', expected 'master' \(since process start\) — update 'branch'/,
      );
      expect(output).toMatch(/Processed 1 repo in \S+: 0 synced, 1 with clone-mode skips, 0 failed/);
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

      const lockDir = path.join(configDir, ".sync-worktrees-locks");
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

    expect(secondRun.match(/\[deepen]/g)).toHaveLength(1);
    expect(secondRun).toContain("refetching to depth 50 before deciding");
    expect(secondRun).not.toContain("Clone-mode skips");
    expect(readHead()).toBe(headAfterThreePushes);
    const countAfterSecondRun = countHead();
    expect(countAfterSecondRun).toBe(50);
    expect(isShallow()).toBe("true");

    let previousCount = countAfterSecondRun;
    for (const [index, file] of ["six.txt", "seven.txt"].entries()) {
      const pushedHead = await pushCommit(remoteBare, "shallow-multi-commit", file, `Add ${file}`);
      const run = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      expect(run, `tick ${index + 3}`).not.toContain("[deepen]");
      expect(run, `tick ${index + 3}`).not.toContain("Clone-mode skips");
      expect(readHead()).toBe(pushedHead);
      expect(countHead(), `tick ${index + 3}`).toBeGreaterThanOrEqual(previousCount);
      expect(countRemoteRef(), `tick ${index + 3}`).toBeGreaterThanOrEqual(previousCount);
      expect(isShallow()).toBe("true");
      previousCount = countHead();
    }
  }, 300000);

  it("holds a merge-heavy shallow clone at the depth it deepened to", async () => {
    const remoteBare = await createLocalRemote("shallow-merge-growth-remote");
    const configDir = path.join(tmpBase, "shallow-merge-growth-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-merge-growth.config.js");
    await fs.mkdir(configDir, { recursive: true });

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

    pushMergeRounds(pushDir, "shallow-merge-growth-t2", 1);
    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(secondRun.match(/\[deepen]/g)).toHaveLength(1);
    expect(secondRun).not.toContain("Clone-mode skips");
    const countAfterDeepen = countHead();
    expect(isShallow()).toBe("true");
    expect(countAfterDeepen).toBeGreaterThan(50);
    expect(countAfterDeepen).toBeLessThan(remoteTotal / 2);

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

    const pushDir = await growRemote(remoteBare, "shallow-forcepush", 60);

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim()).toBe("1");

    execSync(`git -C "${pushDir}" commit -q --allow-empty -m "Advance"`, { encoding: "utf-8" });
    execSync(`git -C "${pushDir}" push -q origin main`, { encoding: "utf-8" });
    const deepenRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
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

    expect(secondRun).toContain("has diverged from origin/main");
    expect(secondRun).not.toContain("[deepen]");
    expect(countRemoteRef()).toBe(windowAfterDeepen);
    expect(countRemoteRef()).toBeLessThan(rewrittenAncestry);

    const thirdRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });
    expect(thirdRun).toContain("has diverged from origin/main");
    expect(thirdRun).not.toContain("[deepen]");
    expect(countRemoteRef()).toBe(windowAfterDeepen);
  }, 240000);

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

    await growRemote(remoteBare, "shallow-dirty-window", 3);
    const deepenRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
    expect(deepenRun.match(/\[deepen]/g)).toHaveLength(1);
    const windowAfterDeepen = countRef("refs/remotes/origin/main");
    expect(windowAfterDeepen).toBe(50);

    await fs.writeFile(path.join(worktreeDir, "README.md"), "# Locally edited\n");

    for (const tick of [3, 4, 5]) {
      await growRemote(remoteBare, "shallow-dirty-window", 3);
      const run = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      expect(run, `tick ${tick}`).toContain("working tree has local changes");
      expect(run, `tick ${tick}`).not.toContain("[deepen]");
      expect(countRef("refs/remotes/origin/main"), `tick ${tick}`).toBe(windowAfterDeepen);
      expect(countRef("HEAD"), `tick ${tick}`).toBeLessThan(windowAfterDeepen);
      expect(isShallow(), `tick ${tick}`).toBe("true");
    }

    execSync(`git -C "${worktreeDir}" checkout -- README.md`, { encoding: "utf-8" });
    const cleanRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    expect(cleanRun).not.toContain("[deepen]");
    expect(cleanRun).not.toContain("Clone-mode skips");
    expect(countRef("refs/remotes/origin/main")).toBe(windowAfterDeepen);
    expect(countRef("HEAD")).toBe(windowAfterDeepen);
    expect(isShallow()).toBe("true");
  }, 300000);

  it("spends the deepen budget and skips when the remote branch was rewritten", async () => {
    const remoteBare = await createLocalRemote("shallow-rewritten-remote");
    const configDir = path.join(tmpBase, "shallow-rewritten-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-rewritten.config.js");
    await fs.mkdir(configDir, { recursive: true });

    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

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

  it.each([
    ["past the largest deepen target", 1100],
    ["held in full by the clone", 120],
  ])(
    "spends the deepen budget once on unrelated history %s",
    async (label, commits) => {
      const slug = `shallow-unrelated-${commits}`;
      const remoteBare = await createLocalRemote(`${slug}-remote`);
      const configDir = path.join(tmpBase, `${slug}-config`);
      const worktreeDir = path.join(configDir, "clone");
      const configPath = path.join(configDir, `${slug}.config.js`);
      await fs.mkdir(configDir, { recursive: true });

      await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");
      execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

      const pushDir = path.join(tmpBase, `${slug}-push`);
      execSync(`git clone -q "${remoteBare}" "${pushDir}"`, { encoding: "utf-8" });
      execSync(`git -C "${pushDir}" config user.name "Test User"`, { encoding: "utf-8" });
      execSync(`git -C "${pushDir}" config user.email "test@example.com"`, { encoding: "utf-8" });
      execSync(
        `git checkout -q --orphan unrelated && for i in $(seq 1 ${commits}); do git commit -q --allow-empty -m "U $i"; done`,
        { encoding: "utf-8", cwd: pushDir },
      );
      execSync(`git -C "${pushDir}" push -q --force origin unrelated:main`, { encoding: "utf-8" });

      const readObjects = (): string =>
        execSync(`git -C "${worktreeDir}" count-objects -v`, { encoding: "utf-8" })
          .split("\n")
          .filter((line) => /^(count|in-pack|packs):/.test(line))
          .join(" ");
      const readHead = (): string => execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
      const headBefore = readHead();

      const firstRun = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
      expect(firstRun, label).toContain("[deepen]");
      expect(firstRun, label).toContain("could not classify origin/main");
      const objectsAfterBudget = readObjects();

      for (const tick of [2, 3]) {
        const run = execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });
        expect(run, `${label}, tick ${tick}`).not.toContain("[deepen]");
        expect(run, `${label}, tick ${tick}`).toContain("could not classify origin/main");
        expect(readObjects(), `${label}, tick ${tick}`).toBe(objectsAfterBudget);
        expect(readHead()).toBe(headBefore);
      }
    },
    240000,
  );

  it("classifies a merge through the bounded deepen rather than an uncapped fetch", async () => {
    const remoteBare = await createLocalRemote("shallow-merge-remote");
    const configDir = path.join(tmpBase, "shallow-merge-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "shallow-merge.config.js");
    await fs.mkdir(configDir, { recursive: true });

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

    expect(secondRun).toContain("[deepen]");
    expect(secondRun.match(/\[deepen]/g)).toHaveLength(1);
    expect(secondRun).toContain("refetching to depth 50 before deciding");
    expect(secondRun).not.toContain("Clone-mode skips");
    expect(execSync(`git -C "${worktreeDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim()).toBe(mergeCommit);

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
    execFileSync("git", ["clone", `file://${remoteBare}`, primaryDir], { encoding: "utf-8" });
    execSync(`git -C "${primaryDir}" switch "feat/other"`, { encoding: "utf-8" });
    execSync(`git -C "${primaryDir}" worktree add "${linkedDir}" main`, { encoding: "utf-8" });

    const readPrimary = (): { refspec: string; refs: string } => ({
      refspec: execSync(`git -C "${primaryDir}" config --get-all remote.origin.fetch`, { encoding: "utf-8" }).trim(),
      refs: execSync(`git -C "${primaryDir}" for-each-ref --format="%(refname)" refs/remotes/origin`, {
        encoding: "utf-8",
      }).trim(),
    });
    const before = readPrimary();
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
    expect(output).toContain("it is not a primary checkout");
    expect(output).toContain(path.join(primaryDir, ".git"));
    expect(readPrimary()).toEqual(before);
  }, 60000);

  it("does not run git gc in the owner of a linked worktree on the wrong branch", async () => {
    const remoteBare = await createLocalRemote("linked-gc");
    const baseDir = path.join(tmpBase, "linked-gc");
    const primaryDir = path.join(baseDir, "primary");
    const linkedDir = path.join(baseDir, "linked");
    await fs.mkdir(baseDir, { recursive: true });
    execFileSync("git", ["clone", `file://${remoteBare}`, primaryDir], { encoding: "utf-8" });
    execFileSync("git", ["-C", primaryDir, "worktree", "add", "-b", "feat/side", linkedDir, "main"], {
      encoding: "utf-8",
    });

    const packDir = path.join(primaryDir, ".git", "objects", "pack");
    const listObjects = async (): Promise<string[]> => {
      const pack = (await fs.readdir(packDir)).sort();
      const loose = (await fs.readdir(path.join(primaryDir, ".git", "objects"))).sort();
      return [...pack, "|", ...loose];
    };
    const before = await listObjects();

    const configPath = path.join(baseDir, "linked-gc.config.js");
    await fs.writeFile(
      configPath,
      `export default {
  defaults: { runOnce: true },
  repositories: [{
    name: "linked-gc",
    repoUrl: "file://${remoteBare}",
    worktreeDir: "${linkedDir.replace(/\\/g, "/")}",
    mode: "clone",
    branch: "main",
    maintenance: { enabled: true, aggressive: true }
  }]
};
`,
    );

    let output: string;
    try {
      output = execSync(`node "${cliPath}" --config "${configPath}" 2>&1`, { encoding: "utf-8", timeout: 60000 });
    } catch (error) {
      const err = error as { stdout?: Buffer | string };
      output = String(err.stdout ?? "");
    }

    expect(output).toContain("expected 'main'");
    expect(output).not.toContain("Running git gc");
    expect(await listObjects()).toEqual(before);
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
