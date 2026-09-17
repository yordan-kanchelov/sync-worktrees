import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigLoaderService } from "../../services/config-loader.service";
import { RepositoryContext } from "../context";

const execFileAsync = promisify(execFile);

// Unbalanced braces: every JS parser rejects this, and the message says so
// rather than naming a missing field. `node --check` is deliberately not used
// to assert that anywhere here -- it reports on the file it is handed, not on
// whatever the module system ends up doing with it.
const BROKEN_CONFIG = `export default { repositories: [ { name: "app",\n`;

function fixedConfig(bareRepoDir: string, worktreeDir: string): string {
  return (
    `export default { defaults: { runOnce: true }, repositories: [{ ` +
    `name: "app", repoUrl: "https://example.com/app.git", ` +
    `bareRepoDir: ${JSON.stringify(bareRepoDir)}, ` +
    `worktreeDir: ${JSON.stringify(worktreeDir)}, ` +
    `cronSchedule: "0 * * * *" }] };\n`
  );
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", ...args], { cwd });
}

// Does real Node -- not vitest's Vite-backed `import()` -- accept this file as
// a module? vitest transforms dynamic imports itself and will happily evaluate
// things Node rejects, so a "this config is broken" premise checked inside the
// test runner can hold for entirely the wrong reason.
async function nodeImportOutcome(file: string): Promise<{ ok: boolean; message: string }> {
  const script = `import(process.argv[1]).then(() => { process.stdout.write("IMPORT_OK"); }, (e) => { process.stdout.write("IMPORT_FAILED:" + e.name + ":" + e.message); });`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, file], {
    encoding: "utf-8",
  });
  if (stdout.startsWith("IMPORT_OK")) return { ok: true, message: "" };
  return { ok: false, message: stdout.slice("IMPORT_FAILED:".length) };
}

