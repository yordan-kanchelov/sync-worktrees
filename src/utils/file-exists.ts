import * as fs from "fs/promises";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export type PathProbeResult = "exists" | "missing" | "unknown";

// Removal decisions must distinguish "path is gone" from "probe failed"
// (EMFILE/EINTR under load): an unverifiable path must never read as deleted.
export async function probePathExists(path: string): Promise<PathProbeResult> {
  try {
    await fs.access(path);
    return "exists";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}
