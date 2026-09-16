import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryContext } from "../context";

// Real git, no mocks. detectFromPath used to answer with the first `.git` it
// met while walking up, so a vendored `git init` or a submodule between the
// probed path and the enclosing worktree hid that worktree completely: the
// agent got isWorktree:false, kind:'unsupported', every capability unavailable
// and no currentRepo, although its parent was a managed worktree. The walk now
// steps over anything it cannot act on and only stops at a shape it can.
//
// Each fixture below is built with real git precisely because the pointer files
// are what the walk reads: a submodule inside a linked worktree does NOT write
// `gitdir: ../.git/modules/<name>` as folklore has it, it writes
// `gitdir: <bare>/worktrees/<wt>/modules/<name>`.

async function initRepo(dir: string, branch: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init(["-b", branch]);
  await git.addConfig("user.name", "Test User");
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), `# ${branch}\n`);
  await git.add(".");
  await git.commit("initial");
}

interface Managed {
  root: string;
  bareRepoDir: string;
  worktreeDir: string;
  worktree: string;
}

/** `<root>/.bare/app.git` plus a real linked worktree at `<root>/worktrees/<branch>`. */
async function makeManaged(root: string, branch = "feature-x"): Promise<Managed> {
  const origin = path.join(root, "origin");
  await initRepo(origin, "main");
  await simpleGit(origin).branch([branch]);

  const bareRepoDir = path.join(root, ".bare", "app.git");
  await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
  await simpleGit().clone(origin, bareRepoDir, ["--bare"]);
  await simpleGit(bareRepoDir).addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  await simpleGit(bareRepoDir).remote(["set-url", "origin", "https://github.com/test/app.git"]);

  const worktreeDir = path.join(root, "worktrees");
  await fs.mkdir(worktreeDir, { recursive: true });
  const worktree = path.join(worktreeDir, branch);
  await simpleGit(bareRepoDir).raw(["worktree", "add", worktree, branch]);

  return { root, bareRepoDir, worktreeDir, worktree };
}

const execFileAsync = promisify(execFile);

async function addSubmodule(repo: string, source: string, dest: string): Promise<string> {
  // Run through child_process rather than simple-git: its unsafe-operations
  // plugin rejects both the protocol.allow override a file:// submodule needs
  // and the GIT_EDITOR this environment exports.
  await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, dest], {
    cwd: repo,
    env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" },
  });
  return path.join(repo, dest);
}

async function writeConfig(root: string, body: string): Promise<string> {
  const configPath = path.join(root, "sync-worktrees.config.js");
  await fs.writeFile(configPath, body, "utf-8");
  return configPath;
}

