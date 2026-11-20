import * as fs from "fs/promises";
import * as path from "path";

import { vi } from "vitest";

import type * as FsPromises from "fs/promises";

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
