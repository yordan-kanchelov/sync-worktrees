import * as path from "path";

export class PathResolutionService {
  sanitizeBranchName(branchName: string): string {
    return branchName.replace(/\//g, "-").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  normalizeWorktreePath(worktreePath: string, worktreeBaseDir: string): string {
    const relativePath = path.relative(worktreeBaseDir, worktreePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Worktree path '${worktreePath}' is outside base directory '${worktreeBaseDir}'`);
    }
    return relativePath;
  }

  isPathInsideBaseDir(targetPath: string, baseDir: string): boolean {
    const relative = path.relative(baseDir, targetPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  extractBranchFromWorktreePath(worktreePath: string, worktreeBaseDir: string): string {
    return this.normalizeWorktreePath(worktreePath, worktreeBaseDir);
  }
}