describe("detect_context walks past a nested repository to the enclosing worktree", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-nested-repo-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("answers with the enclosing worktree from inside a vendored git repository", async () => {
    const managed = await makeManaged(tempDir);
    const nested = path.join(managed.worktree, "packages", "vendored-lib");
    await initRepo(nested, "vendored-branch");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(nested);

    expect(result.isWorktree).toBe(true);
    expect(result.kind).toBe("unmanaged");
    expect(result.bareRepoPath).toBe(managed.bareRepoDir);
    expect(result.capabilities.listWorktrees.available).toBe(true);
    // The nested repository's own identity must not leak into the answer: it is
    // on `vendored-branch`, the enclosing worktree is on `feature-x`.
    expect(result.currentWorktreePath).toBe(managed.worktree);
    expect(result.currentBranch).toBe("feature-x");
    expect(result.allWorktrees).toEqual([{ path: managed.worktree, branch: "feature-x", isCurrent: true }]);
    expect(result.notes).toContain(
      `Walked past a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${nested}`,
    );
  });

  it("answers with the enclosing worktree from inside a real submodule", async () => {
    const managed = await makeManaged(tempDir);
    const submoduleSource = path.join(tempDir, "submodule-origin");
    await initRepo(submoduleSource, "sub-main");

    const submodule = await addSubmodule(managed.worktree, submoduleSource, "packages/sub");

    // Pin the pointer this test depends on rather than assuming it. Anchored to
    // the whole line so the fixture's own temp directory name cannot satisfy it.
    const pointer = (await fs.readFile(path.join(submodule, ".git"), "utf-8")).trim();
    const resolvedPointer = path.resolve(submodule, pointer.replace(/^gitdir:\s*/, ""));
    expect(resolvedPointer).toBe(
      path.join(managed.bareRepoDir, "worktrees", "feature-x", "modules", "packages", "sub"),
    );

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(submodule);

    expect(result.isWorktree).toBe(true);
    expect(result.kind).toBe("unmanaged");
    expect(result.currentWorktreePath).toBe(managed.worktree);
    expect(result.currentBranch).toBe("feature-x");
    expect(result.bareRepoPath).toBe(managed.bareRepoDir);
    expect(result.allWorktrees).toEqual([{ path: managed.worktree, branch: "feature-x", isCurrent: true }]);
    expect(result.notes).toContain(
      `Walked past a nested repository or submodule (gitdir does not point into <bare>/worktrees/<name>) at ${submodule}`,
    );
  });

  it("answers with the enclosing worktree from a subdirectory of the submodule", async () => {
    const managed = await makeManaged(tempDir);
    const submoduleSource = path.join(tempDir, "submodule-origin");
    await initRepo(submoduleSource, "sub-main");
    await addSubmodule(managed.worktree, submoduleSource, "packages/sub");
    const deep = path.join(managed.worktree, "packages", "sub", "src", "internals");
    await fs.mkdir(deep, { recursive: true });

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(deep);

    expect(result.currentWorktreePath).toBe(managed.worktree);
    expect(result.currentBranch).toBe("feature-x");
    expect(result.notes).toContain(
      `Walked past a nested repository or submodule (gitdir does not point into <bare>/worktrees/<name>) at ${path.join(managed.worktree, "packages", "sub")}`,
    );
  });

  it("names every repository it stepped over, deepest first, through two levels of nesting", async () => {
    const managed = await makeManaged(tempDir);
    const outer = path.join(managed.worktree, "vendor", "outer");
    const inner = path.join(outer, "third-party", "inner");
    await initRepo(outer, "outer-branch");
    await initRepo(inner, "inner-branch");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(inner);

    expect(result.currentWorktreePath).toBe(managed.worktree);
    expect(result.currentBranch).toBe("feature-x");
    const walked = result.notes.filter((note) => note.startsWith("Walked past "));
    expect(walked).toEqual([
      `Walked past a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${inner}`,
      `Walked past a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${outer}`,
    ]);
  });

  it("bootstraps the configured repository from inside a nested repository", async () => {
    const managed = await makeManaged(tempDir);
    const nested = path.join(managed.worktree, "packages", "vendored-lib");
    await initRepo(nested, "vendored-branch");
    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "app", repoUrl: "https://github.com/test/app.git", bareRepoDir: ${JSON.stringify(managed.bareRepoDir)}, worktreeDir: ${JSON.stringify(managed.worktreeDir)}, cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);
    const result = await ctx.detectFromPath(nested);

    expect(result.kind).toBe("managed");
    expect(result.repoName).toBe("app");
    expect(ctx.getCurrentRepo()).toBe("app");
    expect(result.worktreeDir).toBe(managed.worktreeDir);
    expect(result.capabilities.sync.available).toBe(true);
    expect(result.capabilities.createWorktree.available).toBe(true);
  });

  it("refuses rather than answer with the enclosing worktree when a .git cannot be read", async () => {
    const managed = await makeManaged(tempDir);
    const looping = path.join(managed.worktree, "cyclic");
    await fs.mkdir(looping, { recursive: true });
    // A .git symlinked to itself: readFile fails ELOOP, which is neither ENOENT
    // nor EISDIR. The errno says only that this process could not look, so the
    // directory may be a worktree of some other repository; answering with the
    // enclosing one would name a repository the agent is not in.
    await fs.symlink(path.join(looping, ".git"), path.join(looping, ".git"));

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(path.join(looping, "src"));

    expect(result.kind).toBe("unsupported");
    expect(result.isWorktree).toBe(false);
    expect(result.repoName).toBeNull();
    expect(result.bareRepoPath).toBeNull();
    expect(result.capabilities.createWorktree.available).toBe(false);
    expect(result.notes).toEqual([
      `Cannot determine whether ${looping} is a sync-worktrees worktree: an unreadable .git (ELOOP). ` +
        `Detection stopped there rather than answer with an enclosing repository`,
    ]);
  });
});

