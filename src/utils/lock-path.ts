import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ENV_CONSTANTS, PATH_CONSTANTS } from "../constants";

import { sanitizeNameForPath } from "./sanitize-name";

import type { Config, RepositoryConfig } from "../types";

export interface RepoLockTarget {
  dir: string;
  file: string;
}

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
      PATH_CONSTANTS.STATE_DIR_NAME,
      `${sanitizeNameForPath(name ?? "repo", "removal audit log name")}-${hash}-removals.jsonl`,
    );
  }

  const stateBase =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".cache");
  return path.join(stateBase, "sync-worktrees", "removals", `${hash}.jsonl`);
}
