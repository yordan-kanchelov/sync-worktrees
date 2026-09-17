import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleCreateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryContext } from "../context";
import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Real git, no mocks. `idempotentHint: true` is an assertion about what a
// second identical call does to the repository, so it is measured here rather
// than described: every case below calls create_worktree twice with the same
// arguments and pins both the response the agent reads and the state git holds
// afterwards. The second response must be distinguishable from the first — that
// is the whole bug — and the second call must add nothing: no extra worktree,
// no extra branch ref, no second push, and not a scratched-over checkout.
describe("create_worktree called twice with the same arguments (real git)", () => {
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

  async function create(params: Record<string, unknown>): Promise<Record<string, any>> {
    let result: CallToolResult;
    try {
      result = await handleCreateWorktree(ctx, params as { branchName: string });
    } catch (err) {
      result = formatErrorResponse(err);
    }
    const [block] = result.content as Array<{ type: string; text: string }>;
    return { ...JSON.parse(block.text), isError: result.isError };
  }

  async function registeredWorktrees(): Promise<string[]> {
    const raw = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
    return raw
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  async function localBranches(): Promise<string[]> {
    const raw = await simpleGit(bareRepoDir).raw(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return raw.split("\n").filter(Boolean).sort();
  }

  async function remoteRefs(): Promise<string> {
    return simpleGit(remote).raw(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
  }

  async function exists(target: string): Promise<boolean> {
    return fs
      .access(target)
      .then(() => true)
      .catch(() => false);
  }

  // A pre-receive hook that always rejects is the only reliable way to make a
  // real push fail without touching the network or the filesystem's modes.
  async function makeRemoteRejectPushes(): Promise<void> {
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n");
    await fs.chmod(hook, 0o755);
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-retry-")));
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
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // The acceptance case: checking out an existing remote branch, then retrying
  // after a client timeout. Before the fix both responses were the same bytes.
  it("distinguishes the retry from the first checkout, and leaves the checkout alone", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");

    const first = await create({ branchName: "feature/x" });
    expect(first.success).toBe(true);
    expect(first.created).toBe(false);
    expect(first.worktreeExisted).toBe(false);

    // Work the agent (or the user) does in the checkout between the two calls.
    // A "fresh checkout" would not have it; a no-op leaves it in place.
    const scratch = path.join(target, "in-progress.txt");
    await fs.writeFile(scratch, "uncommitted work");

    const branchesBefore = await localBranches();
    const refsBefore = await remoteRefs();

    const second = await create({ branchName: "feature/x" });

    expect(second.worktreeExisted).toBe(true);
    // Everything else is byte-identical, which is exactly why the new field is
    // the only thing that can carry the difference.
    expect(second.success).toBe(true);
    expect(second.created).toBe(false);
    expect(second.pushed).toBe(false);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second).not.toEqual(first);

    expect(await fs.readFile(scratch, "utf8")).toBe("uncommitted work");
    expect((await registeredWorktrees()).filter((p) => p === target)).toHaveLength(1);
    expect(await localBranches()).toEqual(branchesBefore);
    expect(await remoteRefs()).toBe(refsBefore);
  });

  // The push case idempotentHint has to survive: the first call pushes a brand
  // new branch, and the retry must not push again (nor re-create the branch).
  it("does not push a second time when the first call created and pushed the branch", async () => {
    const first = await create({ branchName: "exp", baseBranch: "main" });
    expect(first.created).toBe(true);
    expect(first.pushed).toBe(true);
    expect(first.worktreeExisted).toBe(false);

    const refsBefore = await remoteRefs();
    expect(refsBefore).toContain("refs/heads/exp");
    const branchesBefore = await localBranches();

    const second = await create({ branchName: "exp", baseBranch: "main" });

    expect(second.success).toBe(true);
    expect(second.worktreeExisted).toBe(true);
    // `created` is false the second time round, and the push is gated on it —
    // so the branch is pushed exactly once however many times this is called.
    expect(second.created).toBe(false);
    expect(second.pushed).toBe(false);
    expect(await remoteRefs()).toBe(refsBefore);
    expect(await localBranches()).toEqual(branchesBefore);
  });

  it("is a no-op on retry for push:false, leaving the branch local-only", async () => {
    const first = await create({ branchName: "exp", baseBranch: "main", push: false });
    expect(first.created).toBe(true);
    expect(first.pushed).toBe(false);
    expect(first.worktreeExisted).toBe(false);
    expect(first.warning).toContain("next sync");

    const second = await create({ branchName: "exp", baseBranch: "main", push: false });

    expect(second.worktreeExisted).toBe(true);
    expect(second.created).toBe(false);
    expect(second.pushed).toBe(false);
    // Still exactly as local-only as the first call left it, with the same
    // warning: the retry neither pushed it nor stopped warning about it.
    expect(second.warning).toContain("next sync");
    expect(await remoteRefs()).not.toContain("refs/heads/exp");
    expect(await localBranches()).toContain("exp");
  });

  // Documented, not endorsed: after a push that failed, the retry reports
  // success and does NOT reattempt the push, because `created` is false the
  // second time. `worktreeExisted: true` is the only thing in the response that
  // says so — without it, `success: true, pushed: false` reads like a checkout
  // of an existing remote branch that simply had nothing to push.
  it("reports the retry after a failed push as an existing worktree, and does not retry the push", async () => {
    await makeRemoteRejectPushes();

    const first = await create({ branchName: "exp", baseBranch: "main" });
    expect(first.success).toBe(false);
    expect(first.created).toBe(true);
    expect(first.pushed).toBe(false);
    expect(first.worktreeExisted).toBe(false);
    expect(first.pushError).toBeTruthy();

    const second = await create({ branchName: "exp", baseBranch: "main" });

    expect(second.success).toBe(true);
    expect(second.worktreeExisted).toBe(true);
    expect(second.created).toBe(false);
    expect(second.pushed).toBe(false);
    expect(second.pushError).toBeUndefined();
    expect(await remoteRefs()).not.toContain("refs/heads/exp");
  });

  // A filtered branch refuses identically however many times it is called: the
  // verdict is a function of the config and the branch, not of call history.
  it("refuses a filtered branch the same way on every call", async () => {
    service = new WorktreeSyncService({ ...makeConfig(), branchInclude: ["main"] });
    await service.initialize();
    ctx = makeCtx(service);

    const first = await create({ branchName: "feature/x" });
    const second = await create({ branchName: "feature/x" });

    expect(first.isError).toBe(true);
    expect(first.code).toBe("BRANCH_FILTERED");
    expect(second).toEqual(first);
    expect(await exists(pathResolution.getBranchWorktreePath(worktreeDir, "feature/x"))).toBe(false);
  });

  // State convergence rather than strict no-op: something else removed the
  // worktree between the two calls, so the second one rebuilds it and says
  // worktreeExisted:false. The end state matches the first call's, and no
  // second worktree is registered — which is what the hint promises.
  it("rebuilds and reports a fresh checkout when the worktree was removed in between", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");

    expect((await create({ branchName: "feature/x" })).worktreeExisted).toBe(false);
    await simpleGit(bareRepoDir).raw(["worktree", "remove", "--force", target]);
    expect(await exists(target)).toBe(false);

    const second = await create({ branchName: "feature/x" });

    expect(second.success).toBe(true);
    expect(second.worktreeExisted).toBe(false);
    expect(await exists(target)).toBe(true);
    expect((await registeredWorktrees()).filter((p) => p === target)).toHaveLength(1);
  });

  // The limit of the field, pinned so it cannot drift from what the schema
  // promises. `worktreeExisted` is read off the pre-call listing, and a
  // registration whose directory was destroyed out-of-band (rm -rf, a wiped
  // volume) is still in that listing as prunable — while addWorktree finds the
  // directory gone, clears the stale registration and rebuilds the checkout.
  // So `true` means "a registration was already here", not "your work survived":
  // the response cannot be read as a promise about the contents, which is why
  // the schema's describe names this case instead of claiming a no-op.
  it("reports worktreeExisted=true for a stale registration whose checkout it rebuilt", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");

    expect((await create({ branchName: "feature/x" })).worktreeExisted).toBe(false);
    const scratch = path.join(target, "in-progress.txt");
    await fs.writeFile(scratch, "uncommitted work");

    // The directory goes, the registration stays — which `worktree remove` does
    // not do, and which the case above therefore does not reach.
    await fs.rm(target, { recursive: true, force: true });
    expect(await registeredWorktrees()).toContain(target);

    const second = await create({ branchName: "feature/x" });

    expect(second.success).toBe(true);
    expect(second.worktreeExisted).toBe(true);
    expect(await exists(target)).toBe(true);
    // Rebuilt, not preserved: the uncommitted file did not survive.
    expect(await exists(scratch)).toBe(false);
    expect((await registeredWorktrees()).filter((p) => p === target)).toHaveLength(1);
  });
});
