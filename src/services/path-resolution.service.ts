import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { fileExists } from "../utils/file-exists";
import { isCaseInsensitiveFs } from "../utils/path-compare";

const BRANCH_STEM_MAX = 80;
const BRANCH_HASH_LEN = 8;
const NAME_PROBE_CONCURRENCY = 16;

// Branch names a plain directory can carry unchanged apart from `/` → `-`.
// Anything else (spaces, `#`, `@`, non-ASCII, ...) would be substituted, and a
// substituted name is not worth keeping readable at the price of ambiguity.
const PLAIN_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
// Names Windows cannot create as a directory, whatever the extension.
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Directory names in worktreeDir that belong to the tool rather than to a
 * branch. No plain name can equal one (plain names never start with a dot),
 * but the reservation is recorded so it stays true if the rule ever loosens.
 */
export const RESERVED_WORKTREE_DIR_NAMES: readonly string[] = [
  GIT_CONSTANTS.BARE_DIR_NAME,
  GIT_CONSTANTS.DIVERGED_DIR_NAME,
  GIT_CONSTANTS.REMOVED_DIR_NAME,
  GIT_CONSTANTS.TRASH_DIR_NAME,
  PATH_CONSTANTS.GIT_DIR,
  PATH_CONSTANTS.STATE_DIR_NAME,
  PATH_CONSTANTS.LOCK_DIR_NAME,
];

/**
 * What a branch's plain directory name is checked against before it is used.
 * Built by {@link PathResolutionService.createNamingContext}.
 */
export interface WorktreeNamingContext {
  /** Folded plain name → every known branch that flattens to it. */
  readonly claimants: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Folded names already in use in worktreeDir or in the metadata store, each
   * mapped to the branch holding it, or to null when the holder is not a
   * branch worktree (a reserved name, a stray directory, a detached checkout)
   * or two holders disagree.
   */
  readonly taken: ReadonlyMap<string, string | null>;
}

export interface WorktreeNamingInput {
  /** Every branch that could claim a directory: origin's branches, plus the branch being named. */
  branches: Iterable<string>;
  /** The default branch; its worktree sits at `<worktreeDir>/<defaultBranch>` and keeps those names. */
  defaultBranch?: string;
  /** Every registered worktree, wherever it is: metadata is keyed by basename across all of them. */
  worktrees?: Iterable<{ path: string; branch: string }>;
  /** Further taken names, e.g. from {@link PathResolutionService.probeTakenNames}. */
  taken?: Iterable<readonly [string, string | null]>;
}

/** Where {@link PathResolutionService.probeTakenNames} looks. */
export interface WorktreeNamingDisk {
  worktreeDir: string;
  /** The bare repository; its `worktrees/` holds the admin dirs of this repository's worktrees. */
  bareRepoPath: string;
  /** The branch a metadata record under a directory name was written for, or null when there is none. */
  readMetadataOwner: (name: string) => Promise<string | null>;
}

/**
 * Folds a directory name for comparison. Always case-insensitive, whatever
 * this machine's filesystem does: a worktreeDir can be shared, synced or
 * copied to a case-insensitive volume, and two names that differ only in case
 * must never both be plain.
 */
export function foldWorktreeDirName(name: string): string {
  return name.toLowerCase();
}

function claimName(taken: Map<string, string | null>, name: string, owner: string | null): void {
  const key = foldWorktreeDirName(name);
  taken.set(key, taken.has(key) && taken.get(key) !== owner ? null : owner);
}

