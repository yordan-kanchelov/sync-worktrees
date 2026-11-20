import * as fs from "fs/promises";
import * as path from "path";

import { GIT_OPERATIONS } from "../constants";

const WORKTREES_DIR = "worktrees";

const INDEX_LOCK = "index.lock";

const HEAD_LOCK = "HEAD.lock";

const BUSY_MARKERS: readonly string[] = [
  INDEX_LOCK,
  HEAD_LOCK,
  GIT_OPERATIONS.MERGE_HEAD,
  GIT_OPERATIONS.CHERRY_PICK_HEAD,
  GIT_OPERATIONS.REVERT_HEAD,
  GIT_OPERATIONS.BISECT_LOG,
  GIT_OPERATIONS.REBASE_MERGE,
  GIT_OPERATIONS.REBASE_APPLY,
];

export interface GitBusySignal {
  worktree: string;
  marker: string;
}

export function formatGitBusySignals(signals: readonly GitBusySignal[]): string {
  return signals.map((signal) => `${signal.worktree} (${signal.marker})`).join(", ");
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown";
}

async function describeWorktree(adminDir: string, fallbackName: string): Promise<string> {
  try {
    const raw: unknown = await fs.readFile(path.join(adminDir, "gitdir"), "utf-8");
    if (typeof raw !== "string") return fallbackName;
    const gitFile = raw.trim();
    if (!gitFile) return fallbackName;
    return path.basename(gitFile) === ".git" ? path.dirname(gitFile) : gitFile;
  } catch {
    return fallbackName;
  }
}

async function markersIn(dir: string, describe: () => Promise<string>): Promise<GitBusySignal[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)) ?? [];
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    return [{ worktree: await describe(), marker: `unreadable: ${code}` }];
  }

  const present = new Set(names);
  const markers = BUSY_MARKERS.filter((marker) => present.has(marker));
  if (markers.length === 0) return [];
  const worktree = await describe();
  return markers.map((marker) => ({ worktree, marker }));
}

export async function probeInFlightGitOperations(gitDir: string): Promise<GitBusySignal[]> {
  const signals = await markersIn(gitDir, async () => gitDir);

  const worktreesDir = path.join(gitDir, WORKTREES_DIR);
  let names: string[];
  try {
    names = (await fs.readdir(worktreesDir)) ?? [];
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return signals;
    return [...signals, { worktree: worktreesDir, marker: `unreadable: ${code}` }];
  }

  const perWorktree = await Promise.all(
    names.map((name) => {
      const adminDir = path.join(worktreesDir, name);
      return markersIn(adminDir, () => describeWorktree(adminDir, name));
    }),
  );
  return [...signals, ...perWorktree.flat()];
}
