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

export function getCloneModeLockTarget(config: Config): RepoLockTarget {
  const name = (config as RepositoryConfig).name;
  const configDir = config.__configFileDir;

  const hash = createHash("sha256").update(path.resolve(config.worktreeDir)).digest("hex").slice(0, 16);

  if (configDir) {
    return {
      dir: path.join(configDir, ".sync-worktrees-state"),
      file: `${sanitizeNameForPath(name ?? "repo", "clone-mode lock name")}-${hash}.lock`,
    };
  }

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
