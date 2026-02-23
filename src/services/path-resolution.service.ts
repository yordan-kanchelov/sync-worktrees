import * as fs from "fs";
import * as path from "path";

export class PathResolutionService {
  sanitizeBranchName(branchName: string): string {
    return branchName.replace(/\//g, "-").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  normalizeWorktreePath(worktreePath: string, worktreeBaseDir: string): string {
    const resolved = path.resolve(worktreePath);
    const resolvedBase = path.resolve(worktreeBaseDir);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      throw new Error(`Worktree path '${worktreePath}' is outside base directory '${worktreeBaseDir}'`);
    }
    return path.relative(resolvedBase, resolved);
  }

  isPathInsideBaseDir(targetPath: string, baseDir: string): boolean {
    let resolved: string;
    let resolvedBase: string;

    try {
      // Use realpath to resolve symlinks for accurate security checks
      resolved = fs.realpathSync(targetPath);
      resolvedBase = fs.realpathSync(baseDir);
    } catch {
      // If paths don't exist yet, fall back to path.resolve
      resolved = path.resolve(targetPath);
      resolvedBase = path.resolve(baseDir);
    }

    return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
  }

  extractBranchFromWorktreePath(worktreePath: string, worktreeBaseDir: string): string {
    return this.normalizeWorktreePath(worktreePath, worktreeBaseDir);
  }
}
