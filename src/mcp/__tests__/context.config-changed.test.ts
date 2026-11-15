import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryContext } from "../context";

function config(bareRepoDir: string, worktreeDir: string, cron: string): string {
  return (
    `export default { defaults: { runOnce: true }, repositories: [{ ` +
    `name: "app", repoUrl: "https://example.com/app.git", ` +
    `bareRepoDir: ${JSON.stringify(bareRepoDir)}, ` +
    `worktreeDir: ${JSON.stringify(worktreeDir)}, ` +
    `cronSchedule: ${JSON.stringify(cron)} }] };\n`
  );
}

describe("detectFromPath with a loaded config edited on disk", () => {
  let workspace: string;
  let configPath: string;
  let project: string;
  let bare: string;
  let wt: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp8-cfg-changed-"));
    configPath = path.join(workspace, "sync-worktrees.config.js");
    project = path.join(workspace, "project");
    bare = path.join(workspace, ".bare");
    wt = path.join(workspace, "wt");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(configPath, config(bare, wt, "0 * * * *"), "utf-8");
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const changedNote = (notes: string[]): string | undefined => notes.find((n) => n.includes("CONFIG_CHANGED"));

  async function bumpMtime(): Promise<void> {
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(configPath, future, future);
  }

  it("carries no note while the loaded config is unchanged", async () => {
    const ctx = new RepositoryContext();
    const first = await ctx.detectFromPath(project);
    expect(first.configPath).toBe(configPath);
    const second = await ctx.detectFromPath(project);
    expect(changedNote(second.notes)).toBeUndefined();
  });

  it("notes an edit to the loaded config on the next detect_context", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(project);

    await fs.writeFile(configPath, config(bare, wt, "*/5 * * * *"), "utf-8");
    await bumpMtime();

    const after = await ctx.detectFromPath(project);
    expect(changedNote(after.notes)).toBe(
      `CONFIG_CHANGED: ${configPath} changed on disk since it was loaded; call load_config to apply it.`,
    );
  });

  it("ignores a touch that leaves the bytes alone", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(project);
    await bumpMtime();
    const after = await ctx.detectFromPath(project);
    expect(changedNote(after.notes)).toBeUndefined();
  });

  it("drops the note once load_config re-reads the file", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(project);
    await fs.writeFile(configPath, config(bare, wt, "*/5 * * * *"), "utf-8");
    await bumpMtime();
    expect(changedNote((await ctx.detectFromPath(project)).notes)).toBeDefined();

    await ctx.loadConfig(configPath);
    expect(changedNote((await ctx.detectFromPath(project)).notes)).toBeUndefined();
  });
});
