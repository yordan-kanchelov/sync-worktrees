import fastFolderSize from "fast-folder-size";

/**
 * Calculates the total size of a directory in bytes using native OS utilities.
 * Uses the `du` command on Unix systems for optimal performance (10-100x faster than pure Node.js).
 * @param dirPath - The path to the directory
 * @returns The total size in bytes
 */
export async function calculateDirectorySize(dirPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    fastFolderSize(dirPath, (err, bytes) => {
      if (err) {
        reject(err);
        return;
      }
      if (bytes === undefined) {
        reject(new Error(`fast-folder-size returned no bytes for ${dirPath}`));
        return;
      }
      resolve(bytes);
    });
  });
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

    for (const repoPath of repoPaths) {
      try {
        totalBytes += await calculateDirectorySize(repoPath);
      } catch {
        /* skip unreadable bare repo */
      }
    }

    for (const worktreeDir of worktreeDirs) {
      try {
        totalBytes += await calculateDirectorySize(worktreeDir);
      } catch {
        /* skip unreadable worktree dir */
      }
    }

    return formatBytes(totalBytes);
  } catch (error) {
    console.error("Failed to calculate disk space:", error);
    return "N/A";
  }
}
