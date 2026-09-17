import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";
import {
  handleDetectContext,
  handleGetWorktreeStatus,
  handleListWorktrees,
  handleLoadConfig,
  handleSetCurrentRepository,
  handleSync,
  handleUpdateWorktree,
} from "../handlers";
import {
  detectContextOutputSchema,
  getWorktreeStatusOutputSchema,
  listWorktreesOutputSchema,
  loadConfigOutputSchema,
  setCurrentRepositoryOutputSchema,
  syncOutputSchema,
  updateWorktreeOutputSchema,
} from "../output-schemas";
import { formatErrorResponse } from "../utils";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { GitService } from "../../services/git.service";
import type { SyncResult } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";

// Every other MCP handler suite hands the handlers a hand-written `ctx`: its
// getDiscoveredContext is a constant, its capabilities are literals and its
// invalidateDiscovered is a spy that does nothing. That makes the whole
// ctx/service state machine — detection, the discovery cache, repository
// selection, capability derivation — untestable from the handler side, so a
// regression in it passes every one of those tests.
//
// These flows use the REAL RepositoryContext against a temporary bare/worktree
// fixture and the REAL WorktreeSyncService. Only three seams are faked:
// simple-git (so no git process runs), WorktreeSyncService.sync (so no network
// or clone happens) and WorktreeSyncService.getGitService (so the per-worktree
// probes answer deterministically). `isCloneMode` and `getWorktrees` are the
// real methods — they are what the handlers now call through the real type
// instead of a duck-typed cast.
//
// Every flow also `.parse()`s the tool's advertised output schema. The SDK
// validates `structuredContent` against that schema on the wire, so a response
// that drops a required field is an `isError` result for every real client
// while still satisfying any assertion written against the fields a test
// happens to name. Note the schemas are `z.looseObject`: a parse catches a
// missing or mistyped required field, never an extra one.

type GitCommandFn = (baseDir: string | undefined, command: string[]) => Promise<string>;

const gitRaw = vi.hoisted(() => vi.fn<GitCommandFn>());
const gitRemote = vi.hoisted(() => vi.fn<GitCommandFn>());

vi.mock("simple-git", () => ({
  default: vi.fn((...args: unknown[]) => {
    const baseDir = typeof args[0] === "string" ? args[0] : undefined;
    const client: Record<string, unknown> = {
      raw: (command: string[]) => gitRaw(baseDir, command),
      remote: (command: string[]) => gitRemote(baseDir, command),
    };
    // createGitClient returns the result of .env(), so it has to be the client.
    client.env = (): unknown => client;
    client.cwd = (): unknown => client;
    return client;
  }),
}));

const REPO_URL = "https://github.com/acme/app.git";
const MISSING_DIR_ERROR = "Cannot use simple-git on a directory that does not exist";

/** Porcelain listings keyed by the resolved bare-repo path git is asked about. */
const listings = new Map<string, string>();

function porcelain(entries: Array<{ path: string; branch: string }>): string {
  return entries.map((entry) => `worktree ${entry.path}\nbranch refs/heads/${entry.branch}\n`).join("\n");
}

function fullStatus(): Record<string, unknown> {
  return {
    isClean: true,
    hasUnpushedCommits: false,
    hasStashedChanges: false,
    hasOperationInProgress: false,
    hasModifiedSubmodules: false,
    upstreamGone: false,
    fullyPushedUpstreamDeleted: false,
    canRemove: true,
    reasons: [],
    divergence: { ahead: 2, behind: 1 },
  };
}

function makeFakeGit(): Record<string, any> {
  return {
    fetchAll: vi.fn<any>().mockResolvedValue(undefined),
    fetchBranch: vi.fn<any>().mockResolvedValue(undefined),
    branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
    createBranch: vi.fn<any>().mockResolvedValue(undefined),
    pushBranch: vi.fn<any>().mockResolvedValue(undefined),
    addWorktree: vi.fn<any>().mockResolvedValue({ status: "created", head: "abc1234" }),
    updateWorktree: vi.fn<any>().mockResolvedValue({ updated: true, before: "old111", after: "new222" }),
    getWorktrees: vi.fn<any>().mockResolvedValue([]),
    getFullWorktreeStatus: vi.fn<any>().mockResolvedValue(fullStatus()),
    getWorktreeMetadata: vi.fn<any>().mockResolvedValue({ lastSyncDate: "2024-05-01T00:00:00.000Z" }),
    getDefaultBranch: vi.fn<any>().mockReturnValue("main"),
    getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([]),
  };
}

