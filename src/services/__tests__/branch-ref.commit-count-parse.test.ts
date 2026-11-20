import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("GitService.countCommitsNotOnAnyRemote output parsing", () => {
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

  it.each([
    ["empty output", ""],
    ["a non-numeric line", "not a number"],
    ["a number with a trailing word", "0 refs"],
    ["a negative count", "-1"],
  ])("throws on %s instead of reading it as zero", async (_label, stdout) => {
    mockGit.raw.mockResolvedValue(stdout as never);

    await expect(service.countCommitsNotOnAnyRemote(OID)).rejects.toThrow("Could not read a commit count");
  });

  it("accepts the number git actually prints, surrounding whitespace included", async () => {
    mockGit.raw.mockResolvedValue("  7\n" as never);

    await expect(service.countCommitsNotOnAnyRemote(OID)).resolves.toBe(7);
    expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", OID, "--not", "--glob=refs/remotes/origin/"]);
  });

  it("rejects a digit string too long to survive parseInt", async () => {
    mockGit.raw.mockResolvedValue("9".repeat(400) as never);

    await expect(service.countCommitsNotOnAnyRemote(OID)).rejects.toThrow("Could not read a commit count");
  });

  it("propagates a rev-list that failed rather than defaulting the count", async () => {
    mockGit.raw.mockRejectedValue(new Error("fatal: bad object"));

    await expect(service.countCommitsNotOnAnyRemote(OID)).rejects.toThrow("fatal: bad object");
  });
});
