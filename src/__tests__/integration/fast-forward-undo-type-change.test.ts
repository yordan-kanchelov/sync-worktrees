import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { undoRejectedFastForwardIn } from "../../services/clone-sync/fast-forward-undo";
import { createMockLogger } from "../test-utils";

// Real git, no mocks. The upstream commit turns a tracked file into a symlink
// and adds a path whose smudge filter fails. The rejected `merge --ff-only`
// writes the symlink first, which `git status` reports as ` T` — a code
// simple-git puts in none of not_added/modified/deleted, only in `files`. Read
// from those lists, the undo never saw the path and left the checkout dirty
// for every later tick.
describe.skipIf(process.platform === "win32")("Undoing a rejected fast-forward that wrote a type change", () => {
  let tempDir: string;
  let workDir: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-ff-undo-type-")));
    const remote = path.join(tempDir, "remote.git");
    const seedDir = path.join(tempDir, "seed");
    workDir = path.join(tempDir, "work");

    await simpleGit().init(["--bare", remote]);
    await fs.mkdir(seedDir);
    git(seedDir, "init", "-q", "-b", "main");
    git(seedDir, "config", "user.name", "Test User");
    git(seedDir, "config", "user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "a.txt"), "hello\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-q", "-m", "initial");
    git(seedDir, "remote", "add", "origin", remote);
    git(seedDir, "push", "-q", "origin", "main");
    git(tempDir, "clone", "-q", "-b", "main", remote, workDir);

    await fs.rm(path.join(seedDir, "a.txt"));
    await fs.symlink("elsewhere", path.join(seedDir, "a.txt"));
    await fs.writeFile(path.join(seedDir, ".gitattributes"), "z.dat filter=broken\n");
    await fs.writeFile(path.join(seedDir, "z.dat"), "payload\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-q", "-m", "a.txt becomes a symlink; z.dat needs a filter");
    git(seedDir, "push", "-q", "origin", "main");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("restores the file the merge replaced with a symlink", async () => {
    git(workDir, "config", "filter.broken.smudge", "false");
    git(workDir, "config", "filter.broken.required", "true");
    git(workDir, "fetch", "-q", "origin");
    const before = git(workDir, "rev-parse", "HEAD");
    expect(() => git(workDir, "merge", "--ff-only", "origin/main")).toThrow();
    expect(git(workDir, "status", "--porcelain")).toContain(" T a.txt");

    const logger = createMockLogger();
    await undoRejectedFastForwardIn(
      { logger, repoName: "app", emitProgress: vi.fn() },
      simpleGit(workDir),
      workDir,
      "main",
      before,
    );

    expect(git(workDir, "rev-parse", "HEAD")).toBe(before);
    expect(git(workDir, "status", "--porcelain")).toBe("");
    expect((await fs.lstat(path.join(workDir, "a.txt"))).isFile()).toBe(true);
    expect(await fs.readFile(path.join(workDir, "a.txt"), "utf-8")).toBe("hello\n");
  });
});
