import * as path from "path";

// darwin/win32 default filesystems (APFS default, HFS+, NTFS) are case-insensitive.
// Case-sensitive APFS volumes on macOS exist but are rare; those will see false-positive
// matches for case-differing paths. Acceptable tradeoff vs breaking the common case.
const CASE_INSENSITIVE_PLATFORMS = new Set(["darwin", "win32"]);

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
