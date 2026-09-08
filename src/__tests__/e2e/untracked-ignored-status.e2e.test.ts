import { execSync } from "child_process";
import { writeFileSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeStatusService } from "../../services/worktree-status.service";
import { createMockLogger } from "../test-utils";

// Real git, deciding for itself what is ignored. `git status --porcelain -u`
// (what simple-git's statusTask runs) never puts an ignored path on a `??`
// line — with `--ignored`, which nothing here passes, ignored paths get their
// own `!!` lines that simple-git parses into `status.ignored` instead. So
// `status.not_added` is already the untracked-and-not-ignored list, and the
// `git check-ignore -- <every untracked path>` this service used to run after
// it could never remove anything.
//
// It could still fail: a worktree with a large untracked output directory that
// nothing gitignores put every path in it on one argv, and past the kernel's
// ARG_MAX the spawn died with E2BIG — checkWorktreeStatus threw and the update
// phase skipped that worktree as `update_check_failed` every tick instead of
// reporting the dirty worktree it actually had.
//
// Spawns are counted with a `git` shim first on PATH: every client this service
// builds carries the parent environment (see sanitizeGitEnv), so a shim
// installed before the service is constructed sees every git process it runs.
describe("Untracked vs ignored worktree status (E2E)", () => {
  let tempDir: string;
  let worktreePath: string;
  let shimLog: string;
  let originalPath: string | undefined;

  const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-untracked-")));
    shimLog = path.join(tempDir, "spawns.log");

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await fs.writeFile(path.join(seedDir, ".gitignore"), "*.tmp\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);

    const bareRepo = path.join(tempDir, "app.git");
    await simpleGit().clone(seedDir, bareRepo, ["--bare"]);

    // A linked worktree of a bare repository: exactly what this tool checks.
    worktreePath = path.join(tempDir, "worktrees", "main");
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await simpleGit(bareRepo).raw(["worktree", "add", worktreePath, "main"]);
  });

  afterEach(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    originalPath = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function installGitShim(): Promise<void> {
    const shimDir = path.join(tempDir, "shim");
    await fs.mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await fs.writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    });
    await fs.writeFile(shimLog, "");
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  }

  async function spawnedCommands(): Promise<string[]> {
    return (await fs.readFile(shimLog, "utf-8")).split("\n").filter((line) => line.length > 0);
  }

  const newService = (): WorktreeStatusService => new WorktreeStatusService({}, createMockLogger());

  it("reads a worktree whose only untracked file is gitignored as clean, without running check-ignore", async () => {
    await fs.writeFile(path.join(worktreePath, "a.tmp"), "scratch\n");
    await installGitShim();
    const service = newService();

    await expect(service.checkWorktreeStatus(worktreePath)).resolves.toBe(true);

    const full = await service.getFullWorktreeStatus(worktreePath, true);
    expect(full.isClean).toBe(true);
    expect(full.reasons).not.toContain("uncommitted changes");
    expect(full.details?.untrackedFiles).toBe(0);

    const commands = await spawnedCommands();
    // Guard the guard: if the shim ever stopped being seen, the assertion
    // below would pass while proving nothing.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((command) => command.startsWith("check-ignore"))).toEqual([]);
  });

  it("reads the same worktree as dirty once an unignored file appears", async () => {
    await fs.writeFile(path.join(worktreePath, "a.tmp"), "scratch\n");
    await fs.writeFile(path.join(worktreePath, "b.txt"), "real work\n");
    await installGitShim();
    const service = newService();

    await expect(service.checkWorktreeStatus(worktreePath)).resolves.toBe(false);

    const full = await service.getFullWorktreeStatus(worktreePath, true);
    expect(full.isClean).toBe(false);
    expect(full.canRemove).toBe(false);
    expect(full.reasons).toContain("uncommitted changes");
    // b.txt only: git left a.tmp out of the status in the first place.
    expect(full.details?.untrackedFilesList).toEqual(["b.txt"]);

    const commands = await spawnedCommands();
    // Guard the guard: if the shim ever stopped being seen, the assertion
    // below would pass while proving nothing.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((command) => command.startsWith("check-ignore"))).toEqual([]);
  });

  // 3 MiB of paths is past ARG_MAX on both supported platforms (2 MiB on
  // Linux, 1 MiB on macOS), so the old `check-ignore -- <every path>` spawn
  // failed here with E2BIG and the whole check threw.
  // Writing ~44k files takes a couple of seconds on a fast filesystem and can
  // take considerably longer on a slow one, so this case gets its own budget.
  it(
    "answers for a worktree holding an untracked output directory larger than ARG_MAX",
    { timeout: 120_000 },
    async () => {
      const generatedDir = path.join(worktreePath, "dist/webpack-cache/client-production/static-chunks/generated");
      await fs.mkdir(generatedDir, { recursive: true });

      const relativeDir = path.relative(worktreePath, generatedDir);
      let argvBytes = 0;
      let index = 0;
      while (argvBytes < 3 * 1024 * 1024) {
        const name = `chunk-${String(index).padStart(6, "0")}-0123456789abcdef0123456789abcdef.module.js`;
        writeFileSync(path.join(generatedDir, name), "x");
        argvBytes += path.join(relativeDir, name).length + 1;
        index++;
      }

      await installGitShim();
      const service = newService();

      await expect(service.checkWorktreeStatus(worktreePath)).resolves.toBe(false);

      const full = await service.getFullWorktreeStatus(worktreePath, true);
      expect(full.isClean).toBe(false);
      expect(full.reasons).toContain("uncommitted changes");
      expect(full.details?.untrackedFiles).toBe(index);

      const commands = await spawnedCommands();
      // Guard the guard: if the shim ever stopped being seen, the assertion
      // below would pass while proving nothing.
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.filter((command) => command.startsWith("check-ignore"))).toEqual([]);
    },
  );
});
