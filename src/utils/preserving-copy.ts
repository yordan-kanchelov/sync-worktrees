import * as fs from "fs/promises";

import type { CopyOptions } from "fs";

export async function copyTreePreservingSymlinks(
  source: string,
  destination: string,
  options: Pick<CopyOptions, "force" | "filter"> = {},
): Promise<void> {
  await fs.cp(source, destination, { ...options, recursive: true, verbatimSymlinks: true });
}
