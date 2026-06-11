import { createHash } from "crypto";
import * as os from "os";
import * as path from "path";

import { sanitizeNameForPath } from "./sanitize-name";

import type { Config, RepositoryConfig } from "../types";

export interface RepoLockTarget {
  /** Absolute path to the directory that should contain the lock file. */
  dir: string;
  /** Lock filename (created lazily by proper-lockfile). */
  file: string;
}

// The lock is keyed ONLY by the canonical worktreeDir: two different config
// files (or a config-mode daemon and a programmatic run) pointing at the same
// checkout must contend for the same lock file, so it cannot live under a
// per-config state dir the way the audit log does.
export function getCloneModeLockTarget(config: Config): RepoLockTarget {
  const hash = createHash("sha256").update(path.resolve(config.worktreeDir)).digest("hex").slice(0, 16);

  const stateBase =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".cache");
  const dir = path.join(stateBase, "sync-worktrees", "locks");
  return { dir, file: `${hash}.lock` };
}

export function getRemovalAuditLogPath(config: Config): string {
  const name = (config as RepositoryConfig).name;
  const configDir = config.__configFileDir;

  const hash = createHash("sha256").update(path.resolve(config.worktreeDir)).digest("hex").slice(0, 16);

  if (configDir) {
    return path.join(
      configDir,
      ".sync-worktrees-state",
      `${sanitizeNameForPath(name ?? "repo", "removal audit log name")}-${hash}-removals.jsonl`,
    );
  }

  const stateBase =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".cache");
  return path.join(stateBase, "sync-worktrees", "removals", `${hash}.jsonl`);
}
