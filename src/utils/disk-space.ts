import { execFile } from "child_process";

export async function calculateDirectorySize(dirPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("du", ["-sk", "-H", "--", dirPath], (err, stdout) => {
      const match = /^(\d+)\s/.exec(stdout);
      if (err && !(err.code === 1 && match)) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- ExecFileException is an Error at runtime; its Omit<> type hides the Error base
        reject(err);
        return;
      }
      if (!match) {
        reject(new Error(`du printed no size for ${dirPath}: ${JSON.stringify(stdout)}`));
        return;
      }
      resolve(Number(match[1]) * 1024);
    });
  });
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const decimals = 2;

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(decimals)} ${units[i]}`;
}

export async function calculateSyncDiskSpace(
  repoPaths: string[],
  worktreeDirs: string[],
  measure: (dirPath: string) => Promise<number> = calculateDirectorySize,
): Promise<string> {
  const sizes = await Promise.all([...repoPaths, ...worktreeDirs].map((dirPath) => measure(dirPath).catch(() => 0)));

  return formatBytes(sizes.reduce((total, bytes) => total + bytes, 0));
}