export class PathResolutionService {
  /**
   * The collision-proof directory name: the flattened branch name (truncated
   * to 80 characters) followed by `-` and 8 hex digits of the branch name's
   * SHA-256. Every worktree created before plain names has this form, and a
   * new worktree still gets it whenever its plain name is ambiguous or taken.
   */
  sanitizeBranchName(branchName: string): string {
    const stem = branchName
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, BRANCH_STEM_MAX);
    const hash = createHash("sha256").update(branchName).digest("hex").slice(0, BRANCH_HASH_LEN);
    return `${stem}-${hash}`;
  }

  /**
   * The readable directory name for a branch: the branch name with every `/`
   * turned into `-` (`feature/login` → `feature-login`). Null when the branch
   * cannot have one, which means it always gets {@link sanitizeBranchName}'s
   * hashed name: it holds a character other than ASCII letters, digits, `.`,
   * `_`, `-` and `/`, flattens to more than 80 characters, starts with `.` or
   * `-`, ends with `.`, or is a Windows device name.
   *
   * The flattening is not reversible (`feature/login` and `feature-login` both
   * give `feature-login`), which is why {@link branchDirectoryName} checks the
   * plain name against the other branches before using it.
   */
  plainBranchName(branchName: string): string | null {
    if (!PLAIN_BRANCH_RE.test(branchName)) return null;
    const name = branchName.replace(/\//g, "-");
    if (name.length > BRANCH_STEM_MAX) return null;
    if (/^[.-]/.test(name) || name.endsWith(".")) return null;
    if (WINDOWS_DEVICE_RE.test(name)) return null;
    return name;
  }

  /**
   * The directory name a new worktree for `branchName` gets.
   *
   * With a context, the plain name is used only when no other known branch
   * flattens to the same name case-insensitively and nothing else holds it;
   * otherwise the hashed name is. Every branch sharing a plain name is hashed,
   * not only the later one, so the answer does not depend on which of them
   * was seen first.
   *
   * Without a context the plain name is returned whenever the branch has one.
   * That is the preferred name, not a checked one: code that creates a
   * worktree must pass a context.
   */
  branchDirectoryName(branchName: string, context?: WorktreeNamingContext): string {
    const plain = this.plainBranchName(branchName);
    if (plain === null) return this.sanitizeBranchName(branchName);
    if (!context) return plain;

    const key = foldWorktreeDirName(plain);
    if (context.taken.has(key) && context.taken.get(key) !== branchName) {
      return this.sanitizeBranchName(branchName);
    }
    const claimants = context.claimants.get(key);
    if (claimants && [...claimants].some((other) => other !== branchName)) {
      return this.sanitizeBranchName(branchName);
    }
    return plain;
  }

  /** `<worktreeDir>/<branchDirectoryName>`; see there for what the context changes. */
  getBranchWorktreePath(worktreeDir: string, branchName: string, context?: WorktreeNamingContext): string {
    return path.join(worktreeDir, this.branchDirectoryName(branchName, context));
  }

  /**
   * Builds what {@link branchDirectoryName} checks a plain name against: the
   * branches that flatten to each plain name, and the names already held by a
   * registered worktree's directory (metadata is keyed by that basename, so a
   * worktree anywhere counts), by the default branch's worktree path, by the
   * tool's own directories, or by `input.taken`.
   */
  createNamingContext(input: WorktreeNamingInput): WorktreeNamingContext {
    const claimants = new Map<string, Set<string>>();
    for (const branch of input.branches) {
      const plain = this.plainBranchName(branch);
      if (plain === null) continue;
      const key = foldWorktreeDirName(plain);
      const set = claimants.get(key) ?? new Set<string>();
      set.add(branch);
      claimants.set(key, set);
    }

    const taken = new Map<string, string | null>();
    for (const name of RESERVED_WORKTREE_DIR_NAMES) claimName(taken, name, null);
    if (input.defaultBranch) {
      // The anchor worktree is `<worktreeDir>/<defaultBranch>`: `main`, or both
      // `release` and `2024` for `release/2024` (the last is its metadata key).
      for (const segment of input.defaultBranch.split("/")) {
        if (segment) claimName(taken, segment, null);
      }
    }
    for (const worktree of input.worktrees ?? []) {
      claimName(taken, path.basename(path.resolve(worktree.path)), worktree.branch || null);
    }
    for (const [name, owner] of input.taken ?? []) claimName(taken, name, owner);

    return { claimants, taken };
  }

  /**
   * Looks on disk for what would stop the plain names `branches` get from
   * `context`: an entry already at `<worktreeDir>/<name>`, or a metadata
   * record left under that name for another branch. Returns them as `taken`
   * entries for {@link createNamingContext}.
   *
   * An entry is anything at all (a dangling symlink too, and a probe that
   * fails counts as one), since sync would otherwise trash or quarantine it to
   * make room. The one exception is a checkout of this repository, one whose
   * `.git` file points into `<bareRepoPath>/worktrees/`: that is a worktree
   * made there before (git lists it as detached, or lost its registration),
   * and worktree creation already adopts or clears those, as it always has
   * for hashed names. A metadata record is held by the branch it was written
   * for, so that branch can take its old name back.
   *
   * Only the candidates are probed, typically the few branches a sync is about
   * to create; worktreeDir itself is never listed.
   */
  async probeTakenNames(
    branches: Iterable<string>,
    context: WorktreeNamingContext,
    disk: WorktreeNamingDisk,
  ): Promise<Array<[string, string | null]>> {
    const candidates = new Set<string>();
    for (const branch of branches) {
      const plain = this.plainBranchName(branch);
      if (plain !== null && this.branchDirectoryName(branch, context) === plain) candidates.add(plain);
    }

    // A first sync can name hundreds of branches at once; a bounded fan-out
    // keeps that from queueing every probe on libuv's thread pool together.
    const limit = pLimit(NAME_PROBE_CONCURRENCY);
    const verdicts = await Promise.all(
      [...candidates].map((name) =>
        limit(async (): Promise<[string, string | null] | null> => {
          const entry = await this.probeNamedEntry(path.join(disk.worktreeDir, name), disk.bareRepoPath);
          if (entry === "foreign") return [name, null];
          try {
            const owner = await disk.readMetadataOwner(name);
            return owner === null ? null : [name, owner];
          } catch {
            return [name, null];
          }
        }),
      ),
    );
    return verdicts.filter((verdict): verdict is [string, string | null] => verdict !== null);
  }

  // "own" for a checkout linked into this repository's worktree admin dirs.
  private async probeNamedEntry(entryPath: string, bareRepoPath: string): Promise<"missing" | "own" | "foreign"> {
    try {
      await fsp.lstat(entryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "foreign";
    }
    try {
      const link = await fsp.readFile(path.join(entryPath, PATH_CONSTANTS.GIT_DIR), "utf8");
      const match = typeof link === "string" ? /^gitdir:\s*(.+?)\s*$/m.exec(link) : null;
      if (!match) return "foreign";
      const adminDir = path.resolve(entryPath, match[1]);
      const adminRoot = path.join(bareRepoPath, "worktrees");
      const inside = this.isPathInsideBaseDir(adminDir, adminRoot) && !this.isPathInsideBaseDir(adminRoot, adminDir);
      return inside ? "own" : "foreign";
    } catch {
      return "foreign";
    }
  }

  /**
   * {@link createNamingContext} plus {@link probeTakenNames} for the branches
   * about to get a worktree: the context every worktree creation names its
   * directory with.
   */
  async createProbedNamingContext(
    input: {
      /** Every branch origin has. */
      branches: readonly string[];
      /** The branches a directory is about to be named for. */
      branchesToName: readonly string[];
      defaultBranch?: string;
      worktrees: ReadonlyArray<{ path: string; branch: string }>;
    },
    disk: WorktreeNamingDisk,
  ): Promise<WorktreeNamingContext> {
    const naming: WorktreeNamingInput = {
      branches: [...input.branches, ...input.branchesToName],
      defaultBranch: input.defaultBranch,
      worktrees: input.worktrees,
    };
    const context = this.createNamingContext(naming);
    const taken = await this.probeTakenNames(input.branchesToName, context, disk);
    return taken.length === 0 ? context : this.createNamingContext({ ...naming, taken });
  }

  private resolveRealPath(inputPath: string): string {
    const absolute = path.resolve(inputPath);
    const missing: string[] = [];
    let current = absolute;

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }

    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch {
      return absolute;
    }
  }

  // The async twin of resolveRealPath: same walk up to the deepest component
  // that exists, same suffix re-join, same "answer with the lexical path" for a
  // path with no existing ancestor and for a realpath that throws. `fileExists`
  // probes with the same `access` call `existsSync` makes and, like it, reads
  // any error as "not there", so the two agree on unreadable parents and on
  // path strings the fs layer rejects outright.
  private async resolveRealPathAsync(inputPath: string): Promise<string> {
    const absolute = path.resolve(inputPath);
    const missing: string[] = [];
    let current = absolute;

    while (!(await fileExists(current))) {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }

    try {
      return path.join(await fsp.realpath(current), ...missing);
    } catch {
      return absolute;
    }
  }

  private isResolvedPathInsideBase(resolved: string, resolvedBase: string): boolean {
    const fold = (p: string): string => (isCaseInsensitiveFs() ? p.toLowerCase() : p);
    const a = fold(resolved);
    const b = fold(resolvedBase);
    if (a === b) return true;
    return a.length > b.length && a.charAt(b.length) === path.sep && a.startsWith(b);
  }

  isPathInsideBaseDir(targetPath: string, baseDir: string): boolean {
    const resolved = this.resolveRealPath(targetPath);
    const resolvedBase = this.resolveRealPath(baseDir);
    return this.isResolvedPathInsideBase(resolved, resolvedBase);
  }

  /**
   * Canonicalizes a base directory once, for a batch of
   * {@link isPathInsideResolvedBaseDir} checks that would otherwise re-resolve
   * the same directory per candidate.
   *
   * The returned base is a snapshot: replacing the directory afterwards is not
   * noticed until the caller resolves it again, so keep the snapshot to a
   * single batch rather than caching it across operations.
   */
  async resolveBaseDir(baseDir: string): Promise<string> {
    return this.resolveRealPathAsync(baseDir);
  }

  /**
   * {@link isPathInsideBaseDir} against a base already canonicalized by
   * {@link resolveBaseDir}, without blocking the event loop.
   *
   * The target is still canonicalized on every call, so a candidate that
   * reaches outside the base through a symlink is rejected exactly as the
   * synchronous variant rejects it.
   */
  async isPathInsideResolvedBaseDir(targetPath: string, resolvedBaseDir: string): Promise<boolean> {
    const resolved = await this.resolveRealPathAsync(targetPath);
    return this.isResolvedPathInsideBase(resolved, resolvedBaseDir);
  }
}
