import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { isCaseInsensitiveFs, resolveRealPathAsync } from "../utils/path-compare";

const BRANCH_STEM_MAX = 80;
const BRANCH_HASH_LEN = 8;
const NAME_PROBE_CONCURRENCY = 16;

const PLAIN_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const RESERVED_WORKTREE_DIR_NAMES: readonly string[] = [
  GIT_CONSTANTS.BARE_DIR_NAME,
  GIT_CONSTANTS.DIVERGED_DIR_NAME,
  GIT_CONSTANTS.REMOVED_DIR_NAME,
  GIT_CONSTANTS.TRASH_DIR_NAME,
  PATH_CONSTANTS.GIT_DIR,
  PATH_CONSTANTS.STATE_DIR_NAME,
  PATH_CONSTANTS.LOCK_DIR_NAME,
];

export interface WorktreeNamingContext {
  readonly claimants: ReadonlyMap<string, ReadonlySet<string>>;
  readonly taken: ReadonlyMap<string, string | null>;
}

export interface WorktreeNamingInput {
  branches: Iterable<string>;
  defaultBranch?: string;
  worktrees?: Iterable<{ path: string; branch: string }>;
  taken?: Iterable<readonly [string, string | null]>;
}

export interface WorktreeNamingDisk {
  worktreeDir: string;
  bareRepoPath: string;
  readMetadataOwner: (name: string) => Promise<string | null>;
}

export function foldWorktreeDirName(name: string): string {
  return name.toLowerCase();
}

function claimName(taken: Map<string, string | null>, name: string, owner: string | null): void {
  const key = foldWorktreeDirName(name);
  taken.set(key, taken.has(key) && taken.get(key) !== owner ? null : owner);
}

export class PathResolutionService {
  sanitizeBranchName(branchName: string): string {
    const stem = branchName
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, BRANCH_STEM_MAX);
    const hash = createHash("sha256").update(branchName).digest("hex").slice(0, BRANCH_HASH_LEN);
    return `${stem}-${hash}`;
  }

  plainBranchName(branchName: string): string | null {
    if (!PLAIN_BRANCH_RE.test(branchName)) return null;
    const name = branchName.replace(/\//g, "-");
    if (name.length > BRANCH_STEM_MAX) return null;
    if (/^[.-]/.test(name) || name.endsWith(".")) return null;
    if (WINDOWS_DEVICE_RE.test(name)) return null;
    return name;
  }

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

  getBranchWorktreePath(worktreeDir: string, branchName: string, context?: WorktreeNamingContext): string {
    return path.join(worktreeDir, this.branchDirectoryName(branchName, context));
  }

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

  async createProbedNamingContext(
    input: {
      branches: readonly string[];
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

  async resolveBaseDir(baseDir: string): Promise<string> {
    return resolveRealPathAsync(baseDir);
  }

  async isPathInsideResolvedBaseDir(targetPath: string, resolvedBaseDir: string): Promise<boolean> {
    const resolved = await resolveRealPathAsync(targetPath);
    return this.isResolvedPathInsideBase(resolved, resolvedBaseDir);
  }
}
