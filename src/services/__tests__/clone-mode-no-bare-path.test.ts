import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { ConfigError } from "../../errors";
import { GitService } from "../git.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";

// A clone-mode repository has no bare repository, so nothing may derive one
// from its URL: a URL with no repository path segment is valid there.
describe("clone mode derives no bare-repository path", () => {
  const worktreeDir = path.join(os.tmpdir(), "sync-worktrees-cln4-clone");
  const config = {
    mode: "clone",
    repoUrl: "https://git.example.com",
    worktreeDir,
    cronSchedule: "0 * * * *",
    runOnce: true,
  } as Config;

  it("constructs a service for a URL with no repository path segment", () => {
    expect(() => new WorktreeSyncService(config)).not.toThrow();
  });

  it("refuses a bare-repository path with a typed error instead of a cwd-relative guess", () => {
    const git = new GitService(config);
    expect(() => git.getBareRepoPath()).toThrow(ConfigError);
  });

  it("reads no worktree metadata for the clone", async () => {
    const git = new GitService(config);
    await expect(git.getWorktreeMetadata(worktreeDir)).resolves.toBeNull();
  });
});
