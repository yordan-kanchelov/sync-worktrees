import * as fsp from "fs/promises";
import * as path from "path";

import { fileExists } from "./file-exists";

const CASE_INSENSITIVE_PLATFORMS = new Set(["darwin"]);

export function isCaseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return CASE_INSENSITIVE_PLATFORMS.has(platform);
}

export function normalizePathForCompare(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(p);
  return isCaseInsensitiveFs(platform) ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizePathForCompare(a, platform) === normalizePathForCompare(b, platform);
}

export function isPathStrictlyInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolvedChild = normalizePathForCompare(child, platform);
  const resolvedParent = normalizePathForCompare(parent, platform);
  if (resolvedChild === resolvedParent) return false;
  const prefix = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep;
  return resolvedChild.startsWith(prefix);
}

export function isPathEqualOrInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathsEqual(child, parent, platform) || isPathStrictlyInside(child, parent, platform);
}

export async function resolveRealPathAsync(inputPath: string): Promise<string> {
  const absolute = path.resolve(inputPath);
  const missing: string[] = [];
  let current = absolute;

  while (!(await fileExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute;
    }
    missing.unshift(path.basename(current));
    current = parent;
  }

  try {
    return path.join(await fsp.realpath(current), ...missing);
  } catch {
    return absolute;
  }
}

export async function sameWorktreePath(a: string, b: string): Promise<boolean> {
  if (pathsEqual(a, b)) return true;
  const [realA, realB] = await Promise.all([resolveRealPathAsync(a), resolveRealPathAsync(b)]);
  return pathsEqual(realA, realB);
}

export async function findByWorktreePath<T extends { path: string }>(
  entries: readonly T[],
  target: string,
): Promise<T | undefined> {
  const lexical = entries.find((entry) => pathsEqual(entry.path, target));
  if (lexical || entries.length === 0) return lexical;
  const realTarget = await resolveRealPathAsync(target);
  const realPaths = await Promise.all(entries.map((entry) => resolveRealPathAsync(entry.path)));
  const index = realPaths.findIndex((real) => pathsEqual(real, realTarget));
  return index === -1 ? undefined : entries[index];
}
