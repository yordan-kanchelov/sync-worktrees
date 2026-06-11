import * as fs from "fs/promises";

import { ERROR_MESSAGES } from "../constants";

// Write to temp file then rename for atomicity — prevents corruption on crash.
// Unique suffix avoids collisions between concurrent writers of the same file.
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    // fsync before rename: without it a crash can leave the rename durable
    // but the content not, yielding a valid-looking empty/truncated file.
    const handle = await fs.open(tmpPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmpPath, filePath);
      renamed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === ERROR_MESSAGES.EXDEV) {
        await fs.copyFile(tmpPath, filePath);
      } else {
        throw err;
      }
    }
  } finally {
    if (!renamed) {
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }
}
