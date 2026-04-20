import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

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

  normalizeWorktreePath(worktreePath: string, worktreeBaseDir: string): string {
    const resolved = this.resolveRealPath(worktreePath);
    const resolvedBase = this.resolveRealPath(worktreeBaseDir);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      throw new Error(`Worktree path '${worktreePath}' is outside base directory '${worktreeBaseDir}'`);
    }
    return path.relative(resolvedBase, resolved);
  }

  isPathInsideBaseDir(targetPath: string, baseDir: string): boolean {
    const resolved = this.resolveRealPath(targetPath);
    const resolvedBase = this.resolveRealPath(baseDir);
    return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
  }

  extractBranchFromWorktreePath(worktreePath: string, worktreeBaseDir: string): string {
    return this.normalizeWorktreePath(worktreePath, worktreeBaseDir);
  }
}
