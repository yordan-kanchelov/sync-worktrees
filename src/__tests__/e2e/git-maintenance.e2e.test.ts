import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAINTENANCE_CONSTANTS } from "../../constants";
import { GitMaintenanceService } from "../../services/git-maintenance.service";
import { createMockLogger } from "../test-utils";

import type { GitService } from "../../services/git.service";
import type { Config } from "../../types";

const shouldSkip = process.env.SKIP_E2E_TESTS === "true";
const describeOrSkip = shouldSkip ? describe.skip : describe;

function git(repo: string, args: string): string {
  return execSync(`git -C "${repo}" ${args}`, { encoding: "utf-8" }).trim();
}

function objectExists(repo: string, sha: string): boolean {
  try {
    execSync(`git -C "${repo}" cat-file -e ${sha}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describeOrSkip("GitMaintenanceService E2E", () => {
  let repo: string;
  const gitServiceStub = { getBareRepoPath: () => "" } as unknown as GitService;

  const cloneConfig = (maintenance?: Config["maintenance"]): Config =>
    ({ mode: "clone", repoUrl: "unused", worktreeDir: repo, maintenance }) as Config;

  /**
   * Builds a repo with one reachable commit and one commit that is unreachable
   * (orphaned by `git reset`, with its reflog/ORIG_HEAD roots removed). Returns
   * the SHA of the unreachable commit.
   */
  function seedUnreachableCommit(): string {
    git(repo, "init -q");
    git(repo, 'config user.name "Test User"');
    git(repo, 'config user.email "test@example.com"');

    execSync(`git -C "${repo}" commit -q --allow-empty -m A`, { encoding: "utf-8" });
    execSync(`git -C "${repo}" commit -q --allow-empty -m B`, { encoding: "utf-8" });
    const unreachable = git(repo, "rev-parse HEAD");

    git(repo, "reset -q --hard HEAD~1");
    git(repo, "reflog expire --expire=now --all");
    execSync(`git -C "${repo}" update-ref -d ORIG_HEAD`, { encoding: "utf-8", stdio: "ignore" });

    return unreachable;
  }

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "swt-maint-e2e-"));
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("default `git gc` preserves recently-unreachable objects (2-week grace)", async () => {
    const unreachable = seedUnreachableCommit();
    expect(objectExists(repo, unreachable)).toBe(true);

    const svc = new GitMaintenanceService(cloneConfig(), gitServiceStub, createMockLogger());
    await svc.runIfDueUnlocked();

    expect(objectExists(repo, unreachable)).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(repo, ".git", MAINTENANCE_CONSTANTS.STATE_FILENAME), "utf-8"));
    expect(state.lastSuccessAt).toBeTruthy();
  });

  it("aggressive `git gc --prune=now` reclaims unreachable objects", async () => {
    const unreachable = seedUnreachableCommit();
    expect(objectExists(repo, unreachable)).toBe(true);

    const svc = new GitMaintenanceService(cloneConfig({ aggressive: true }), gitServiceStub, createMockLogger());
    await svc.runIfDueUnlocked();

    expect(objectExists(repo, unreachable)).toBe(false);
  });
});
