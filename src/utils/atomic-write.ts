import { randomBytes } from "crypto";
import * as fs from "fs/promises";

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let renamed = false;
  try {
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
