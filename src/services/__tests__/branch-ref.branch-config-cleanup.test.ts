import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

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
    mockGit.raw.mockImplementation((async (args: string[]) => {
      if (args[0] === "config") throw new TypeError("git client was torn down");
      return "";
    }) as unknown as SimpleGit["raw"]);

    await expect(service.deleteLocalBranchIfAt("feature", OID)).resolves.toBeUndefined();
    expect(mockGit.raw).toHaveBeenCalledWith(["config", "--remove-section", "branch.feature"]);
  });

  it("does not resolve until the config removal has finished", async () => {
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

    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRemoval();
    await pending;
    expect(settled).toBe(true);
  });
});
