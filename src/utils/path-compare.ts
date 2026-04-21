import * as path from "path";

// darwin/win32 default filesystems (APFS default, HFS+, NTFS) are case-insensitive.
// Case-sensitive APFS volumes on macOS exist but are rare; those will see false-positive
// matches for case-differing paths. Acceptable tradeoff vs breaking the common case.
const CASE_INSENSITIVE_PLATFORMS = new Set(["darwin", "win32"]);

export function isCaseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return CASE_INSENSITIVE_PLATFORMS.has(platform);
}

/**
 * Normalizes a path for equality comparison.
 *
 * The `platform` argument is a case-sensitivity hint only: it controls whether
 * the resolved path is lower-cased before comparison. It does NOT emulate
 * path parsing or resolution for that platform — `path.resolve` uses Node's
 * host `path` module (POSIX on darwin/linux, Windows on win32) regardless.
 * For genuine cross-platform path parsing emulation, resolve inputs with
 * `path.posix` / `path.win32` before calling this function.
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
