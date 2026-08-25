import { createHash } from "crypto";
import * as fs from "fs";
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

// Best-effort symlink canonicalization for lock keys: two spellings of the
// same directory (a symlinked $HOME, macOS /tmp -> /private/tmp) must hash to
// the same lock file or both processes proceed. When the directory itself does
// not exist yet, canonicalize its parent instead, so the key stays stable
// between the first run (which creates the directory) and every later one.
function canonicalizeForLockKey(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    /* directory missing or unreadable — try the parent */
  }
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

// The lock is keyed ONLY by the canonical worktreeDir: two different config
// files (or a config-mode daemon and a programmatic run) pointing at the same
// checkout must contend for the same lock file, so it cannot live under a
// per-config state dir the way the audit log does. Clone mode holds this as
// its only lock; worktree mode holds it in addition to the bare-repo lock,
// because the default bare path is derived per config file and two configs
// can point different bare repos at the same worktreeDir.
export function getWorktreeDirLockTarget(config: Config): RepoLockTarget {
  const hash = createHash("sha256").update(canonicalizeForLockKey(config.worktreeDir)).digest("hex").slice(0, 16);

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
