import { randomBytes } from "crypto";
import * as fs from "fs/promises";

// Write to temp file then rename for atomicity — prevents corruption on crash.
// Random suffix: concurrent writers of one file never share a temp path.
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
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
    await fs.rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }
}