let fakeGit: Record<string, any>;
let syncSpy: ReturnType<typeof vi.spyOn>;

async function invoke<T>(
  handler: (ctx: RepositoryContext, params: T) => Promise<CallToolResult>,
  ctx: RepositoryContext,
  params: T,
): Promise<CallToolResult> {
  try {
    return await handler(ctx, params);
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * Reads a tool result and, for a success result, checks it against the schema
 * the server advertises for that tool. `structuredContent` is compared with the
 * text block as well: the SDK sends both and a client may read either.
 */
function readResult(result: CallToolResult, schema: z.ZodType | null): any {
  const [block] = result.content as Array<{ type: string; text: string }>;
  const body = JSON.parse(block.text);
  if (result.isError === true) {
    return { ...body, isError: true };
  }
  expect(result.structuredContent).toEqual(body);
  if (schema) {
    expect(() => schema.parse(result.structuredContent)).not.toThrow();
  }
  return body;
}

interface Fixture {
  root: string;
  repoRoot: string;
  bareRepo: string;
  worktreesDir: string;
  mainWorktree: string;
  featureWorktree: string;
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const repoRoot = path.join(root, "app");
  const bareRepo = path.join(repoRoot, ".bare");
  const worktreesDir = path.join(repoRoot, "worktrees");
  const mainWorktree = path.join(worktreesDir, "main");
  const featureWorktree = path.join(worktreesDir, "feature-x");

  for (const [worktree, admin] of [
    [mainWorktree, path.join(bareRepo, "worktrees", "main")],
    [featureWorktree, path.join(bareRepo, "worktrees", "feature-x")],
  ]) {
    await fs.mkdir(admin, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${admin}\n`, "utf-8");
  }

  listings.set(
    path.resolve(bareRepo),
    porcelain([
      { path: mainWorktree, branch: "main" },
      { path: featureWorktree, branch: "feature-x" },
    ]),
  );

  return { root, repoRoot, bareRepo, worktreesDir, mainWorktree, featureWorktree };
}

const cleanups: string[] = [];

beforeEach(() => {
  listings.clear();
  fakeGit = makeFakeGit();

  gitRemote.mockReset();
  gitRemote.mockImplementation(async (_baseDir, command) => {
    if (command[0] === "get-url") return `${REPO_URL}\n`;
    throw new Error(`unexpected git remote ${command.join(" ")}`);
  });

  gitRaw.mockReset();
  gitRaw.mockImplementation(async (baseDir, command) => {
    if (command[0] === "worktree" && command[1] === "list") {
      const listing = listings.get(path.resolve(baseDir ?? ""));
      if (listing === undefined) throw new Error(MISSING_DIR_ERROR);
      return listing;
    }
    throw new Error(`unexpected git ${command.join(" ")} in ${baseDir ?? "<no dir>"}`);
  });

  syncSpy = vi.spyOn(WorktreeSyncService.prototype, "sync");
  syncSpy.mockResolvedValue({ started: true } as SyncResult);
  // Only the flows below decide when a repository counts as cloned; nothing
  // here may reach the real initialize(), which would clone over the network.
  vi.spyOn(WorktreeSyncService.prototype, "isInitialized").mockReturnValue(true);
  vi.spyOn(WorktreeSyncService.prototype, "getGitService").mockImplementation(() => fakeGit as unknown as GitService);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    await fs.rm(cleanups.pop() as string, { recursive: true, force: true });
  }
});

async function fixture(prefix: string): Promise<Fixture> {
  const made = await makeFixture(prefix);
  cleanups.push(made.root);
  return made;
}

async function writeConfig(dir: string, body: string): Promise<string> {
  const configPath = path.join(dir, "sync-worktrees.config.js");
  await fs.writeFile(configPath, body, "utf-8");
  return configPath;
}

// One repoUrl per entry: two entries sharing a URL are legal but make the
// loader warn about reorder-proofing, which is noise this suite is not about.
function repoBlock(name: string, bareRepoDir: string, worktreeDir: string, repoUrl = REPO_URL): string {
  return (
    `{ name: ${JSON.stringify(name)}, repoUrl: ${JSON.stringify(repoUrl)}, ` +
    `bareRepoDir: ${JSON.stringify(bareRepoDir)}, worktreeDir: ${JSON.stringify(worktreeDir)}, ` +
    `cronSchedule: "0 * * * *" }`
  );
}

// ---------------------------------------------------------------------------
// 1. auto-detect -> mutating tool -> sync denied
// ---------------------------------------------------------------------------

describe("flow: auto-detect, then a mutating tool, then sync", () => {
  it("denies sync after update_worktree has cleared the discovery cache", async () => {
    const fx = await fixture("t105-autodetect-");
    const ctx = new RepositoryContext({ launchCwd: fx.mainWorktree });

    const detected = readResult(
      await invoke(handleDetectContext, ctx, { path: fx.mainWorktree }),
      detectContextOutputSchema,
    );

    expect(detected.kind).toBe("unmanaged");
    expect(detected.bareRepoPath).toBe(fx.bareRepo);
    expect(detected.worktreeDir).toBe(fx.worktreesDir);
    expect(detected.allWorktrees.map((w: { path: string }) => w.path)).toEqual([fx.mainWorktree, fx.featureWorktree]);
    // Auto-detect has no config, so the two config-driven capabilities are off
    // while the two worktree-mutating ones are on.
    expect(detected.capabilities.updateWorktree).toEqual({ available: true });
    expect(detected.capabilities.sync.available).toBe(false);
    expect(detected.capabilities.initialize.available).toBe(false);
    expect(ctx.__discoveryCacheSizeForTest()).toBe(1);

    // get_worktree_status rides on the snapshot the detection just stored.
    const status = readResult(
      await invoke(handleGetWorktreeStatus, ctx, { path: fx.mainWorktree }),
      getWorktreeStatusOutputSchema,
    );
    expect(status.path).toBe(fx.mainWorktree);
    expect(status.divergence).toEqual({ ahead: 2, behind: 1 });

    const updated = readResult(
      await invoke(handleUpdateWorktree, ctx, { path: fx.mainWorktree }),
      updateWorktreeOutputSchema,
    );
    expect(updated).toEqual({ success: true, worktreePath: fx.mainWorktree, updated: true });
    expect(fakeGit.fetchBranch).toHaveBeenCalledWith("main");

    // The real invalidateDiscovered ran: both the per-path cache and the
    // entry's snapshot are gone.
    expect(ctx.__discoveryCacheSizeForTest()).toBe(0);
    expect(ctx.getDiscoveredContext()).toBeNull();

    // T1's bypass: with the discovery snapshot cleared, the capability gate
    // used to fall through to "allowed" and let sync run against a repository
    // that was never configured.
    const denied = readResult(await invoke(handleSync, ctx, {}), null);
    expect(denied.isError).toBe(true);
    expect(denied.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(denied.message).toBe(
      "Capability 'sync' unavailable: no config file loaded (running in auto-detect mode); " +
        "call load_config or detect_context from a configured workspace",
    );
    expect(syncSpy).not.toHaveBeenCalled();

    // And the cleared cache is a real re-read, not a stale replay: the second
    // detection reports the listing git gives now.
    listings.set(path.resolve(fx.bareRepo), porcelain([{ path: fx.mainWorktree, branch: "main" }]));
    const redetected = readResult(
      await invoke(handleDetectContext, ctx, { path: fx.mainWorktree }),
      detectContextOutputSchema,
    );
    expect(redetected.allWorktrees.map((w: { path: string }) => w.path)).toEqual([fx.mainWorktree]);
  });
});

// ---------------------------------------------------------------------------
// 2. load_config (single and multi repo) -> selection
// ---------------------------------------------------------------------------

describe("flow: load_config then repository selection", () => {
  it("auto-selects the only repository of a single-repo config", async () => {
    const fx = await fixture("t105-load-single-");
    const configPath = await writeConfig(
      fx.root,
      `export default { defaults: { runOnce: true }, repositories: [ ${repoBlock("solo", fx.bareRepo, fx.worktreesDir)} ] };`,
    );

    const ctx = new RepositoryContext({ launchCwd: fx.root });
    const loaded = readResult(await invoke(handleLoadConfig, ctx, { configPath }), loadConfigOutputSchema);

    expect(loaded.configPath).toBe(configPath);
    expect(loaded.currentRepository).toBe("solo");
    expect(loaded.repositories).toEqual([
      { name: "solo", repoUrl: REPO_URL, worktreeDir: fx.worktreesDir, source: "config" },
    ]);

    // The selection is what the next tool acts on: sync with no repoName must
    // reach `solo`, and a configured repo has the sync capability.
    const synced = readResult(await invoke(handleSync, ctx, {}), syncOutputSchema);
    expect(synced.outcome.repoName).toBe("solo");
    expect(synced.outcome.mode).toBe("worktree");
    expect(synced.success).toBe(true);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves a multi-repo config unselected until set_current_repository picks one", async () => {
    const fx = await fixture("t105-load-multi-");
    const betaWorktrees = path.join(fx.root, "beta", "worktrees");
    const configPath = await writeConfig(
      fx.root,
      `export default { defaults: { runOnce: true }, repositories: [ ` +
        `${repoBlock("alpha", fx.bareRepo, fx.worktreesDir)}, ` +
        `${repoBlock("beta", path.join(fx.root, "beta", ".bare"), betaWorktrees, "https://github.com/acme/beta.git")} ] };`,
    );

    const ctx = new RepositoryContext({ launchCwd: fx.root });
    const loaded = readResult(await invoke(handleLoadConfig, ctx, { configPath }), loadConfigOutputSchema);

    expect(loaded.currentRepository).toBeNull();
    expect(loaded.repositories.map((r: { name: string }) => r.name)).toEqual(["alpha", "beta"]);

    // Nothing may be selected by default, so a repo-scoped tool has to refuse.
    const ambiguous = readResult(await invoke(handleSync, ctx, {}), null);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.message).toContain("No repository specified and no current repository set.");
    expect(syncSpy).not.toHaveBeenCalled();

    // A name the config does not list is refused by ctx.getService, before any
    // service is built or any fallback to the current repository happens.
    const ghost = readResult(await invoke(handleListWorktrees, ctx, { repoName: "ghost" }), null);
    expect(ghost.isError).toBe(true);
    expect(ghost.message).toBe(
      "Repository 'ghost' not found. Known repos: [alpha, beta]. Run load_config or detect_context to register it.",
    );

    const selected = readResult(
      await invoke(handleSetCurrentRepository, ctx, { repoName: "beta" }),
      setCurrentRepositoryOutputSchema,
    );
    expect(selected.currentRepository).toBe("beta");

    const synced = readResult(await invoke(handleSync, ctx, {}), syncOutputSchema);
    expect(synced.outcome.repoName).toBe("beta");
    expect(synced.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. sync outcome carrying failed counts
// ---------------------------------------------------------------------------

describe("flow: sync reporting a partly failed outcome", () => {
  it("reports success=false and lists every failed action", async () => {
    const fx = await fixture("t105-sync-failed-");
    const configPath = await writeConfig(
      fx.root,
      `export default { defaults: { runOnce: true }, repositories: [ ${repoBlock("solo", fx.bareRepo, fx.worktreesDir)} ] };`,
    );

    const removalFailure = {
      kind: "failed",
      scope: "worktree",
      branch: "old/one",
      path: path.join(fx.worktreesDir, "old-one"),
      reason: "remove_failed",
      error: "worktree is locked",
    };
    const sparseFailure = {
      kind: "failed",
      scope: "sparse-checkout",
      branch: "feature-x",
      reason: "sparse_failed",
      error: "sparse-checkout set failed",
    };
    syncSpy.mockResolvedValue({
      started: true,
      outcome: {
        repoName: "solo",
        mode: "worktree",
        started: true,
        counts: { created: 1, removed: 0, updated: 0, skipped: 0, preserved: 0, failed: 2, noop: 0 },
        actions: [{ kind: "created", branch: "feature-x", path: fx.featureWorktree }, removalFailure, sparseFailure],
      },
    } as unknown as SyncResult);

    const ctx = new RepositoryContext({ launchCwd: fx.root });
    await invoke(handleLoadConfig, ctx, { configPath });

    const synced = readResult(await invoke(handleSync, ctx, {}), syncOutputSchema);

    expect(synced.success).toBe(false);
    expect(synced.failed).toBe(2);
    expect(synced.failures).toEqual([removalFailure, sparseFailure]);
    expect(synced.outcome.counts.failed).toBe(2);
    expect(synced.outcome.counts.created).toBe(1);
    expect(typeof synced.outcome.durationMs).toBe("number");
    expect(synced.skips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. list_worktrees against a bare repository that is not on disk
// ---------------------------------------------------------------------------

describe("flow: list_worktrees for a repository that was never cloned", () => {
  it("names the cause and the remedy per repository without failing the call", async () => {
    const fx = await fixture("t105-list-missing-");
    const absentBare = path.join(fx.root, "absent", ".bare");
    const configPath = await writeConfig(
      fx.root,
      `export default { defaults: { runOnce: true }, repositories: [ ` +
        `${repoBlock("present", fx.bareRepo, fx.worktreesDir)}, ` +
        `${repoBlock("absent", absentBare, path.join(fx.root, "absent", "worktrees"), "https://github.com/acme/absent.git")} ] };`,
    );

    const ctx = new RepositoryContext({ launchCwd: fx.root });
    await invoke(handleLoadConfig, ctx, { configPath });

    const listed = readResult(await invoke(handleListWorktrees, ctx, {}), listWorktreesOutputSchema);

    expect(Object.keys(listed.repositories).sort()).toEqual(["absent", "present"]);
    expect(listed.repositories.present.error).toBeUndefined();
    expect(listed.repositories.present.worktrees.map((w: { path: string }) => w.path)).toEqual([
      fx.mainWorktree,
      fx.featureWorktree,
    ]);
    expect(listed.repositories.absent.worktrees).toEqual([]);
    expect(listed.repositories.absent.error).toBe(
      `Cannot list worktrees for 'absent': ${MISSING_DIR_ERROR}. ` +
        `Nothing was detected on disk either. If the repository has not been cloned yet, run 'initialize' first`,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. update_worktree after the worktree disappeared
// ---------------------------------------------------------------------------

describe("flow: update_worktree after a worktree disappears", () => {
  it("refuses the path the discovery snapshot still lists and fast-forwards nothing", async () => {
    const fx = await fixture("t105-vanished-");
    const ctx = new RepositoryContext({ launchCwd: fx.mainWorktree });

    const detected = readResult(
      await invoke(handleDetectContext, ctx, { path: fx.mainWorktree }),
      detectContextOutputSchema,
    );
    expect(detected.allWorktrees.map((w: { path: string }) => w.path)).toEqual([fx.mainWorktree, fx.featureWorktree]);

    // The worktree goes away out of band. Nothing tells the context, so its
    // snapshot still lists feature-x — which is exactly the state a mutating
    // tool must not trust.
    await fs.rm(fx.featureWorktree, { recursive: true, force: true });
    listings.set(path.resolve(fx.bareRepo), porcelain([{ path: fx.mainWorktree, branch: "main" }]));
    expect(ctx.getDiscoveredContext()?.allWorktrees.map((w) => w.path)).toEqual([fx.mainWorktree, fx.featureWorktree]);

    const refused = readResult(await invoke(handleUpdateWorktree, ctx, { path: fx.featureWorktree }), null);

    expect(refused.isError).toBe(true);
    expect(refused.message).toBe(`Path '${fx.featureWorktree}' is not a registered worktree of the current repository`);
    expect(fakeGit.fetchBranch).not.toHaveBeenCalled();
    expect(fakeGit.updateWorktree).not.toHaveBeenCalled();

    // The worktree that is still registered still updates, so the refusal above
    // is about that path and not about the repository.
    const updated = readResult(
      await invoke(handleUpdateWorktree, ctx, { path: fx.mainWorktree }),
      updateWorktreeOutputSchema,
    );
    expect(updated).toEqual({ success: true, worktreePath: fx.mainWorktree, updated: true });
  });
});
