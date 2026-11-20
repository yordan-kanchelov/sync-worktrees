import * as fs from "fs/promises";
import * as path from "path";

import { PATH_CONSTANTS } from "../constants";

export async function detachGitLink(dir: string): Promise<void> {
  const link = path.join(dir, PATH_CONSTANTS.GIT_DIR);
  let stat;
  try {
    stat = await fs.lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) return;
  await fs.rename(link, path.join(dir, PATH_CONSTANTS.DETACHED_GIT_LINK));
}

export async function dropDetachedGitLink(dir: string): Promise<void> {
  const detached = path.join(dir, PATH_CONSTANTS.DETACHED_GIT_LINK);
  try {
    if (!(await fs.lstat(detached)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(detached, { force: true });
}
