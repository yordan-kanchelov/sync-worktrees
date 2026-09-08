import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import { fileExists } from "../utils/file-exists";
import { isCaseInsensitiveFs } from "../utils/path-compare";

const BRANCH_STEM_MAX = 80;
const BRANCH_HASH_LEN = 8;

export class PathResolutionService {
  sanitizeBranchName(branchName: string): string {
    const stem = branchName
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, BRANCH_STEM_MAX);
    const hash = createHash("sha256").update(branchName).digest("hex").slice(0, BRANCH_HASH_LEN);
    return `${stem}-${hash}`;
  }

  getBranchWorktreePath(worktreeDir: string, branchName: string): string {
    return path.join(worktreeDir, this.sanitizeBranchName(branchName));
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
