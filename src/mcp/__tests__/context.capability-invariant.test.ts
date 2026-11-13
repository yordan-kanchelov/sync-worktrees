import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryContext } from "../context";
import {
  handleCreateWorktree,
  handleDetectContext,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListWorktrees,
  handleSync,
  handleUpdateWorktree,
} from "../handlers";

import type { Capabilities, DiscoveredRepoContext } from "../context";
import type { CallToolResult } from "@modelcontextprotocol/server";

type CapabilityKey = keyof Capabilities;

// Real git, no mocks. detect_context's capabilities block promises the agent
// what will work from where it stands; a capability reported available must
// never be answered with "No repository specified" by the tool it names.

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.name", "Test User");
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), "# main\n");
  await git.add(".");
  await git.commit("initial");
  await git.branch(["feature-x"]);
}

interface Fixture {
  origin: string;
  bareRepoDir: string;
  worktreeDir: string;
  worktree: string;
}

async function makeFixture(root: string): Promise<Fixture> {
  const origin = path.join(root, "origin");
  await initRepo(origin);
  const bareRepoDir = path.join(root, ".bare", "app.git");
  await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
  await simpleGit().clone(origin, bareRepoDir, ["--bare"]);
  await simpleGit(bareRepoDir).addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const worktreeDir = path.join(root, "worktrees");
  await fs.mkdir(worktreeDir, { recursive: true });
  const worktree = path.join(worktreeDir, "feature-x");
  await simpleGit(bareRepoDir).raw(["worktree", "add", worktree, "feature-x"]);
  return { origin, bareRepoDir, worktreeDir, worktree };
}

function resultText(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

async function callTool(ctx: RepositoryContext, key: CapabilityKey, worktree: string): Promise<string> {
  try {
    switch (key) {
      case "listWorktrees":
        return resultText(await handleListWorktrees(ctx, {}));
      case "getStatus":
        return resultText(await handleGetWorktreeStatus(ctx, { path: worktree }));
      case "createWorktree":
        return resultText(await handleCreateWorktree(ctx, { branchName: "invariant-branch", push: false }));
      case "updateWorktree":
        return resultText(await handleUpdateWorktree(ctx, { path: worktree }));
      case "sync":
        return resultText(await handleSync(ctx, {}));
      case "initialize":
        return resultText(await handleInitialize(ctx, {}));
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function expectAvailableToolsResolveARepository(
  ctx: RepositoryContext,
  capabilities: Capabilities,
  worktree: string,
): Promise<void> {
  const keys = Object.keys(capabilities) as CapabilityKey[];
  for (const key of keys.filter((k) => capabilities[k].available)) {
    const text = await callTool(ctx, key, worktree);
    expect({ key, text }).not.toEqual({ key, text: expect.stringContaining("No repository specified") });
  }
}

async function detect(ctx: RepositoryContext, target: string): Promise<DiscoveredRepoContext> {
  const result = await handleDetectContext(ctx, { path: target });
  return result.structuredContent as unknown as DiscoveredRepoContext;
}

describe("detect_context capabilities match what the tools then do", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cap-invariant-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports the selectable repository's capabilities from the workspace root", async () => {
    const fx = await makeFixture(tempDir);
    await fs.writeFile(
      path.join(tempDir, "sync-worktrees.config.js"),
      `export default { defaults: { runOnce: true }, repositories: [
        { name: "app", repoUrl: ${JSON.stringify(fx.origin)}, bareRepoDir: ${JSON.stringify(fx.bareRepoDir)}, worktreeDir: ${JSON.stringify(fx.worktreeDir)}, cronSchedule: "0 * * * *" }
      ] };`,
      "utf-8",
    );

    const ctx = new RepositoryContext({ launchCwd: tempDir });
    const discovered = await detect(ctx, tempDir);

    expect(discovered.isWorktree).toBe(false);
    expect(discovered.capabilities.sync).toEqual({ available: true });
    expect(discovered.capabilities.initialize).toEqual({ available: true });
    expect(discovered.capabilities.listWorktrees).toEqual({ available: true });
    expect(discovered.capabilities.updateWorktree).toEqual({ available: true });
    expect(discovered.notes.some((n) => n.includes("'app'"))).toBe(true);

    await expectAvailableToolsResolveARepository(ctx, discovered.capabilities, fx.worktree);
  });

  it("reports no worktree tool for a bare repository without an origin URL", async () => {
    const fx = await makeFixture(tempDir);
    await simpleGit(fx.bareRepoDir).remote(["remove", "origin"]);

    const ctx = new RepositoryContext({ launchCwd: fx.worktree });
    const discovered = await detect(ctx, fx.worktree);

    expect(discovered.isWorktree).toBe(true);
    expect(discovered.repoUrl).toBeNull();
    for (const key of ["listWorktrees", "getStatus", "updateWorktree", "createWorktree"] as const) {
      expect(discovered.capabilities[key].available, key).toBe(false);
    }
    expect(discovered.capabilities.updateWorktree.reason).toContain("origin");

    await expectAvailableToolsResolveARepository(ctx, discovered.capabilities, fx.worktree);
  });
});