// An unreadable `.git` is the one thing the walk may not step over. A `.git`
// folder and a gitdir pointing elsewhere are positive identifications -- git
// itself would not call either a linked worktree -- but an errno is an absence
// of information. Stepping over it answers with whatever encloses it, and what
// encloses a worktree is very often a DIFFERENT repository. A wrong answer is
// worse than a refusal here: every capability in it is one a mutating tool acts
// on.
describe("detect_context never answers an unreadable .git with the repository that encloses it", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-nested-unreadable-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not report the enclosing worktree of another repository", async () => {
    const host = await makeManaged(tempDir, "feature-x");
    const guestRoot = path.join(tempDir, "guest");
    await fs.mkdir(guestRoot, { recursive: true });
    const guest = await makeManaged(guestRoot, "feature-y");

    // A real linked worktree of the GUEST repository, living inside a worktree
    // of the HOST repository, whose own .git has gone unreadable.
    const embedded = path.join(host.worktree, "embedded");
    await fs.rename(guest.worktree, embedded);
    await simpleGit(guest.bareRepoDir).raw(["worktree", "repair", embedded]);
    await fs.rm(path.join(embedded, ".git"));
    await fs.symlink(path.join(embedded, ".git"), path.join(embedded, ".git"));

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(path.join(embedded, "src"));

    expect(result.kind).toBe("unsupported");
    expect(result.isWorktree).toBe(false);
    expect(result.bareRepoPath).toBeNull();
    expect(result.worktreeDir).toBeNull();
    expect(result.currentBranch).toBeNull();
    expect(result.allWorktrees).toEqual([]);
    expect(result.capabilities.createWorktree.available).toBe(false);
    expect(result.capabilities.sync.available).toBe(false);
    expect(result.currentWorktreePath).toBe(embedded);
    expect(result.notes).toEqual([
      `Cannot determine whether ${embedded} is a sync-worktrees worktree: an unreadable .git (ELOOP). ` +
        `Detection stopped there rather than answer with an enclosing repository`,
    ]);
  });

  it("does not report an enclosing configured clone root either", async () => {
    const cloneRoot = path.join(tempDir, "checkout");
    await initRepo(cloneRoot, "clone-branch");
    const guestRoot = path.join(tempDir, "guest");
    await fs.mkdir(guestRoot, { recursive: true });
    const guest = await makeManaged(guestRoot, "feature-y");

    const embedded = path.join(cloneRoot, "embedded");
    await fs.rename(guest.worktree, embedded);
    await simpleGit(guest.bareRepoDir).raw(["worktree", "repair", embedded]);
    await fs.rm(path.join(embedded, ".git"));
    await fs.symlink(path.join(embedded, ".git"), path.join(embedded, ".git"));

    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "outer-clone", repoUrl: "https://github.com/test/outer.git", worktreeDir: ${JSON.stringify(cloneRoot)}, mode: "clone", cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);
    const result = await ctx.detectFromPath(path.join(embedded, "src"));

    expect(result.kind).toBe("unsupported");
    expect(result.repoName).toBeNull();
    expect(result.worktreeDir).toBeNull();
    expect(result.capabilities.sync.available).toBe(false);
    expect(result.notes).toEqual([
      `Cannot determine whether ${embedded} is a sync-worktrees worktree: an unreadable .git (ELOOP). ` +
        `Detection stopped there rather than answer with an enclosing repository`,
    ]);
  });

  it("still passes over a repository it could actually read below the unreadable one", async () => {
    const managed = await makeManaged(tempDir);
    const looping = path.join(managed.worktree, "cyclic");
    await fs.mkdir(looping, { recursive: true });
    await fs.symlink(path.join(looping, ".git"), path.join(looping, ".git"));
    const nested = path.join(looping, "vendor", "lib");
    await initRepo(nested, "lib-branch");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(nested);

    expect(result.kind).toBe("unsupported");
    // The readable nested repository is still the reported location, because it
    // is the deepest thing the walk could name.
    expect(result.currentWorktreePath).toBe(nested);
    expect(result.capabilities.listWorktrees.reason).toBe(
      `Cannot determine whether ${looping} is a sync-worktrees worktree: an unreadable .git (ELOOP). ` +
        `Detection stopped there rather than answer with an enclosing repository; walked past ` +
        `a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${nested}`,
    );
  });
});

