import * as os from "os";
import * as path from "path";

import { CONFIG_FILE_NAMES } from "../constants";

import { fileExists } from "./file-exists";

export const CONFIG_PATH_ENV_VAR = "SYNC_WORKTREES_CONFIG";

export const CONFIG_OPTION_DESCRIPTION =
  "Path to the config file. Default: $SYNC_WORKTREES_CONFIG, else the nearest sync-worktrees.config.* in this directory or a parent (up to your home directory).";

export type ConfigPathSource = "flag" | "env" | "discovered";

export interface ResolvedConfigPath {
  path: string;
  source: ConfigPathSource;
}

export interface ConfigDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function isInside(dir: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

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

export function describeConfigPath(resolved: ResolvedConfigPath, cwd: string = process.cwd()): string {
  const relative = path.relative(cwd, resolved.path);
  const display = relative && relative.length < resolved.path.length ? relative : resolved.path;
  if (resolved.source === "env") return `${display} (from ${CONFIG_PATH_ENV_VAR})`;
  if (resolved.source === "discovered" && path.dirname(resolved.path) !== path.resolve(cwd)) {
    return `${display} (found in a parent directory)`;
  }
  return display;
}
