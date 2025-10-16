import * as path from "path";

export class PathResolutionService {
  toAbsolute(inputPath: string): string {
    return path.resolve(inputPath);
  }

  toAbsoluteFrom(inputPath: string, basePath: string): string {
    if (path.isAbsolute(inputPath)) {
      return inputPath;
    }
    return path.resolve(basePath, inputPath);
  }

  isAbsolute(inputPath: string): boolean {
    return path.isAbsolute(inputPath);
  }

  sanitizeBranchName(branchName: string): string {
    return branchName.replace(/\//g, "-").replace(/[^a-zA-Z0-9-_]/g, "_");
  }

  getBranchWorktreePath(worktreeBaseDir: string, branchName: string): string {
    return path.join(worktreeBaseDir, branchName);
  }

  getParentDirectory(inputPath: string): string {
    return path.dirname(inputPath);
  }

  joinPaths(...paths: string[]): string {
    return path.join(...paths);
  }

  getRelativePath(from: string, to: string): string {
    return path.relative(from, to);
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
