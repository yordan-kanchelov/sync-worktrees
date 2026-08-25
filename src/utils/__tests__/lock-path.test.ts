import * as fsSync from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { getWorktreeDirLockTarget } from "../lock-path";

import type { Config } from "../../types";

function makeConfig(worktreeDir: string): Config {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir,
    cronSchedule: "0 * * * *",
    runOnce: true,
  };
}

describe("getWorktreeDirLockTarget", () => {
  let realDir: string;
  let linkDir: string;

  beforeEach(async () => {
    realDir = await createTempDirectory();
    linkDir = `${realDir}-link`;
    fsSync.symlinkSync(realDir, linkDir);
  });

  afterEach(async () => {
    fsSync.rmSync(linkDir, { force: true });
    await cleanupTempDirectories();
  });

  it("hashes symlinked spellings of an existing directory to the same lock file", () => {
    const viaReal = getWorktreeDirLockTarget(makeConfig(realDir));
    const viaLink = getWorktreeDirLockTarget(makeConfig(linkDir));

    expect(viaLink.file).toBe(viaReal.file);
  });

  it("hashes symlinked spellings to the same lock file when several trailing components do not exist yet (#review)", () => {
    // /link/new/child vs /real/new/child with neither 'new' nor 'child' on
    // disk: canonicalization must walk up to the nearest existing ancestor,
    // not give up after the immediate parent.
    const viaReal = getWorktreeDirLockTarget(makeConfig(path.join(realDir, "new", "child")));
    const viaLink = getWorktreeDirLockTarget(makeConfig(path.join(linkDir, "new", "child")));

    expect(viaLink.file).toBe(viaReal.file);
  });

  it("keeps genuinely different directories on different lock files", () => {
    const a = getWorktreeDirLockTarget(makeConfig(path.join(realDir, "a")));
    const b = getWorktreeDirLockTarget(makeConfig(path.join(realDir, "b")));

    expect(a.file).not.toBe(b.file);
  });
});
