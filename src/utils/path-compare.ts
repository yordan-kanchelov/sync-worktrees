import * as path from "path";

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
