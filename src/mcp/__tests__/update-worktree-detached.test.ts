import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCreateWorktree, handleUpdateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryContext } from "../context";
import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Real git, no mocks. The thing under test is what git's own worktree listing
// says about a worktree whose HEAD is detached, so faking that listing would
// fake the bug away: `git worktree list --porcelain` prints such an entry with
// a `HEAD <oid>` line, a `detached` line and NO `branch` line, and the default
// listing drops it entirely. That is why update_worktree used to answer "not a
// registered worktree" for a path git really does have registered.
describe("update_worktree on a detached-HEAD worktree (real git)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let service: WorktreeSyncService;
  let ctx: RepositoryContext;

  function makeConfig(): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: tempDir,
    };
  }

  function makeCtx(target: WorktreeSyncService): RepositoryContext {
    return {
      autoSelectCurrentRepoIfSingleConfig: () => "app",
      getDiscoveredContext: () => null,
      getBaseCapabilities: () => undefined,
      getService: async () => target,
      getEntry: () => ({ name: "app" }),
      invalidateDiscovered: () => undefined,
    } as unknown as RepositoryContext;
  }

  async function call(
    handler: (c: RepositoryContext, p: any) => Promise<CallToolResult>,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    let result: CallToolResult;
    try {
      result = await handler(ctx, params);
    } catch (err) {
      result = formatErrorResponse(err);
    }
    const [block] = result.content as Array<{ type: string; text: string }>;
    return { ...JSON.parse(block.text), isError: result.isError };
  }

  async function porcelain(): Promise<string> {
    return simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
  }

  async function headOf(dir: string): Promise<string> {
    return (await simpleGit(dir).revparse(["HEAD"])).trim();
  }

  // A second commit on origin/feature/x, so an update that ran would visibly
  // move HEAD. Without it a suppressed fast-forward and a performed one look
  // the same.
  async function advanceRemote(): Promise<string> {
    const seed = simpleGit(seedDir);
    await seed.checkout("feature/x");
    await fs.writeFile(path.join(seedDir, "second.txt"), "second");
    await seed.add(".");
    await seed.commit("Second commit");
    await seed.push("origin", "feature/x");
    return (await seed.revparse(["HEAD"])).trim();
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-detached-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

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
    await seed.checkoutLocalBranch("feature/x");
    await seed.push("origin", "feature/x");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    ctx = makeCtx(service);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // The acceptance case. The path IS registered, git simply reports no branch
  // for it, so the answer has to name that and say what to do about it.
  it("refuses with DETACHED_HEAD and fast-forwards nothing", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    const remoteTip = await advanceRemote();

    const detachedAt = await headOf(target);
    await simpleGit(target).raw(["checkout", "--detach", detachedAt]);
    // Precondition, pinned so the case cannot silently stop being about a
    // detached worktree: git lists the path, and lists it without a branch.
    // The `detached` check is anchored to a whole line — `toContain` would be
    // satisfied by the temp directory's own name, which carries the word.
    const listing = await porcelain();
    expect(listing).toContain(`worktree ${target}`);
    expect(listing).toMatch(/^detached$/m);
    expect(listing).not.toMatch(/^branch refs\/heads\/feature\/x$/m);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");
    const updateWorktree = vi.spyOn(git, "updateWorktree");

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBe(true);
    expect(result.code).toBe("DETACHED_HEAD");
    expect(result.message).toContain("detached HEAD");
    expect(result.message).toContain(target);
    expect(result.message).toContain(detachedAt);
    // The bug this replaces: a registered path reported as unregistered.
    expect(result.message).not.toContain("not a registered worktree");

    expect(fetchBranch).not.toHaveBeenCalled();
    expect(updateWorktree).not.toHaveBeenCalled();
    expect(await headOf(target)).toBe(detachedAt);
    expect(await headOf(target)).not.toBe(remoteTip);
  });

  // The other half of the guard: it must not fire for a worktree that is on a
  // branch, and re-attaching is exactly the remedy the message prescribes — so
  // following it has to work.
  it("fast-forwards normally once a branch is checked out again", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    const remoteTip = await advanceRemote();

    await simpleGit(target).raw(["checkout", "--detach", await headOf(target)]);
    expect((await call(handleUpdateWorktree, { path: target })).code).toBe("DETACHED_HEAD");

    await simpleGit(target).raw(["checkout", "feature/x"]);
    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.worktreePath).toBe(target);
    expect(await headOf(target)).toBe(remoteTip);
  });

  // A registration whose checkout has been deleted is `detached` + `prunable`
  // in git's listing, and asking for detached entries un-hides that too. There
  // is no directory to check a branch out in, so DETACHED_HEAD would prescribe
  // a remedy that cannot be performed; the rest of GitService already treats a
  // prunable registration as absent (isRegisteredWorktree), and so does this.
  it("refuses a prunable detached registration as unregistered, not as detached", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    await simpleGit(target).raw(["checkout", "--detach", await headOf(target)]);
    await fs.rm(target, { recursive: true, force: true });

    const listing = await porcelain();
    expect(listing).toMatch(/^detached$/m);
    expect(listing).toMatch(/^prunable /m);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBe(true);
    expect(result.code).not.toBe("DETACHED_HEAD");
    expect(result.message).toContain("not a registered worktree");
    expect(fetchBranch).not.toHaveBeenCalled();
  });

  // `prunable` is the only thing in the listing that says "the checkout is
  // gone", and git does not compute it for a LOCKED registration — so a locked
  // detached worktree whose directory has been deleted arrives looking exactly
  // like a live detached one. That is git's documented reason to lock (a
  // worktree on media that is not always mounted), and DETACHED_HEAD there
  // names a remedy — check out a branch — in a directory that is not present.
  it("refuses a locked detached registration whose checkout is gone, not as detached", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    await simpleGit(target).raw(["checkout", "--detach", await headOf(target)]);
    await simpleGit(bareRepoDir).raw(["worktree", "lock", "--reason", "on removable media", target]);
    await fs.rm(target, { recursive: true, force: true });

    const listing = await porcelain();
    expect(listing).toMatch(/^detached$/m);
    expect(listing).toMatch(/^locked on removable media$/m);
    // The point of the case: git suppresses `prunable` here, so the filter in
    // getWorktrees cannot see that this checkout no longer exists.
    expect(listing).not.toMatch(/^prunable/m);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBe(true);
    expect(result.code).not.toBe("DETACHED_HEAD");
    expect(result.message).toContain("not a registered worktree");
    expect(fetchBranch).not.toHaveBeenCalled();
  });

  // The other half: a lock is not by itself a reason to disown a worktree. One
  // that is locked and still on disk is an ordinary detached checkout, and the
  // remedy the refusal names can actually be carried out there.
  it("still answers DETACHED_HEAD for a locked detached worktree that is present", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    const detachedAt = await headOf(target);
    await simpleGit(target).raw(["checkout", "--detach", detachedAt]);
    await simpleGit(bareRepoDir).raw(["worktree", "lock", target]);

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.code).toBe("DETACHED_HEAD");
    expect(result.message).toContain(detachedAt);
  });

  // Asking git for detached entries also un-hides the bare repository's own
  // row, which has no branch AND no detached HEAD. Nothing may be fetched or
  // merged for it: `fetchBranch("")` would fetch every ref under a name git
  // reads as a refspec of its own.
  it("still refuses the bare repository path as unregistered", async () => {
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");

    const result = await call(handleUpdateWorktree, { path: bareRepoDir });

    expect(result.isError).toBe(true);
    expect(result.message).toContain("not a registered worktree");
    expect(fetchBranch).not.toHaveBeenCalled();
  });
});
