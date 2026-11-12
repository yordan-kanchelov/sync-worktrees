import * as fsp from "fs/promises";
import * as path from "path";

import { fileExists } from "./file-exists";

// darwin default filesystem (APFS default, HFS+) is case-insensitive.
// Case-sensitive APFS volumes on macOS exist but are rare; those will see false-positive
// matches for case-differing paths. Acceptable tradeoff vs breaking the common case.
const CASE_INSENSITIVE_PLATFORMS = new Set(["darwin"]);

export function isCaseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return CASE_INSENSITIVE_PLATFORMS.has(platform);
}

/**
 * Normalizes a path for equality comparison.
 *
 * The `platform` argument is a case-sensitivity hint only: it controls whether
 * the resolved path is lower-cased before comparison.
 */
export function normalizePathForCompare(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(p);
  return isCaseInsensitiveFs(platform) ? resolved.toLowerCase() : resolved;
}

/**
 * Compares two paths for equality after host-path resolution and platform-aware case folding.
 *
 * The `platform` argument is a case-sensitivity hint only. See
 * {@link normalizePathForCompare} for the caveats about path.resolve semantics.
 */
export function pathsEqual(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizePathForCompare(a, platform) === normalizePathForCompare(b, platform);
}

/**
 * True when `child` resolves to a path strictly inside `parent`, on a path
 * segment boundary: `/x/inner` is inside `/x`, but `/xy` is not, and a path is
 * never inside itself. Uses {@link normalizePathForCompare} semantics.
 */
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

/**
 * True when `child` is the same path as `parent` or strictly inside it.
 */
export function isPathEqualOrInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathsEqual(child, parent, platform) || isPathStrictlyInside(child, parent, platform);
}

// realpath of the deepest existing ancestor, with the missing tail re-joined;
// the lexical path when nothing exists or realpath throws. `fileExists`, like
// `existsSync`, reads any access error as "not there".
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

// git lists worktrees by canonical path, so a configured path that runs
// through a symlink (all of /tmp on macOS) never matches it lexically.
export async function sameWorktreePath(a: string, b: string): Promise<boolean> {
  if (pathsEqual(a, b)) return true;
  const [realA, realB] = await Promise.all([resolveRealPathAsync(a), resolveRealPathAsync(b)]);
  return pathsEqual(realA, realB);
}

// The entry whose path is `target`, compared as sameWorktreePath does.
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
