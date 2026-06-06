import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS } from "../constants";

// Reversible alternative to deletion for directories that may hold user data:
// same-filesystem rename into a sibling .removed/ directory (mirrors .diverged/).
export async function quarantineDirectory(dirPath: string): Promise<string> {
  const baseDir = path.join(path.dirname(dirPath), GIT_CONSTANTS.REMOVED_DIR_NAME);
  await fs.mkdir(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = path.join(baseDir, `${timestamp}-${path.basename(dirPath)}`);
  await fs.rename(dirPath, quarantinePath);
  return quarantinePath;
}
