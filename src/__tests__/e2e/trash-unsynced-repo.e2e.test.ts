import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A configured repository whose bare clone does not exist yet: `trash` must
// answer in one line, not with an "Unhandled error" stack from simple-git.
describe("sync-worktrees trash before the first sync (E2E)", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-trash-unsynced-")));
    configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await fs.writeFile(
      configPath,
      `export default { repositories: [${JSON.stringify({
        name: "app",
        repoUrl: `file://${path.join(tempDir, "remote", "app.git")}`,
        worktreeDir: path.join(tempDir, "worktrees"),
        bareRepoDir: path.join(tempDir, ".bare", "app"),
      })}] };\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const result = spawnSync(process.execPath, [binPath, ...args, "--config", configPath], {
      cwd: tempDir,
      encoding: "utf-8",
      env: { ...process.env, HOME: tempDir, SYNC_WORKTREES_CONFIG: undefined, SYNC_WORKTREES_UNIT_TEST: undefined },
      input: "",
      timeout: 30000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("lists an empty trash", () => {
    const result = run(["trash"]);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("No trash entries.");
    expect(result.status).toBe(0);
  });

  it("prints an empty JSON listing", () => {
    const result = run(["trash", "--json"]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ entries: [], invalidEntries: [], keepRefs: [] });
    expect(result.status).toBe(0);
  });

  it.each([
    ["restore", ["trash", "restore", "some-id"]],
    ["drop-keep-ref", ["trash", "drop-keep-ref", "some-name"]],
  ])("refuses %s in one line", (_label, args) => {
    const result = run(args);
    expect(result.stderr.trim()).toBe("❌ Repository 'app' has not been synced yet");
    expect(result.stderr).not.toMatch(/Unhandled error|GitConstructError|\n\s+at /);
    expect(result.status).toBe(1);
  });
});
