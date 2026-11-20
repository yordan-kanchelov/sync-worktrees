import * as os from "os";
import * as path from "path";

import { vi } from "vitest";

import type * as FsPromises from "fs/promises";

export async function symlinksSupported(): Promise<boolean> {
  const fs = await vi.importActual<typeof FsPromises>("fs/promises");
  let probeDir: string | null = null;
  try {
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-symlink-probe-"));
    await fs.symlink(path.join("..", "target"), path.join(probeDir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir !== null) await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
