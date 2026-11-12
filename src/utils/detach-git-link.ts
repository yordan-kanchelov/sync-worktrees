import * as fs from "fs/promises";
import * as path from "path";

import { PATH_CONSTANTS } from "../constants";

// A moved-aside worktree's `.git` file still names `<bare>/worktrees/<name>`,
// which the replacement re-registers: git run inside the copy would act on the
// live branch. Renaming the link cuts that. Only a gitlink file is touched; a
// real `.git` directory is a repository of its own and stays.
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

// Restore re-links the directory itself, so the detached link is dropped.
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
