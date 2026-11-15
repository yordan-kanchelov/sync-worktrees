import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryContext } from "../context";
import { handleGetWorktreeStatus, handleUpdateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";

import type { CallToolResult } from "@modelcontextprotocol/server";

// Real git. git lists worktrees by canonical path, while agents pass $PWD,
// which keeps symlinks (every path under /tmp and /var on macOS). Here the
// whole workspace, config included, is reached through `link -> real`.
describe("MCP tools on paths reached through a symlink (real git)", () => {
  let tempDir: string;
  let real: string;
  let link: string;
  let ctx: RepositoryContext;

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

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-symlink-")));
    real = path.join(tempDir, "real");
    link = path.join(tempDir, "link");
    const remote = path.join(tempDir, "remote", "app.git");
    const seedDir = path.join(tempDir, "seed");

    await fs.mkdir(real, { recursive: true });
    await fs.symlink(real, link);
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

    await fs.writeFile(
      path.join(real, "sync-worktrees.config.js"),
      `export default { defaults: { runOnce: true }, repositories: [{ ` +
        `name: "app", repoUrl: ${JSON.stringify(`file://${remote}`)}, ` +
        `bareRepoDir: "./.bare/app", worktreeDir: "./worktrees", cronSchedule: "0 * * * *" }] };\n`,
      "utf-8",
    );

    ctx = new RepositoryContext({ launchCwd: link });
    await ctx.loadConfig(path.join(link, "sync-worktrees.config.js"));
    await (await ctx.getService("app")).initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("detect_context marks the symlinked worktree current and matches the config", async () => {
    const result = await ctx.detectFromPath(path.join(link, "worktrees", "main"));

    expect(result.kind).toBe("managed");
    expect(result.repoName).toBe("app");
    expect(result.currentBranch).toBe("main");
    expect(result.allWorktrees.filter((w) => w.isCurrent).map((w) => w.branch)).toEqual(["main"]);
    expect(result.siblingRepositories).toEqual([]);
    expect(ctx.__repoCountForTest()).toBe(1);
  });

  it("get_worktree_status accepts the symlinked spelling of a registered worktree", async () => {
    const result = await call(handleGetWorktreeStatus, { path: path.join(link, "worktrees", "main") });

    expect(result.isError).toBeUndefined();
    expect(result.path).toBe(path.join(real, "worktrees", "main"));
  });

  it("update_worktree accepts the symlinked spelling of a registered worktree", async () => {
    const result = await call(handleUpdateWorktree, { path: path.join(link, "worktrees", "main") });

    expect(result.isError).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.worktreePath).toBe(path.join(real, "worktrees", "main"));
  });
});
