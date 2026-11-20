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

function git(repo: string, args: string): string {
  return execSync(`git -C "${repo}" ${args}`, { encoding: "utf-8" }).trim();
}

async function backdateObjects(gitDir: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  const objectsDir = path.join(gitDir, "objects");
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else await fs.utimes(full, when, when);
    }
    await fs.utimes(dir, when, when);
  };
  await walk(objectsDir);
}

function objectExists(repo: string, sha: string): boolean {
  try {
    execSync(`git -C "${repo}" cat-file -e ${sha}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("GitMaintenanceService E2E", () => {
  let repo: string;
  const gitServiceStub = { getBareRepoPath: () => "" } as unknown as GitService;

  const cloneConfig = (maintenance?: Config["maintenance"]): Config =>
    ({ mode: "clone", repoUrl: "unused", worktreeDir: repo, maintenance }) as Config;

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

  it("a forced run reclaims unreachable objects older than the grace window", async () => {
    const unreachable = seedUnreachableCommit();
    await backdateObjects(path.join(repo, ".git"), 65 * 60 * 1000);

    const svc = new GitMaintenanceService(cloneConfig(), gitServiceStub, createMockLogger());
    await expect(svc.runNowUnlocked()).resolves.toBe(true);

    expect(objectExists(repo, unreachable)).toBe(false);
  });

  it("leaves a fresh pack alone however old the commits inside it are", async () => {
    const unreachable = seedUnreachableCommit();
    await backdateObjects(path.join(repo, ".git"), 3 * 24 * 60 * 60 * 1000);
    git(repo, "branch pinned " + unreachable);
    execSync(`git -C "${repo}" gc -q`, { encoding: "utf-8" });
    const packDir = path.join(repo, ".git", "objects", "pack");
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000);
    for (const entry of await fs.readdir(packDir)) {
      await fs.utimes(path.join(packDir, entry), halfHourAgo, halfHourAgo);
    }
    execSync(`git -C "${repo}" branch -D pinned -q`, { encoding: "utf-8" });
    git(repo, "reflog expire --expire=now --all");

    const svc = new GitMaintenanceService(cloneConfig(), gitServiceStub, createMockLogger());
    await expect(svc.runNowUnlocked()).resolves.toBe(true);

    expect(objectExists(repo, unreachable)).toBe(true);
  });

  it("a forced run leaves objects written inside the grace window alone", async () => {
    const unreachable = seedUnreachableCommit();
    await backdateObjects(path.join(repo, ".git"), 55 * 60 * 1000);

    const svc = new GitMaintenanceService(cloneConfig(), gitServiceStub, createMockLogger());
    await expect(svc.runNowUnlocked()).resolves.toBe(true);

    expect(objectExists(repo, unreachable)).toBe(true);

    const aggressive = new GitMaintenanceService(cloneConfig({ aggressive: true }), gitServiceStub, createMockLogger());
    await expect(aggressive.runNowUnlocked()).resolves.toBe(true);
    expect(objectExists(repo, unreachable)).toBe(false);
  });
});
