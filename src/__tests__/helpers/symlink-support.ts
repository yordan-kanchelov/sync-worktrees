import * as os from "os";
import * as path from "path";

import { vi } from "vitest";

import type * as FsPromises from "fs/promises";

/**
 * Whether this host lets the test process create a symlink — on Windows that
 * needs Developer Mode or elevation. A test whose subject is what happens to a
 * link target has nothing to assert without a real link, so it skips instead
 * of standing in a fake one. Goes to the real `fs` deliberately: the callers
 * mock `fs/promises` to varying degrees and the probe must not be one of the
 * things under test.
 */
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
