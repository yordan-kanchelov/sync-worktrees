import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { RepositoryContext } from "../context";
import { handleCreateWorktree } from "../handlers";

// Real git, no mocks. worktreeDir used to be path.dirname(<the worktree the
// probe landed in>), which is only right when the branch name contributed
// exactly one path component. The default-branch worktree is anchored at the
// plain path join(worktreeDir, defaultBranch), so a nested default branch such
// as `release/2024` contributed two — and detection answered <wd>/release,
// after which create_worktree placed every worktree it made under <wd>/release
// instead of <wd>.
describe("auto-detected worktreeDir", () => {
  let tempDir: string;
  let origin: string;
  let bareRepoDir: string;
  let worktreeDir: string;
  const pathResolution = new PathResolutionService();

  const seedOrigin = async (defaultBranch: string, ...extraBranches: string[]): Promise<void> => {
    await fs.mkdir(origin, { recursive: true });
    const seed = simpleGit(origin);
    await seed.init(["-b", defaultBranch]);
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(origin, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    for (const extraBranch of extraBranches) await seed.branch([extraBranch]);
    await simpleGit().clone(origin, bareRepoDir, ["--bare"]);
    await simpleGit(bareRepoDir).addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await simpleGit(bareRepoDir).fetch(["origin"]);
    await fs.mkdir(worktreeDir, { recursive: true });
  };

  const addWorktree = async (at: string, branch: string): Promise<void> => {
    await simpleGit(bareRepoDir).raw(["worktree", "add", at, branch]);
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-wtdir-")));
    origin = path.join(tempDir, "origin");
    bareRepoDir = path.join(tempDir, ".bare", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports worktreeDir from inside the anchor of a nested default branch", async () => {
    await seedOrigin("release/2024", "feature/x");
    const anchor = path.join(worktreeDir, "release", "2024");
    await addWorktree(anchor, "release/2024");
    await addWorktree(pathResolution.getBranchWorktreePath(worktreeDir, "feature/x"), "feature/x");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(anchor);

    expect(result.currentBranch).toBe("release/2024");
    expect(result.worktreeDir).toBe(worktreeDir);
    expect(result.notes).toContain(`worktreeDir resolved to ${worktreeDir}`);
    expect((await ctx.getService()).config.worktreeDir).toBe(worktreeDir);
  });

  it("reports the same worktreeDir from inside a hashed branch worktree", async () => {
    await seedOrigin("release/2024", "feature/x");
    const hashed = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    await addWorktree(path.join(worktreeDir, "release", "2024"), "release/2024");
    await addWorktree(hashed, "feature/x");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(hashed);

    expect(result.currentBranch).toBe("feature/x");
    expect(result.worktreeDir).toBe(worktreeDir);
    expect((await ctx.getService()).config.worktreeDir).toBe(worktreeDir);
  });

  // One registered worktree is one data point, and it is enough: the shape it
  // matched already says how many components its branch name contributed.
  it("derives worktreeDir when only the nested anchor is registered", async () => {
    await seedOrigin("release/2024", "feature/x");
    const anchor = path.join(worktreeDir, "release", "2024");
    await addWorktree(anchor, "release/2024");

    const result = await new RepositoryContext().detectFromPath(anchor);

    expect(result.worktreeDir).toBe(worktreeDir);
    expect(result.allWorktrees).toHaveLength(1);
  });

  it("still reports worktreeDir for a single-segment default branch", async () => {
    await seedOrigin("main", "feature/x");
    const anchor = path.join(worktreeDir, "main");
    await addWorktree(anchor, "main");

    const result = await new RepositoryContext().detectFromPath(anchor);

    expect(result.worktreeDir).toBe(worktreeDir);
    expect(result.capabilities.createWorktree.available).toBe(true);
  });

  // The damaging half: with worktreeDir wrong, everything create_worktree made
  // landed one directory too deep, where a later configured sync — which sees
  // the branch as already checked out — never moves it back.
  it("creates a worktree under the real worktreeDir from inside a nested anchor", async () => {
    await seedOrigin("release/2024", "feature/x");
    const anchor = path.join(worktreeDir, "release", "2024");
    await addWorktree(anchor, "release/2024");

    const ctx = new RepositoryContext();
    await ctx.detectFromPath(anchor);
    const response = await handleCreateWorktree(ctx, { branchName: "feature/x", push: false });
    const body = JSON.parse((response.content[0] as { text: string }).text);

    const expected = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect(body.success).toBe(true);
    expect(body.worktreePath).toBe(expected);
    expect(path.dirname(expected)).toBe(worktreeDir);
    await expect(fs.stat(path.join(expected, "README.md"))).resolves.toBeDefined();

    const registered = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
    expect(registered).toContain(expected);
    expect(registered).not.toContain(path.join(worktreeDir, "release", "feature-x"));
  });

  // Two recognized worktrees naming different parents: the anchor votes for
  // <wd>, the stray one placed at <tempDir>/stray/feature/x votes for
  // <tempDir>/stray. There is no answer to prefer, so the entry keeps a
  // placeholder directory that nothing may write under.
  const seedDisagreement = async (): Promise<{ anchor: string; stray: string }> => {
    await seedOrigin("release/2024", "feature/x");
    const anchor = path.join(worktreeDir, "release", "2024");
    const stray = path.join(tempDir, "stray", "feature", "x");
    await addWorktree(anchor, "release/2024");
    await addWorktree(stray, "feature/x");
    return { anchor, stray };
  };

  // getService builds the service from a spread copy of the entry's config, so
  // refreshing the entry alone left a service born on the placeholder
  // directory in place: detect_context reported the derived directory while
  // create_worktree kept writing under dirname(<the anchor>).
  it("does not create under a stale directory after the derivation starts working", async () => {
    const { anchor, stray } = await seedDisagreement();

    const ctx = new RepositoryContext();
    const undetermined = await ctx.detectFromPath(anchor);
    expect(undetermined.worktreeDir).toBeNull();
    // The read-only tools reach getService, which is what froze the placeholder
    // into a live service.
    expect((await ctx.getService()).config.worktreeDir).toBe(path.join(worktreeDir, "release"));

    await simpleGit(bareRepoDir).raw(["worktree", "remove", "--force", stray]);
    ctx.invalidateDiscovered();

    const resolved = await ctx.detectFromPath(anchor);
    expect(resolved.worktreeDir).toBe(worktreeDir);
    expect((await ctx.getService()).config.worktreeDir).toBe(worktreeDir);

    const response = await handleCreateWorktree(ctx, { branchName: "feature/x", push: false });
    const body = JSON.parse((response.content[0] as { text: string }).text);
    expect(body.worktreePath).toBe(pathResolution.getBranchWorktreePath(worktreeDir, "feature/x"));
  });

  // invalidateDiscovered drops the discovery snapshot but keeps the entry, and
  // ensureCapability stops at the base capabilities when there is no snapshot.
  // load_config does exactly that while leaving auto-detected entries in place.
  it("keeps the write tools unavailable after the discovery snapshot is dropped", async () => {
    const { anchor } = await seedDisagreement();

    const ctx = new RepositoryContext();
    expect((await ctx.detectFromPath(anchor)).worktreeDir).toBeNull();
    ctx.invalidateDiscovered();

    expect(ctx.getBaseCapabilities()?.createWorktree).toEqual({
      available: false,
      reason:
        "cannot determine worktreeDir: the registered worktrees and the worktree this call came from do not agree " +
        "on where they live; set an explicit worktreeDir in a config for this repository and call load_config",
    });
    expect(ctx.getBaseCapabilities()?.updateWorktree).toEqual({
      available: false,
      reason:
        "cannot determine worktreeDir: the registered worktrees and the worktree this call came from do not agree " +
        "on where they live; set an explicit worktreeDir in a config for this repository and call load_config",
    });
    await expect(handleCreateWorktree(ctx, { branchName: "feature/x", push: false })).rejects.toThrow(
      "Capability 'create_worktree' unavailable: cannot determine worktreeDir:",
    );
    const registered = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
    expect(registered).not.toContain(path.join(worktreeDir, "release", "feature-x"));
  });

  // The anchor shape is `<dir>/<branch>`, so a worktree placed outside
  // worktreeDir the conventional way — a directory named after its branch — is
  // recognized and votes for its own parent. It does not abstain, and letting
  // it refuse for everyone took createWorktree away from repositories the rest
  // of whose listing agrees. Two votes for <wd> against its one: <wd> wins.
  it("outvotes a conventionally named worktree placed outside worktreeDir", async () => {
    await seedOrigin("main", "feature/x", "hotfix");
    await addWorktree(path.join(worktreeDir, "main"), "main");
    await addWorktree(pathResolution.getBranchWorktreePath(worktreeDir, "feature/x"), "feature/x");
    const stray = path.join(tempDir, "elsewhere", "hotfix");
    await addWorktree(stray, "hotfix");

    const result = await new RepositoryContext().detectFromPath(path.join(worktreeDir, "main"));

    expect(result.allWorktrees.map((w) => w.path)).toContain(stray);
    expect(result.worktreeDir).toBe(worktreeDir);
    expect(result.capabilities.createWorktree.available).toBe(true);
    expect(result.capabilities.updateWorktree.available).toBe(true);
  });

  // The other naming: `git worktree add ../scratchpad hotfix` reproduces
  // neither shape, so it never enters the count at all.
  it("ignores a worktree whose directory is named after neither the branch nor its flattening", async () => {
    await seedOrigin("main", "hotfix");
    await addWorktree(path.join(worktreeDir, "main"), "main");
    await addWorktree(path.join(tempDir, "elsewhere", "scratchpad"), "hotfix");

    const result = await new RepositoryContext().detectFromPath(path.join(worktreeDir, "main"));

    expect(result.worktreeDir).toBe(worktreeDir);
    expect(result.capabilities.createWorktree.available).toBe(true);
  });

  // Outvoting stops at a tie: two recognized parents named equally often leave
  // no answer to prefer, which is the case the refusal exists for.
  it("refuses when two recognized parents draw the same number of votes", async () => {
    await seedOrigin("main", "feature/x", "hotfix", "topic");
    await addWorktree(path.join(worktreeDir, "main"), "main");
    await addWorktree(pathResolution.getBranchWorktreePath(worktreeDir, "feature/x"), "feature/x");
    await addWorktree(path.join(tempDir, "elsewhere", "hotfix"), "hotfix");
    await addWorktree(path.join(tempDir, "elsewhere", "topic"), "topic");

    const result = await new RepositoryContext().detectFromPath(path.join(worktreeDir, "main"));

    expect(result.worktreeDir).toBeNull();
    expect(result.capabilities.createWorktree).toEqual({
      available: false,
      reason:
        "cannot determine worktreeDir: the registered worktrees and the worktree this call came from do not agree " +
        "on where they live; set an explicit worktreeDir in a config for this repository and call load_config",
    });
  });

  // The adopted-anchor case from GitService.ensureMainWorktree: the anchor was
  // already checked out elsewhere and got adopted there, so one recognized
  // entry names <tempDir>/adopted and one names <wd>. One vote each.
  it("refuses when an adopted anchor and a tool-made worktree name different parents", async () => {
    await seedOrigin("main", "feature/x");
    const adopted = path.join(tempDir, "adopted", "main");
    await addWorktree(adopted, "main");
    const hashed = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    await addWorktree(hashed, "feature/x");

    const result = await new RepositoryContext().detectFromPath(hashed);

    expect(result.worktreeDir).toBeNull();
    expect(result.capabilities.createWorktree.available).toBe(false);
    expect(result.capabilities.updateWorktree.available).toBe(false);
  });

  // The same adopted anchor, probed from the other side. An adopted anchor
  // exists *because* of a misplacement — GitService.ensureMainWorktree found
  // the default branch checked out somewhere other than the path it computed
  // and settled for it — so standing in it and concluding "this is where
  // worktrees live" would propagate that misplacement into everything made
  // afterwards. One vote each either way: refuse, and say how to fix it.
  it("refuses from inside the adopted anchor too, not just from the managed side", async () => {
    await seedOrigin("main", "feature/x");
    const adopted = path.join(tempDir, "adopted", "main");
    await addWorktree(adopted, "main");
    await addWorktree(pathResolution.getBranchWorktreePath(worktreeDir, "feature/x"), "feature/x");

    const result = await new RepositoryContext().detectFromPath(adopted);

    expect(result.currentWorktreePath).toBe(adopted);
    expect(result.worktreeDir).toBeNull();
    expect(result.capabilities.createWorktree.available).toBe(false);
  });

  // One recognized entry, nothing to weigh it against, and it is the one the
  // detection ran from: it corroborates itself and wins. Answering here is what
  // makes a freshly initialized repository usable at all.
  it("answers from a single registered worktree that the probe corroborates", async () => {
    await seedOrigin("main");
    const only = path.join(tempDir, "adopted", "main");
    await addWorktree(only, "main");

    const result = await new RepositoryContext().detectFromPath(only);

    expect(result.allWorktrees).toHaveLength(1);
    expect(result.worktreeDir).toBe(path.join(tempDir, "adopted"));
    expect(result.capabilities.createWorktree.available).toBe(true);
  });

  // Plurality on its own goes wrong when hand-placed worktrees outnumber the
  // tool's own: two strays sharing a parent outvote the single tool-made
  // worktree the detection is standing in, and create_worktree would write
  // beside the strays. The probe disagrees with that count, so nothing is
  // answered instead.
  it("refuses when the count is outnumbered by strays the probe disagrees with", async () => {
    await seedOrigin("main", "feature/x", "hotfix");
    const hashed = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    await addWorktree(hashed, "feature/x");
    await addWorktree(path.join(tempDir, "other", "main"), "main");
    await addWorktree(path.join(tempDir, "other", "hotfix"), "hotfix");

    const result = await new RepositoryContext().detectFromPath(hashed);

    expect(result.worktreeDir).toBeNull();
    expect(result.capabilities.createWorktree.available).toBe(false);
  });

  // The mirror image, and the reason the probe corroborates rather than
  // overrides. Five tool-made worktrees say <wd>; one hand-placed worktree says
  // otherwise and the detection happens to be standing in it — which is exactly
  // the worktree an agent is standing in when it asks. Preferring the probe put
  // the new worktree beside that one stray. Neither signal wins alone.
  it("refuses when the probe is the one stray and the count says otherwise", async () => {
    await seedOrigin("main", "feature/a", "feature/b", "feature/c", "feature/d", "hotfix");
    await addWorktree(path.join(worktreeDir, "main"), "main");
    for (const branch of ["feature/a", "feature/b", "feature/c", "feature/d"]) {
      await addWorktree(pathResolution.getBranchWorktreePath(worktreeDir, branch), branch);
    }
    const stray = path.join(tempDir, "elsewhere", "hotfix");
    await addWorktree(stray, "hotfix");

    const result = await new RepositoryContext().detectFromPath(stray);

    expect(result.currentWorktreePath).toBe(stray);
    expect(result.worktreeDir).toBeNull();
    expect(result.capabilities.createWorktree.available).toBe(false);
    expect(result.capabilities.updateWorktree.available).toBe(false);
  });

  // `git worktree add` canonicalizes its target, and isCurrent is matched
  // lexically, so a cwd reached through a symlink matches no registered entry
  // at all. There is then nothing to corroborate with, which is not a reason to
  // refuse: the count stands alone.
  it("falls back to the count when the probe is not in the registered list", async () => {
    await seedOrigin("main", "feature/x");
    const real = path.join(tempDir, "real-wt");
    const link = path.join(tempDir, "linked-wt");
    await fs.mkdir(real, { recursive: true });
    await fs.symlink(real, link);
    await addWorktree(path.join(link, "main"), "main");
    await addWorktree(pathResolution.getBranchWorktreePath(link, "feature/x"), "feature/x");

    const result = await new RepositoryContext().detectFromPath(path.join(link, "main"));

    expect(result.currentBranch).toBeNull();
    expect(result.allWorktrees.every((w) => !w.isCurrent)).toBe(true);
    expect(result.worktreeDir).toBe(real);
    expect(result.capabilities.createWorktree.available).toBe(true);
  });

  // A detached probe is in the list but carries the pseudo-name
  // `(detached abc1234)`, so it matches no shape and has no candidate to
  // corroborate with. Same fallback, reached the other way.
  it("falls back to the count when the probe is a detached worktree", async () => {
    await seedOrigin("main");
    await addWorktree(path.join(worktreeDir, "main"), "main");
    const detached = path.join(worktreeDir, "detachy");
    await simpleGit(bareRepoDir).raw(["worktree", "add", "--detach", detached, "HEAD"]);

    const result = await new RepositoryContext().detectFromPath(detached);

    expect(result.currentBranch).toMatch(/^\(detached /);
    expect(result.worktreeDir).toBe(worktreeDir);
    expect(result.capabilities.createWorktree.available).toBe(true);
  });
});
