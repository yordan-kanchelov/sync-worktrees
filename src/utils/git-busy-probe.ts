import * as fs from "fs/promises";
import * as path from "path";

import { GIT_OPERATIONS } from "../constants";

/** Git's admin directory for linked worktrees, inside the shared git dir. */
const WORKTREES_DIR = "worktrees";

/** The lockfile every index-writing git command holds while it rewrites the index. */
const INDEX_LOCK = "index.lock";

// Held while git updates the checkout's HEAD. Sampling a commit loop 200 times
// found `index.lock` in 8.5% of samples and `HEAD.lock` in 2.5%, and the two
// never overlapped — `HEAD.lock` covers the ref-update instant, which is
// precisely the window this guard is about: the moment a commit's tree and
// commit objects exist but nothing references them yet. It costs no extra
// syscall, since the same directory listing already answers for it.
const HEAD_LOCK = "HEAD.lock";

/**
 * Entries that say a git command is running, or an operation is half-finished,
 * in the checkout that owns this admin directory. `index.lock` and `HEAD.lock`
 * are the in-flight signals (`git add`, `git commit`, `git checkout`, an IDE
 * auto-staging); the rest are states a person left behind and will come back
 * to finish. A marker left by a crashed command reports busy until it is
 * cleared, which is why the caller names the marker it found.
 */
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
  /** The checkout the marker belongs to, as a path when one could be read. */
  worktree: string;
  /** The marker that was found, or the listing error that could be hiding one. */
  marker: string;
}

export function formatGitBusySignals(signals: readonly GitBusySignal[]): string {
  return signals.map((signal) => `${signal.worktree} (${signal.marker})`).join(", ");
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown";
}

// git writes `<gitDir>/worktrees/<name>/gitdir` holding the path of the
// checkout's own `.git` file. Reporting the checkout is far more useful than
// reporting git's internal admin-directory name, which is only its basename
// and gains a numeric suffix when two checkouts share one.
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

// One listing rather than a probe per marker: `index.lock` exists for
// milliseconds, so the fewer syscalls between reading the directory and acting
// on it the better, and it makes a lockfile and a `rebase-merge/` directory the
// same kind of answer.
async function markersIn(dir: string, describe: () => Promise<string>): Promise<GitBusySignal[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)) ?? [];
  } catch (error) {
    const code = errorCode(error);
    // A directory that is not there holds no in-flight work.
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    // Anything else means the markers cannot be read, and one of them could be
    // sitting right there. Say so rather than report the checkout idle.
    return [{ worktree: await describe(), marker: `unreadable: ${code}` }];
  }

  const present = new Set(names);
  const markers = BUSY_MARKERS.filter((marker) => present.has(marker));
  if (markers.length === 0) return [];
  const worktree = await describe();
  return markers.map((marker) => ({ worktree, marker }));
}

/**
 * Look for git commands in flight, and unfinished git operations, in the
 * checkouts that share `gitDir`'s object store.
 *
 * This is a point-in-time check, not mutual exclusion: it can only see what is
 * on disk at the instant it runs, and someone can start `git commit` a
 * millisecond after it returns clean. What it reliably catches is the
 * long-lived states — a conflicted merge or an interactive rebase someone
 * walked away from, an `index.lock` a crashed or still-running command is
 * holding — because those persist for minutes rather than milliseconds. It is
 * a reason to refuse, never evidence that proceeding is safe.
 */
export async function probeInFlightGitOperations(gitDir: string): Promise<GitBusySignal[]> {
  // In clone mode this is the checkout's own `.git`, so its markers are a
  // worktree's. A bare repository has none of them in normal use, and one
  // showing up there means somebody is running git against the bare repo.
  const signals = await markersIn(gitDir, async () => gitDir);

  const worktreesDir = path.join(gitDir, WORKTREES_DIR);
  let names: string[];
  try {
    names = (await fs.readdir(worktreesDir)) ?? [];
  } catch (error) {
    const code = errorCode(error);
    // No `worktrees/` is the normal shape of a repository with no linked
    // worktrees, clone mode included.
    if (code === "ENOENT" || code === "ENOTDIR") return signals;
    // Otherwise the registrations cannot be enumerated, so every checkout
    // behind them is unaccounted for.
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