describe("detect_context does not walk past a shape it can already act on", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-nested-stop-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("stops at a configured clone-mode root even when a managed worktree encloses it", async () => {
    const managed = await makeManaged(tempDir);
    const cloneRoot = path.join(managed.worktree, "apps", "embedded");
    await initRepo(cloneRoot, "clone-branch");
    const nested = path.join(cloneRoot, "vendor", "lib");
    await initRepo(nested, "vendor-branch");

    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "embedded-clone", repoUrl: "https://github.com/test/embedded.git", worktreeDir: ${JSON.stringify(cloneRoot)}, mode: "clone", cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);
    const result = await ctx.detectFromPath(nested);

    // The clone root is a legitimate terminal answer; resuming past it would
    // hand back the enclosing worktree of a different repository entirely.
    expect(result.kind).toBe("managed");
    expect(result.repoName).toBe("embedded-clone");
    expect(result.currentWorktreePath).toBe(cloneRoot);
    expect(result.currentBranch).toBe("clone-branch");
    expect(result.bareRepoPath).toBeNull();
    expect(result.worktreeDir).toBe(cloneRoot);
    expect(result.allWorktrees).toEqual([{ path: cloneRoot, branch: "clone-branch", isCurrent: true }]);
    expect(result.notes).toContain(
      `Walked past a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${nested}`,
    );
  });

  // Relaxing a filter means enumerating what it used to exclude by accident.
  // Stopping at the first `.git` meant a clone-mode root was only ever looked
  // up for a `.git` FOLDER, because nothing else got that far. `git clone
  // --separate-git-dir` leaves a `.git` FILE holding a gitdir that points
  // nowhere near `<bare>/worktrees/<name>`, so resuming the walk would step
  // straight over a checkout the config names. Measured before the change: this
  // fixture answered `unsupported` with "gitdir does not follow worktree
  // structure" at the checkout itself.
  it("stops at a configured clone-mode root whose .git is a file, not a folder", async () => {
    const origin = path.join(tempDir, "origin");
    await initRepo(origin, "main");
    const cloneRoot = path.join(tempDir, "checkout");
    const separateGitDir = path.join(tempDir, "detached-gitdir");
    await simpleGit().clone(origin, cloneRoot, [`--separate-git-dir=${separateGitDir}`]);
    const pointer = (await fs.readFile(path.join(cloneRoot, ".git"), "utf-8")).trim();
    expect(pointer).toBe(`gitdir: ${separateGitDir}`);

    const nested = path.join(cloneRoot, "vendor");
    await initRepo(nested, "vendor-branch");

    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "separate-gitdir-clone", repoUrl: "https://github.com/test/sep.git", worktreeDir: ${JSON.stringify(cloneRoot)}, mode: "clone", cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);

    const atRoot = await ctx.detectFromPath(cloneRoot);
    expect(atRoot.kind).toBe("managed");
    expect(atRoot.repoName).toBe("separate-gitdir-clone");
    expect(atRoot.currentWorktreePath).toBe(cloneRoot);
    expect(atRoot.currentBranch).toBe("main");

    const fromNested = await ctx.detectFromPath(nested);
    expect(fromNested.kind).toBe("managed");
    expect(fromNested.repoName).toBe("separate-gitdir-clone");
    expect(fromNested.currentWorktreePath).toBe(cloneRoot);
    expect(fromNested.currentBranch).toBe("main");
    expect(fromNested.notes).toContain(
      `Walked past a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${nested}`,
    );
  });

  // The shape that makes the previous one more than a nicety: with the clone
  // lookup confined to the `.git`-folder branch, resuming the walk answers a
  // `--separate-git-dir` checkout with whatever encloses it. Measured against
  // the walk without this lookup, this fixture came back as the enclosing
  // worktree of a different repository -- `app`, on `feature-x` -- rather than
  // the configured `sep`.
  it("stops at a --separate-git-dir clone root nested inside another repository's worktree", async () => {
    const managed = await makeManaged(tempDir);
    const sepOrigin = path.join(tempDir, "sep-origin");
    await initRepo(sepOrigin, "sep-main");
    const cloneRoot = path.join(managed.worktree, "apps", "embedded");
    await fs.mkdir(path.dirname(cloneRoot), { recursive: true });
    await simpleGit().clone(sepOrigin, cloneRoot, [`--separate-git-dir=${path.join(tempDir, "sep-gitdir")}`]);

    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "sep", repoUrl: "https://github.com/test/sep.git", worktreeDir: ${JSON.stringify(cloneRoot)}, mode: "clone", cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);
    const result = await ctx.detectFromPath(cloneRoot);

    expect(result.kind).toBe("managed");
    expect(result.repoName).toBe("sep");
    expect(result.currentWorktreePath).toBe(cloneRoot);
    expect(result.currentBranch).toBe("sep-main");
    expect(result.bareRepoPath).toBeNull();
    expect(result.worktreeDir).toBe(cloneRoot);
    expect(result.notes.filter((note) => note.startsWith("Walked past "))).toEqual([]);
  });

  // The clone lookup must run only after the worktree shape has been ruled
  // out. A `.git` file has never been matched against clone entries, so a
  // directory that is both a real linked worktree and a configured clone-mode
  // root answers as the worktree — measured against the pre-change code, which
  // gives exactly this answer.
  it("answers as a worktree when one directory is both a worktree and a configured clone root", async () => {
    const managed = await makeManaged(tempDir, "feature-x");
    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "clone-over-worktree", repoUrl: "https://github.com/test/x.git", worktreeDir: ${JSON.stringify(managed.worktree)}, mode: "clone", cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);
    const result = await ctx.detectFromPath(managed.worktree);

    expect(result.repoName).not.toBe("clone-over-worktree");
    expect(result.bareRepoPath).toBe(managed.bareRepoDir);
    expect(result.worktreeDir).toBe(managed.worktreeDir);
    expect(result.currentBranch).toBe("feature-x");
  });

  it("stops at a configured clone-mode root whose .git cannot be read at all", async () => {
    const cloneRoot = path.join(tempDir, "checkout");
    await fs.mkdir(cloneRoot, { recursive: true });
    await fs.symlink(path.join(cloneRoot, ".git"), path.join(cloneRoot, ".git"));

    const configPath = await writeConfig(
      tempDir,
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "unreadable-clone", repoUrl: "https://github.com/test/loop.git", worktreeDir: ${JSON.stringify(cloneRoot)}, mode: "clone", cronSchedule: "0 * * * *" }
      ] };`,
    );

    const ctx = new RepositoryContext();
    await ctx.loadConfig(configPath);
    const result = await ctx.detectFromPath(cloneRoot);

    // The configured repository is still the answer; only its branch is unknown.
    expect(result.kind).toBe("managed");
    expect(result.repoName).toBe("unreadable-clone");
    expect(result.currentWorktreePath).toBe(cloneRoot);
    expect(result.currentBranch).toBeNull();
    expect(result.notes.some((note) => note.startsWith("Could not read clone-mode branch: "))).toBe(true);
    expect(result.notes.filter((note) => note.startsWith("Walked past "))).toEqual([]);
  });

  it("stops at a nested worktree that belongs to a different bare repository", async () => {
    const outer = await makeManaged(tempDir, "feature-x");
    const otherRoot = path.join(tempDir, "other");
    await fs.mkdir(otherRoot, { recursive: true });
    const other = await makeManaged(otherRoot, "feature-y");

    const embedded = path.join(outer.worktree, "embedded");
    await fs.rename(other.worktree, embedded);
    await simpleGit(other.bareRepoDir).raw(["worktree", "repair", embedded]);

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(path.join(embedded, "src"));

    expect(result.currentWorktreePath).toBe(embedded);
    expect(result.currentBranch).toBe("feature-y");
    expect(result.bareRepoPath).toBe(other.bareRepoDir);
    expect(result.notes.filter((note) => note.startsWith("Walked past "))).toEqual([]);
  });

  it("stops at the innermost worktree when two worktrees of one repository are nested", async () => {
    const managed = await makeManaged(tempDir, "feature-x");
    const innerWorktree = path.join(managed.worktree, "nested-wt");
    await simpleGit(managed.bareRepoDir).raw(["worktree", "add", "-b", "feature-z", innerWorktree, "main"]);

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(path.join(innerWorktree, "src"));

    expect(result.currentWorktreePath).toBe(innerWorktree);
    expect(result.currentBranch).toBe("feature-z");
    expect(result.notes.filter((note) => note.startsWith("Walked past "))).toEqual([]);
  });
});

describe("detect_context reports what it walked past when nothing encloses the path", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-nested-none-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("names the repositories it passed instead of claiming no .git was found", async () => {
    const host = path.join(tempDir, "host");
    await initRepo(host, "host-main");
    const submoduleSource = path.join(tempDir, "sub-origin");
    await initRepo(submoduleSource, "sub-main");
    const submodule = await addSubmodule(host, submoduleSource, "vendor/sub");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(submodule);

    expect(result.isWorktree).toBe(false);
    expect(result.kind).toBe("unsupported");
    expect(result.currentWorktreePath).toBe(submodule);
    const reason =
      `No sync-worktrees worktree found in ${submodule} or any parent directory; walked past ` +
      `a nested repository or submodule (gitdir does not point into <bare>/worktrees/<name>) at ${submodule}; ` +
      `a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${host}`;
    expect(result.notes).toContain(reason);
    expect(result.capabilities.listWorktrees.reason).toBe(reason);
    expect(result.notes).not.toContain("No .git file found in path or any parent directory");
  });

  // The walk reaching the filesystem root must not move the reported location
  // from the repository the agent is standing in out to the path it happened to
  // probe; that is the answer this gave before the walk resumed, and losing it
  // would be a silent regression in every unmanaged nested checkout.
  it("reports the deepest repository it passed, not the probed subdirectory", async () => {
    const nested = path.join(tempDir, "projects", "thing");
    await initRepo(nested, "thing-main");
    const deep = path.join(nested, "src", "internals");
    await fs.mkdir(deep, { recursive: true });

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(deep);

    expect(result.kind).toBe("unsupported");
    expect(result.currentWorktreePath).toBe(nested);
    expect(result.capabilities.listWorktrees.reason).toBe(
      `No sync-worktrees worktree found in ${deep} or any parent directory; walked past ` +
        `a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${nested}`,
    );
  });

  it("names an unreadable .git rather than reporting that no .git exists", async () => {
    const cyclic = path.join(tempDir, "cyclic");
    await fs.mkdir(cyclic, { recursive: true });
    await fs.symlink(path.join(cyclic, ".git"), path.join(cyclic, ".git"));

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(cyclic);

    expect(result.kind).toBe("unsupported");
    expect(result.currentWorktreePath).toBe(cyclic);
    expect(result.capabilities.listWorktrees.reason).toBe(
      `Cannot determine whether ${cyclic} is a sync-worktrees worktree: an unreadable .git (ELOOP). ` +
        `Detection stopped there rather than answer with an enclosing repository`,
    );
  });

  // One clause per skipped level, each carrying a whole absolute path, in a
  // reason that is repeated once per capability and once in the notes: a deep
  // stack of nested repositories turned a ~900-byte answer into a 116 KB one.
  it("counts the rest instead of enumerating every level of a deep nest", async () => {
    let cur = tempDir;
    const repos: string[] = [];
    for (let i = 0; i < 8; i++) {
      cur = path.join(cur, `nested-${i}`);
      await initRepo(cur, `branch-${i}`);
      repos.push(cur);
    }

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(cur);

    const deepestFirst = [...repos].reverse();
    const clause = (dir: string): string =>
      `a nested repository (.git folder: regular repo, not a sync-worktrees worktree) at ${dir}`;
    expect(result.capabilities.listWorktrees.reason).toBe(
      `No sync-worktrees worktree found in ${cur} or any parent directory; walked past ` +
        deepestFirst.slice(0, 5).map(clause).join("; ") +
        `; and 3 more`,
    );
  });

  it("keeps the original note for a path with no .git anywhere above it", async () => {
    const plain = path.join(tempDir, "projects", "notes");
    await fs.mkdir(plain, { recursive: true });

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(plain);

    expect(result.kind).toBe("unsupported");
    expect(result.currentWorktreePath).toBe(plain);
    expect(result.notes).toEqual(["No .git file found in path or any parent directory"]);
  });

  it("terminates at the filesystem root", async () => {
    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(path.parse(tempDir).root);

    expect(result.kind).toBe("unsupported");
    expect(result.isWorktree).toBe(false);
  });
});
