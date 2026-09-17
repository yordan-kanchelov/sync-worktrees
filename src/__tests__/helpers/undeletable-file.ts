import * as fs from "fs/promises";
import * as path from "path";

import { vi } from "vitest";

import type * as FsPromises from "fs/promises";

/**
 * Replaces `fs.rm` with one file this process cannot unlink — build output
 * owned by another uid (a root-written bind mount), a file carrying the
 * immutable attribute, an EPERM from an overlay or FUSE mount. Every other
 * path still goes to the real `fs.rm`.
 *
 * The point of the fake is the blast radius, so it reproduces it faithfully:
 * Node's recursive rm is not a transaction. It walks the target in readdir
 * order, and everything it removed before it rejects stays removed. So every
 * child of the target that does not lead to `fileName` is really deleted, and
 * only then does the call reject with the EPERM the real one raises. A delete
 * aimed at a directory holding both the survivor and `manifest.json` therefore
 * takes the manifest with it, exactly as the real one does.
 *
 * Requires the test file to install a partial module mock, since an ESM
 * namespace export cannot be spied on:
 *
 * ```ts
 * import type * as FsPromises from "fs/promises";
 *
 * vi.mock("fs/promises", async (importOriginal) => {
 *   const actual = await importOriginal<typeof FsPromises>();
 *   return { ...actual, default: actual, rm: vi.fn(actual.rm) };
 * });
 * ```
 *
 * {@link allowDeletion} models the user fixing the file.
 */
export async function mockUndeletableFile(fileName: string): Promise<void> {
  const realRm = (await vi.importActual<typeof FsPromises>("fs/promises")).rm;
  vi.mocked(fs.rm).mockImplementation((async (target: string, options: Parameters<typeof fs.rm>[1]) => {
    const targetPath = String(target);
    const survivor = await findUnder(targetPath, fileName);
    if (survivor === null) return realRm(target, options);

    for (const child of await fs.readdir(targetPath)) {
      const childPath = path.join(targetPath, child);
      if (survivor === childPath || survivor.startsWith(childPath + path.sep)) continue;
      await realRm(childPath, { recursive: true, force: true });
    }
    throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${survivor}'`), {
      code: "EPERM",
      path: survivor,
    });
  }) as unknown as typeof fs.rm);
}

/** Hands `fs.rm` back to the real one. */
export function allowDeletion(): void {
  vi.mocked(fs.rm).mockReset();
}

async function findUnder(dir: string, fileName: string): Promise<string | null> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirent of dirents) {
    const child = path.join(dir, dirent.name);
    if (dirent.name === fileName) return child;
    if (dirent.isDirectory()) {
      const found = await findUnder(child, fileName);
      if (found !== null) return found;
    }
  }
  return null;
}
