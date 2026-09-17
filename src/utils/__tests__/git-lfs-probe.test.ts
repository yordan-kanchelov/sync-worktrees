import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { ENV_CONSTANTS } from "../../constants";
import {
  GIT_LFS_MISSING_WARNING,
  isGitLfsInstalled,
  isLfsSmudgeSkippedByEnv,
  resetGitLfsProbeForTests,
  warnGitLfsMissingOnce,
} from "../git-lfs-probe";

describe("git-lfs probe", () => {
  beforeEach(() => {
    resetGitLfsProbeForTests();
  });

  it("runs the probe once and reuses its answer", async () => {
    const runProbe = vi.fn<() => Promise<string>>().mockResolvedValue("git-lfs/3.4.0\n");
    const second = vi.fn<() => Promise<string>>().mockResolvedValue("git-lfs/3.4.0\n");

    await expect(isGitLfsInstalled(runProbe)).resolves.toBe(true);
    await expect(isGitLfsInstalled(second)).resolves.toBe(true);

    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("reports git-lfs as missing when the probe rejects, and keeps that answer", async () => {
    const runProbe = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("git: 'lfs' is not a git command"));

    await expect(isGitLfsInstalled(runProbe)).resolves.toBe(false);
    await expect(isGitLfsInstalled(runProbe)).resolves.toBe(false);

    expect(runProbe).toHaveBeenCalledTimes(1);
  });

  // A client that throws instead of returning a promise (a directory that
  // vanished) must not leave the probe unanswered for the rest of the process.
  it("treats a probe that throws synchronously as 'not installed'", async () => {
    const runProbe = vi.fn(() => {
      throw new Error("spawn git ENOENT");
    }) as unknown as () => Promise<unknown>;

    await expect(isGitLfsInstalled(runProbe)).resolves.toBe(false);
  });

  it("warns about a missing git-lfs only once per process", () => {
    const warn = vi.fn();

    warnGitLfsMissingOnce(warn);
    warnGitLfsMissingOnce(warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(GIT_LFS_MISSING_WARNING);
  });

  describe("isLfsSmudgeSkippedByEnv", () => {
    const original = process.env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE];

    afterEach(() => {
      setEnvVar(ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE, original);
    });

    it.each(["1", "true", "TRUE", "on", "yes", "t"])("reads %j as 'smudge disabled'", (value) => {
      setEnvVar(ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE, value);
      expect(isLfsSmudgeSkippedByEnv()).toBe(true);
    });

    // git-lfs does not trim, so a padded value still smudges and must keep its
    // verification.
    it.each([undefined, "", "0", "false", "off", " 1 "])("reads %j as 'smudge enabled'", (value) => {
      setEnvVar(ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE, value);
      expect(isLfsSmudgeSkippedByEnv()).toBe(false);
    });
  });
});
