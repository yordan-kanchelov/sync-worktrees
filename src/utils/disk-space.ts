import * as fs from "fs";
import * as path from "path";

/**
 * Recursively calculates the total size of a directory in bytes.
 * @param dirPath - The path to the directory
 * @returns The total size in bytes
 */
export async function calculateDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const stats = await fs.promises.stat(dirPath);

    if (!stats.isDirectory()) {
      return stats.size;
    }

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await calculateDirectorySize(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const fileStats = await fs.promises.stat(fullPath);
          totalSize += fileStats.size;
        } catch {
          // Skip files that can't be read (e.g., broken symlinks)
          continue;
        }
      }
    }
  } catch {
    // If directory doesn't exist or can't be read, return 0
    return 0;
  }

  return totalSize;
}

/**
 * Formats bytes into a human-readable string.
 * @param bytes - The number of bytes
 * @returns Formatted string (e.g., "1.2 GB", "345 MB", "12 KB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const decimals = 2;

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(decimals)} ${units[i]}`;
}

/**
 * Calculates the total disk space used by sync-worktrees repositories.
 * This includes bare repository directories and all worktree directories.
 *
 * @param repoPaths - Array of bare repository directory paths (e.g., from config.bareRepoDir)
 * @param worktreeDirs - Array of worktree base directories
 * @returns Formatted disk space string (e.g., "1.2 GB") or "N/A" if calculation fails
 */
export async function calculateSyncDiskSpace(repoPaths: string[], worktreeDirs: string[]): Promise<string> {
  try {
    let totalBytes = 0;

    // Calculate size of all bare repository directories
    for (const repoPath of repoPaths) {
      const bareSize = await calculateDirectorySize(repoPath);
      totalBytes += bareSize;
    }

    // Calculate size of all worktree directories
    for (const worktreeDir of worktreeDirs) {
      const worktreeSize = await calculateDirectorySize(worktreeDir);
      totalBytes += worktreeSize;
    }

    return formatBytes(totalBytes);
  } catch (error) {
    console.error("Failed to calculate disk space:", error);
    return "N/A";
  }
}
