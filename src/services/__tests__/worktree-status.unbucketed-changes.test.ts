import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { WorktreeStatusService } from "../worktree-status.service";

// Real git. simple-git has no bucket for a type change (` T`, `T `) or for
// mixed states such as `MD`/`AD`: they appear only in `status.files`, with
// every array (modified, deleted, ...) empty. The dirty check must still see them.
describe("WorktreeStatusService with changes simple-git does not bucket (real git)", () => {
  let tempDir: string;
  let worktreePath: string;

  const git = (args: string): string => execSync(`git ${args}`, { cwd: worktreePath, encoding: "utf-8" });

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-unbucketed-")));
    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    execSync(
      `git init -q && git config user.name "Test User" && git config user.email test@example.com &&
       printf 'a\\n' > a.txt && printf 'b\\n' > b.txt && git add . && git commit -qm init && git branch -M main`,
      { cwd: seedDir, shell: "/bin/sh" },
    );
    const bareRepo = path.join(tempDir, "app.git");
    execSync(`git clone -q --bare "${seedDir}" "${bareRepo}"`);
    worktreePath = path.join(tempDir, "worktrees", "main");
    execSync(`git -C "${bareRepo}" worktree add -q "${worktreePath}" main`);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const service = (): WorktreeStatusService => new WorktreeStatusService({}, createMockLogger());

  it("sees a tracked file replaced by a symlink (` T`) as a change", async () => {
    await fs.rm(path.join(worktreePath, "a.txt"));
    await fs.symlink("b.txt", path.join(worktreePath, "a.txt"));
    expect(git("status --porcelain")).toBe(" T a.txt\n");

    expect(await service().checkWorktreeStatus(worktreePath)).toBe(false);

    const full = await service().getFullWorktreeStatus(worktreePath, true);
    expect(full.isClean).toBe(false);
    expect(full.canRemove).toBe(false);
    expect(full.reasons).toContain("uncommitted changes: 'a.txt'");
    expect(full.details?.modifiedFilesList).toEqual(["a.txt"]);
    expect(full.details?.modifiedFiles).toBe(1);
  });

  it("sees a staged edit deleted from the working tree (`MD`) as a change", async () => {
    await fs.writeFile(path.join(worktreePath, "b.txt"), "edited\n");
    git("add b.txt");
    await fs.rm(path.join(worktreePath, "b.txt"));
    expect(git("status --porcelain")).toBe("MD b.txt\n");

    expect(await service().checkWorktreeStatus(worktreePath)).toBe(false);

    const full = await service().getFullWorktreeStatus(worktreePath, true);
    expect(full.isClean).toBe(false);
    expect(full.canRemove).toBe(false);
    expect(full.reasons).toContain("uncommitted changes: 'b.txt'");
    expect(full.details?.modifiedFilesList).toEqual(["b.txt"]);
  });

  it("still reports an untouched worktree as clean", async () => {
    expect(await service().checkWorktreeStatus(worktreePath)).toBe(true);
    expect((await service().getFullWorktreeStatus(worktreePath, true)).isClean).toBe(true);
  });
});
