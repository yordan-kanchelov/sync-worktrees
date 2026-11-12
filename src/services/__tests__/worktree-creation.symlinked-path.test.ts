import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { symlinksSupported } from "../../__tests__/helpers/symlink-support";
import { GitService } from "../git.service";

import type { Logger } from "../logger.service";
import type { Mock } from "vitest";

// Real git. git lists worktrees by their canonical path; a caller spelling the
// same directory through a symlink must still see it as registered, not as an
// orphaned directory to move aside and recreate.
describe("addWorktree through a symlinked spelling of a live worktree", async () => {
  const canSymlink = await symlinksSupported();
  let tempDir: string;
  let realWorktreeDir: string;
  let linkWorktreeDir: string;
  let logger: Logger;
  let gitService: GitService;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-symlinked-path-")));
    const remote = path.join(tempDir, "remote", "app.git");
    await fs.mkdir(path.join(tempDir, "real"));
    if (canSymlink) await fs.symlink(path.join(tempDir, "real"), path.join(tempDir, "link"), "dir");
    realWorktreeDir = path.join(tempDir, "real", "wt");
    linkWorktreeDir = path.join(tempDir, "link", "wt");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);
    const seedDir = path.join(tempDir, "seed");
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
    await seed.checkoutLocalBranch("feature/a");
    await seed.push("origin", "feature/a");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    logger = createMockLogger();
    gitService = new GitService(
      {
        repoUrl: `file://${remote}`,
        worktreeDir: realWorktreeDir,
        bareRepoDir: path.join(tempDir, ".bare", "app"),
      },
      logger,
    );
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.skipIf(!canSymlink)("returns already_registered and moves nothing", async () => {
    const realPath = path.join(realWorktreeDir, "feature-a");
    expect((await gitService.addWorktree("feature/a", realPath)).status).toBe("created");
    await fs.writeFile(path.join(realPath, "work.txt"), "uncommitted");

    const result = await gitService.addWorktree("feature/a", path.join(linkWorktreeDir, "feature-a"));

    expect(result.status).toBe("already_registered");
    await expect(fs.readFile(path.join(realPath, "work.txt"), "utf8")).resolves.toBe("uncommitted");
    expect(await fs.readdir(realWorktreeDir)).toEqual(expect.not.arrayContaining([".removed"]));
    const infoLines = (logger.info as Mock).mock.calls.map((call) => String(call[0]));
    expect(infoLines.filter((line) => line.includes("orphaned directory"))).toEqual([]);
  });
});
