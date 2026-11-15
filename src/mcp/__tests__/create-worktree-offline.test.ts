import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleCreateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryContext } from "../context";
import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Real git: origin becomes unreachable after the first sync, and a
// create_worktree that does not push must still work on local refs.
describe("create_worktree with origin unreachable (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let ctx: RepositoryContext;

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

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-offline-")));
    remote = path.join(tempDir, "remote", "app.git");
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
      getDiscoveredContext: () => null,
      getBaseCapabilities: () => undefined,
      getService: async () => service,
      getEntry: () => ({ name: "app" }),
      invalidateDiscovered: () => undefined,
    } as unknown as RepositoryContext;

    await fs.rename(remote, `${remote}.gone`);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates a new branch without push and warns that existence came from the last fetch", async () => {
    const body = await create({ branchName: "feature/offline", baseBranch: "main", push: false });

    expect(body.isError).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.pushed).toBe(false);
    expect(body.warning).toMatch(/last successful fetch/);
    const head = await simpleGit(body.worktreePath).revparse(["--abbrev-ref", "HEAD"]);
    expect(head.trim()).toBe("feature/offline");
  });
});