describe("detectFromPath with a found-but-broken config", () => {
  let workspace: string;
  let configPath: string;
  let project: string;
  let loadConfigFileSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "t99-broken-cfg-"));
    configPath = path.join(workspace, "sync-worktrees.config.js");
    project = path.join(workspace, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(configPath, BROKEN_CONFIG, "utf-8");
    loadConfigFileSpy = vi.spyOn(ConfigLoaderService.prototype, "loadConfigFile");
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    loadConfigFileSpy.mockRestore();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function brokenConfigNote(notes: string[]): string | undefined {
    return notes.find((note) => note.startsWith("Found config at "));
  }

  // The message the loader actually rejected with, recovered from the spy
  // rather than guessed. Inside vitest the first evaluation of a path goes
  // through Vite, whose parse error reads nothing like Node's, so hard-coding
  // one parser's wording here would pin the test to the runner.
  async function lastLoadFailureMessage(): Promise<string> {
    const results = loadConfigFileSpy.mock.results;
    expect(results.length).toBeGreaterThan(0);
    try {
      await results[results.length - 1].value;
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected the last loadConfigFile call to have rejected");
  }

  it("uses a fixture real Node refuses to parse and a repair real Node accepts", async () => {
    const broken = await nodeImportOutcome(configPath);
    expect(broken.ok).toBe(false);
    expect(broken.message).toMatch(/^SyntaxError:/);

    await fs.writeFile(configPath, fixedConfig(path.join(workspace, ".bare"), path.join(workspace, "wt")), "utf-8");
    const repaired = await nodeImportOutcome(configPath);
    expect(repaired).toEqual({ ok: true, message: "" });
  });

  it("names the config path and the load error in notes", async () => {
    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(project);

    expect(result.configPath).toBeNull();
    // Whole-string equality: the note carries the loader's own error verbatim,
    // not a generic "could not load", and names the file it came from.
    const message = await lastLoadFailureMessage();
    expect(message).toContain("Failed to load config file:");
    expect(brokenConfigNote(result.notes)).toBe(
      `Found config at ${configPath} but it failed to load: ${message}. Fix it and call load_config.`,
    );
  });

  it("does not re-import the broken config while the file is unchanged", async () => {
    const ctx = new RepositoryContext();

    const first = await ctx.detectFromPath(project);
    expect(brokenConfigNote(first.notes)).toBeDefined();
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(1);

    // A plain directory is never entered into the discovery cache, so these are
    // genuine cache misses: only the failure gate can keep the loader idle.
    const second = await ctx.detectFromPath(project);
    const third = await ctx.detectFromPath(path.join(workspace, "project"));
    expect(ctx.__discoveryCacheSizeForTest()).toBe(0);
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(1);

    // Still reported every time, even though nothing was re-read.
    expect(brokenConfigNote(second.notes)).toBeDefined();
    expect(brokenConfigNote(third.notes)).toBeDefined();
  });

  it("re-imports and loads as soon as the file is repaired, and drops the note", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(project);
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(1);

    const before = await fs.stat(configPath);
    await fs.writeFile(configPath, fixedConfig(path.join(workspace, ".bare"), path.join(workspace, "wt")), "utf-8");
    const after = await fs.stat(configPath);
    expect(after.size).not.toBe(before.size);

    const repaired = await ctx.detectFromPath(project);

    expect(loadConfigFileSpy).toHaveBeenCalledTimes(2);
    expect(repaired.configPath).toBe(configPath);
    expect(brokenConfigNote(repaired.notes)).toBeUndefined();
    expect(ctx.getConfiguredRepositoryNames()).toEqual(["app"]);
  });

  it("re-imports a same-size edit that leaves mtime alone, on the hash by itself", async () => {
    const ctx = new RepositoryContext();
    // Pinned to a whole second, so mtimeMs is exactly representable on any
    // filesystem and can be put back identically after the edit. Restoring
    // `stat.mtime` cannot do that: it is a Date, so it truncates the
    // sub-millisecond precision ext4 really stores, the restored mtimeMs no
    // longer equals the recorded one, and the gate releases on its mtime half
    // without the hash ever being consulted -- which is the half this test
    // exists to take out of play.
    const pinnedSeconds = 1_700_000_000;
    await fs.utimes(configPath, pinnedSeconds, pinnedSeconds);
    const before = await fs.stat(configPath);
    await ctx.detectFromPath(project);
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(1);

    // One character, same byte count: the shape a stat-only gate misses on a
    // filesystem whose mtime resolution is coarser than the edit.
    const sameSizeBreakage = BROKEN_CONFIG.replace("{ name", "} name");
    expect(sameSizeBreakage.length).toBe(BROKEN_CONFIG.length);
    await fs.writeFile(configPath, sameSizeBreakage, "utf-8");
    await fs.utimes(configPath, pinnedSeconds, pinnedSeconds);

    // The premise, asserted rather than assumed: a stat-only gate -- mtime and
    // size alike -- has nothing whatsoever to go on here, so a re-import below
    // can only have come from the content hash.
    const after = await fs.stat(configPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);

    await ctx.detectFromPath(project);
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(2);
  });

  it("re-imports when the file is only touched, leaving the bytes alone", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(project);
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(1);

    const beforeMtimeMs = (await fs.stat(configPath)).mtimeMs;
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(configPath, future, future);
    // Guard against coarse-resolution filesystems: the premise of this test is
    // that fs.stat really does report a different mtime afterwards.
    expect((await fs.stat(configPath)).mtimeMs).toBeGreaterThan(beforeMtimeMs);

    const retried = await ctx.detectFromPath(project);
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(2);
    // This second evaluation is the one T35 routes through a worker thread,
    // which is a real Node module registry rather than vitest's: the note it
    // produces carries the parse error Node itself reports.
    expect(brokenConfigNote(retried.notes)).toContain("Unexpected end of input");
  });

  it("keeps the stderr line for a terminal operator, once per broken revision", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(project);
    await ctx.detectFromPath(project);
    await ctx.detectFromPath(project);

    const failureLines = stderrLines.filter((line) => line.startsWith("[sync-worktrees] auto-loaded config failed: "));
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]).toContain(await lastLoadFailureMessage());
  });

  it("stops reporting a broken config once the file is gone", async () => {
    const ctx = new RepositoryContext();
    const first = await ctx.detectFromPath(project);
    expect(brokenConfigNote(first.notes)).toBeDefined();

    await fs.rm(configPath);

    const second = await ctx.detectFromPath(project);
    expect(brokenConfigNote(second.notes)).toBeUndefined();
    expect(loadConfigFileSpy).toHaveBeenCalledTimes(1);
  });

  it("carries the note on an unmanaged worktree context and clears it on repair (real git)", async () => {
    const seed = path.join(workspace, "seed");
    const bareRepoDir = path.join(workspace, "repo", ".bare");
    const worktreeDir = path.join(workspace, "repo", "worktrees");
    await fs.mkdir(seed, { recursive: true });
    await git(seed, "init", "-q", "-b", "main", ".");
    await fs.writeFile(path.join(seed, "f.txt"), "hi\n", "utf-8");
    await git(seed, "add", ".");
    await git(seed, "commit", "-qm", "init");
    await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
    await execFileAsync("git", ["clone", "-q", "--bare", seed, bareRepoDir]);
    await fs.mkdir(worktreeDir, { recursive: true });
    const currentWorktree = path.join(worktreeDir, "main");
    await git(bareRepoDir, "worktree", "add", "-q", currentWorktree, "main");

    const ctx = new RepositoryContext();
    const broken = await ctx.detectFromPath(currentWorktree);

    expect(broken.kind).toBe("unmanaged");
    expect(broken.configPath).toBeNull();
    expect(broken.capabilities.sync.available).toBe(false);
    expect(brokenConfigNote(broken.notes)).toContain(configPath);

    await fs.writeFile(configPath, fixedConfig(bareRepoDir, worktreeDir), "utf-8");
    ctx.invalidateDiscovered();
    const repaired = await ctx.detectFromPath(currentWorktree);

    expect(repaired.kind).toBe("managed");
    expect(repaired.configPath).toBe(configPath);
    expect(repaired.repoName).toBe("app");
    expect(brokenConfigNote(repaired.notes)).toBeUndefined();
  });
});
