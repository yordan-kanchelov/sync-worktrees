import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

// The real-git coverage of this cleanup lives in
// trash.service.branch-config.test.ts. Two properties cannot be reached from
// there, because real git only ever fails the removal one way and always
// fails it fast: that the catch is EVERY error rather than the git ones, and
// that the removal is awaited rather than left running. Both are what keeps a
// branch deletion that did succeed from being reported as failed, or from
// being reported as finished before its config was actually cleaned.
describe("GitService branch config cleanup after a compare-and-swap delete", () => {
  const OID = "a".repeat(40);
  let service: GitService;
  let mockGit: Mocked<SimpleGit>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGit = { raw: vi.fn(), env: vi.fn().mockReturnThis() } as unknown as Mocked<SimpleGit>;
    (simpleGit as unknown as Mock).mockReturnValue(mockGit);
    service = new GitService({
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
    } satisfies GitServiceOptions);
  });

  it("swallows a failure that is not a git error at all", async () => {
    // A narrowed `catch (error) if (error instanceof GitError)` passes every
    // real-git test in this repo, because `fatal: no such section` is the only
    // failure real git produces here. The rejections that are NOT GitError are
    // exactly the ones that must not surface: a torn-down client, an env
    // validation rejection, a task timeout. Any of them reaching the caller
    // turns a branch deletion that already succeeded into a reported failure —
    // and the ref is gone by then, so the caller's error is simply wrong.
    mockGit.raw.mockImplementation((async (args: string[]) => {
      if (args[0] === "config") throw new TypeError("git client was torn down");
      return "";
    }) as unknown as SimpleGit["raw"]);

    await expect(service.deleteLocalBranchIfAt("feature", OID)).resolves.toBeUndefined();
    expect(mockGit.raw).toHaveBeenCalledWith(["config", "--remove-section", "branch.feature"]);
  });

  it("does not resolve until the config removal has finished", async () => {
    // Real git clears the section in a millisecond, so a fire-and-forget
    // `void this.removeBranchConfigSection(...)` finishes during the awaits
    // that follow it and every real-git assertion still passes — the ordering
    // would be wall-clock luck rather than a guarantee. Holding the removal
    // open is the only way to tell the two apart.
    let releaseRemoval!: () => void;
    mockGit.raw.mockImplementation((async (args: string[]) => {
      if (args[0] === "config") {
        await new Promise<void>((resolve) => {
          releaseRemoval = resolve;
        });
      }
      return "";
    }) as unknown as SimpleGit["raw"]);

    let settled = false;
    const pending = service.deleteLocalBranchIfAt("feature", OID).then(() => {
      settled = true;
    });

    // Generous: far more turns of the event loop than an un-awaited removal
    // would need to complete on its own.
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRemoval();
    await pending;
    expect(settled).toBe(true);
  });
});
