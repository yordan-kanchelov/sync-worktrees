import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupTempDirectories, createTempDirectory, setEnvVar } from "../../__tests__/test-utils";
import { ENV_CONSTANTS, PATH_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../lock-path";

import type { Config } from "../../types";

const LOCK_DIR = ENV_CONSTANTS.LOCK_DIR;

function makeConfig(worktreeDir: string): Config {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir,
    cronSchedule: "0 * * * *",
    runOnce: true,
  };
}

describe("getWorktreeDirLockTarget", () => {
  const originalHome = process.env.HOME;
  const originalStateHome = process.env.XDG_STATE_HOME;
  const originalLockDir = process.env[LOCK_DIR];
  let realDir: string;
  let linkDir: string;

  beforeEach(async () => {
    realDir = await createTempDirectory();
    linkDir = `${realDir}-link`;
    fsSync.symlinkSync(realDir, linkDir);
  });

  afterEach(async () => {
    setEnvVar("HOME", originalHome);
    setEnvVar("XDG_STATE_HOME", originalStateHome);
    setEnvVar(LOCK_DIR, originalLockDir);
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

  it("places the lock in a sibling directory of the canonical worktreeDir, never inside it", () => {
    const canonicalParent = fsSync.realpathSync(realDir);

    const viaReal = getWorktreeDirLockTarget(makeConfig(path.join(realDir, "wt")));
    const viaLink = getWorktreeDirLockTarget(makeConfig(path.join(linkDir, "wt")));

    expect(viaReal.dir).toBe(path.join(canonicalParent, PATH_CONSTANTS.LOCK_DIR_NAME));
    expect(viaLink).toEqual(viaReal);
    expect(path.relative(path.join(canonicalParent, "wt"), viaReal.dir).startsWith("..")).toBe(true);
  });

  it("returns the identical target whatever XDG_STATE_HOME and HOME the process carries (#T47)", () => {
    // A daemon started by systemd/launchd/cron (minimal env), a --runOnce from
    // a shell whose dotfiles export XDG_STATE_HOME, `sudo -E` versus plain
    // sudo (different HOME): all must contend for one lock file.
    const config = makeConfig(path.join(realDir, "wt"));
    const targets: {
      home: string;
      stateHome: string | undefined;
      target: ReturnType<typeof getWorktreeDirLockTarget>;
    }[] = [];
    for (const home of [os.homedir(), path.join(realDir, "other-home")]) {
      for (const stateHome of [undefined, path.join(home, ".local", "state"), path.join(realDir, "arbitrary-state")]) {
        setEnvVar("HOME", home);
        setEnvVar("XDG_STATE_HOME", stateHome);
        targets.push({ home, stateHome, target: getWorktreeDirLockTarget(config) });
      }
    }

    const [first, ...rest] = targets;
    for (const entry of rest) {
      expect(entry.target, `HOME=${entry.home} XDG_STATE_HOME=${String(entry.stateHome)}`).toEqual(first!.target);
    }
    expect(first!.target.dir).not.toContain(".cache");
    expect(first!.target.dir).not.toContain("arbitrary-state");
  });

  it("honours SYNC_WORKTREES_LOCK_DIR as the lock directory while keeping the worktreeDir-derived file name", () => {
    const config = makeConfig(path.join(realDir, "wt"));
    const byDefault = getWorktreeDirLockTarget(config);

    process.env[LOCK_DIR] = path.join(realDir, "custom-locks");
    const overridden = getWorktreeDirLockTarget(config);

    expect(overridden.dir).toBe(path.join(realDir, "custom-locks"));
    expect(overridden.file).toBe(byDefault.file);
  });

  it("treats an empty SYNC_WORKTREES_LOCK_DIR as unset", () => {
    const config = makeConfig(path.join(realDir, "wt"));
    const byDefault = getWorktreeDirLockTarget(config);

    process.env[LOCK_DIR] = "";

    expect(getWorktreeDirLockTarget(config)).toEqual(byDefault);
  });
});
