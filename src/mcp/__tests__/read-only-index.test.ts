import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryContext } from "../context";
import { handleDetectContext, handleGetWorktreeStatus, handleListWorktrees } from "../handlers";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

// The readOnlyHint tools must not refresh (rewrite) a worktree's index: in a
// parallel-agents setup that takes index.lock under another agent's commit.
describe("read-only MCP tools leave the git index alone (real git)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let mainPath: string;
  let indexPath: string;
  let ctx: RepositoryContext;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-index-")));
    const remote = path.join(tempDir, "remote", "app.git");
    const seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");

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
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    const config: RepositoryConfig = {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir: path.join(tempDir, ".bare", "app"),
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: tempDir,
    };
    const service = new WorktreeSyncService(config);
    await service.initialize();
    ctx = {
      autoSelectCurrentRepoIfSingleConfig: () => "app",
      getConfiguredRepositoryNames: () => [],
      getDiscoveredContext: () => null,
      getBaseCapabilities: () => undefined,
      getService: async () => service,
      getEntry: () => ({ name: "app" }),
      getCurrentRepo: () => "app",
      getLaunchCwd: () => tempDir,
      invalidateDiscovered: () => undefined,
    } as unknown as RepositoryContext;

    mainPath = pathResolution.getBranchWorktreePath(worktreeDir, "main");
    indexPath = path.resolve(mainPath, (await simpleGit(mainPath).revparse(["--git-path", "index"])).trim());
    // Stat-dirty but content-clean: a plain `git status` would refresh the index.
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(mainPath, "README.md"), past, past);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function expectIndexUntouched(run: () => Promise<CallToolResult>): Promise<void> {
    const before = await fs.stat(indexPath);
    const result = await run();
    expect(result.isError).toBeFalsy();
    const after = await fs.stat(indexPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }

  it("list_worktrees", async () => {
    await expectIndexUntouched(() => handleListWorktrees(ctx, {}));
  });

  it("get_worktree_status", async () => {
    await expectIndexUntouched(() => handleGetWorktreeStatus(ctx, { path: mainPath, includeDetails: true }));
  });

  it("detect_context { includeStatus }", async () => {
    await expectIndexUntouched(() =>
      handleDetectContext(new RepositoryContext(), { path: mainPath, includeStatus: true }),
    );
  });
});
