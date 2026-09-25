import * as os from "os";
import * as path from "path";

import { CONFIG_FILE_NAMES } from "../constants";

import { fileExists } from "./file-exists";

/** Names a config file for the CLI when `--config` is not given. The MCP server does not read it. */
export const CONFIG_PATH_ENV_VAR = "SYNC_WORKTREES_CONFIG";

/** The `--config` help text every command shares, so none of them describes discovery differently. */
export const CONFIG_OPTION_DESCRIPTION =
  "Path to the config file. Default: $SYNC_WORKTREES_CONFIG, else the nearest sync-worktrees.config.* in this directory or a parent (up to your home directory).";

/** Where the CLI got its config path from, in precedence order. */
export type ConfigPathSource = "flag" | "env" | "discovered";

export interface ResolvedConfigPath {
  /** Absolute path. Only a `discovered` path is known to exist. */
  path: string;
  source: ConfigPathSource;
}

export interface ConfigDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** The walk-up ceiling; `os.homedir()` when omitted. */
  homeDir?: string;
}

function isInside(dir: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The first `sync-worktrees.config.{js,mjs,cjs,ts}` in `startDir` or one of its
 * parents. Like git's ceiling directories, the walk does not leave the home
 * directory when it started inside it: the home directory itself is the last
 * one checked, so a config in `~` is found and one in `/home` or `/` never is.
 * A start outside home (a CI checkout under `/builds`, `/tmp`) walks to the
 * filesystem root.
 */
export async function findConfigUpTree(startDir: string, homeDir: string = os.homedir()): Promise<string | null> {
  let current = path.resolve(startDir);
  const ceiling = homeDir && isInside(current, path.resolve(homeDir)) ? path.resolve(homeDir) : null;

  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(current, name);
      if (await fileExists(candidate)) return candidate;
    }
    if (current === ceiling) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The config the CLI should load: `--config`, then `SYNC_WORKTREES_CONFIG`,
 * then {@link findConfigUpTree} from the working directory. A flag or env path
 * is returned whether or not it exists, so the caller can say which of the two
 * named a missing file; relative ones resolve against `cwd`. An empty variable
 * counts as unset.
 */
export async function resolveConfigPath(
  cliPath: string | undefined,
  options: ConfigDiscoveryOptions = {},
): Promise<ResolvedConfigPath | null> {
  const cwd = options.cwd ?? process.cwd();
  if (cliPath) return { path: path.resolve(cwd, cliPath), source: "flag" };

  const fromEnv = (options.env ?? process.env)[CONFIG_PATH_ENV_VAR]?.trim();
  if (fromEnv) return { path: path.resolve(cwd, fromEnv), source: "env" };

  const discovered = await findConfigUpTree(cwd, options.homeDir);
  return discovered ? { path: discovered, source: "discovered" } : null;
}

/**
 * `sync-worktrees.config.js`, `../../sync-worktrees.config.js (found in a parent
 * directory)`, `/etc/x.js (from SYNC_WORKTREES_CONFIG)`: the path relative to
 * `cwd` when that is shorter, plus where it came from unless that is obvious.
 */
export function describeConfigPath(resolved: ResolvedConfigPath, cwd: string = process.cwd()): string {
  const relative = path.relative(cwd, resolved.path);
  const display = relative && relative.length < resolved.path.length ? relative : resolved.path;
  if (resolved.source === "env") return `${display} (from ${CONFIG_PATH_ENV_VAR})`;
  if (resolved.source === "discovered" && path.dirname(resolved.path) !== path.resolve(cwd)) {
    return `${display} (found in a parent directory)`;
  }
  return display;
}
