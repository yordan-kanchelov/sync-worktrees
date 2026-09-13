import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ENV_CONSTANTS, PATH_CONSTANTS } from "../constants";

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
// the same lock file or both processes proceed. Missing trailing components
// are walked up to the nearest EXISTING ancestor — several components may not
// exist yet on a first run, and canonicalizing only the immediate parent
// would leave /link/a/b and /real/a/b on different lock keys — so the key
// stays stable between the first run (which creates the directory) and every
// later one.
function canonicalizeForLockKey(dir: string): string {
  const resolved = path.resolve(dir);
  let candidate = resolved;
  const missingSuffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(candidate), ...missingSuffix);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

// The lock is keyed ONLY by the canonical worktreeDir: two different config
// files (or a config-mode daemon and a programmatic run) pointing at the same
// checkout must contend for the same lock file, so it cannot live under a
// per-config state dir the way the audit log does. Clone mode holds this as
// its only lock; worktree mode holds it in addition to the bare-repo lock,
// because the default bare path is derived per config file and two configs
// can point different bare repos at the same worktreeDir.
//
// Where the file lives is part of that key, so it must not depend on the
// environment either: the processes this lock serializes — a systemd,
// launchd or cron-started daemon with a minimal environment, a --runOnce from
// an interactive shell whose dotfiles export XDG_STATE_HOME, `sudo -E`
// versus plain sudo — routinely disagree on XDG_STATE_HOME and HOME, and two
// processes that derive different lock paths for the same checkout never
// contend. The lock therefore sits next to the canonical worktreeDir, in
// `<parent>/.sync-worktrees-locks/`: never inside worktreeDir, which is the
// checkout itself in clone mode and is created and pruned by sync in worktree
// mode, and never under ~/.cache, which cache cleaners may delete under a
// live holder. SYNC_WORKTREES_LOCK_DIR is the one deliberate escape hatch
// (a read-only parent directory) and must be set identically for every
// process that shares a worktreeDir.
export function getWorktreeDirLockTarget(config: Config): RepoLockTarget {
  const canonical = canonicalizeForLockKey(config.worktreeDir);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  const override = process.env[ENV_CONSTANTS.LOCK_DIR];
  const dir = override ? path.resolve(override) : path.join(path.dirname(canonical), PATH_CONSTANTS.LOCK_DIR_NAME);
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
