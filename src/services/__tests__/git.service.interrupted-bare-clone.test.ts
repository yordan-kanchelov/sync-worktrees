import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { PATH_CONSTANTS } from "../../constants";
import { GitService } from "../git.service";

import type { Logger } from "../logger.service";
import type { GitServiceOptions } from "../git.service";
import type { Mock } from "vitest";

// Real git, no mocks. `git clone --bare` runs init_db before it transfers
// anything, so HEAD appears within milliseconds: a HEAD-less bareRepoDir is
// not the residue of a killed clone (a kill leaves HEAD in place, a SIGTERM
// removes the whole destination) but of a half-finished cleanup or external
// damage. However it arose, "bare repo exists" is decided by `<bare>/HEAD`, so
// every later initialize() re-ran `git clone --bare` into that directory and
// git refused it ("destination path already exists and is not an empty
// directory") until someone deleted it by hand.
//
// The marker is written only for a destination verified to be absent or empty,
// which is what makes a marked HEAD-less directory provably one this tool
// made, and therefore the only one that may be deleted and cloned again.
// Everything else is left untouched and named in an error.
describe("GitService initialize after an interrupted bare clone (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let markerPath: string;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-interrupted-clone-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    markerPath = path.join(tempDir, ".bare", `app${PATH_CONSTANTS.BARE_CLONE_PENDING_MARKER_SUFFIX}`);
    logger = createMockLogger();

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
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeService(): GitService {
    return new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir } satisfies GitServiceOptions,
      logger,
    );
  }

  // What a hard kill during `git clone --bare` leaves: the transfer's objects
  // and config, no HEAD.
  async function leaveInterruptedClone({ marked }: { marked: boolean }): Promise<void> {
    await fs.mkdir(path.join(bareRepoDir, "objects", "pack"), { recursive: true });
    await fs.writeFile(path.join(bareRepoDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
    if (marked) await fs.writeFile(markerPath, new Date().toISOString());
  }

  it("removes a marked HEAD-less leftover and clones again into a working bare repository", async () => {
    await leaveInterruptedClone({ marked: true });

    const service = makeService();
    await expect(service.initialize()).resolves.toBeDefined();

    // A real bare repository now, with the default-branch worktree registered
    // exactly as a first-run clone leaves it.
    const bareGit = simpleGit(bareRepoDir);
    await expect(bareGit.raw(["rev-parse", "--is-bare-repository"])).resolves.toContain("true");
    await expect(fs.access(path.join(bareRepoDir, "HEAD"))).resolves.toBeUndefined();
    await expect(bareGit.raw(["rev-parse", "refs/remotes/origin/main"])).resolves.toMatch(/^[0-9a-f]{40}/);
    const worktreeList = await bareGit.raw(["worktree", "list", "--porcelain"]);
    expect(worktreeList).toContain(path.join(worktreeDir, "main"));
    await expect(fs.readFile(path.join(worktreeDir, "main", "README.md"), "utf8")).resolves.toBe("# app");

    // The marker is settled, so the next init adopts the repository instead of
    // deleting it again.
    await expect(fs.access(markerPath)).rejects.toThrow();
    expect((logger.warn as Mock).mock.calls.flat().join("\n")).toContain(path.resolve(bareRepoDir));
  });

  it("refuses to delete an unmarked HEAD-less directory and names it in the error", async () => {
    await leaveInterruptedClone({ marked: false });

    const service = makeService();
    await expect(service.initialize()).rejects.toMatchObject({
      code: "CONFIG_BARE_DESTINATION_NOT_EMPTY",
      message: expect.stringContaining(path.resolve(bareRepoDir)),
    });

    // Nothing of the user's directory was touched.
    await expect(fs.readFile(path.join(bareRepoDir, "config"), "utf8")).resolves.toContain("bare = true");
    await expect(fs.access(path.join(bareRepoDir, "objects"))).resolves.toBeUndefined();
  });

  // The destination need not be a directory at all. A path that cannot be
  // listed is never claimed with a marker, so no run — not the first, not the
  // second — is ever authorized to delete what is really there.
  it("never deletes user data at a bareRepoDir that is a file, on any run", async () => {
    await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
    await fs.writeFile(bareRepoDir, "USER DATA");

    for (const _run of [1, 2]) {
      await expect(makeService().initialize()).rejects.toMatchObject({
        code: "CONFIG_BARE_DESTINATION_UNREADABLE",
        message: expect.stringContaining(path.resolve(bareRepoDir)),
      });
      await expect(fs.readFile(bareRepoDir, "utf8")).resolves.toBe("USER DATA");
      await expect(fs.access(markerPath)).rejects.toThrow();
    }
  });

  it("clears a stale marker next to a finished clone without touching the repository", async () => {
    await makeService().initialize();
    const headBefore = (await simpleGit(bareRepoDir).raw(["rev-parse", "HEAD"])).trim();
    // A clone that landed but was killed before its marker could be removed.
    await fs.writeFile(markerPath, new Date().toISOString());

    await expect(makeService().initialize()).resolves.toBeDefined();

    await expect(fs.access(markerPath)).rejects.toThrow();
    await expect(simpleGit(bareRepoDir).raw(["rev-parse", "HEAD"])).resolves.toContain(headBefore);
    await expect(fs.readFile(path.join(worktreeDir, "main", "README.md"), "utf8")).resolves.toBe("# app");
  });
});
