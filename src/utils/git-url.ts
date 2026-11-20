import * as path from "path";

export interface ParsedGitUrl {
  kind: "local" | "scheme" | "scp";
  repoName: string | null;
}

const GIT_URL_SCHEMES = new Set(["http", "https", "ssh", "git", "file"]);
const WEB_ROOT_SCHEMES = new Set(["http", "https"]);
const SCHEME_URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/;
const SCP_URL_PATTERN = /^[\w.-]+@(?:\[[^\]/@]+\]|[^/:@]+):(.+)$/;
const LOCAL_PATH_PATTERN = /^(?:\/|[A-Za-z]:\\)/;

function repoNameFromSegment(segment: string): string | null {
  if (!segment) return null;
  return segment.replace(/\.git$/, "") || segment;
}

function repoNameFromUrlPath(urlPath: string): string | null {
  const withoutTrailingSlashes = urlPath.replace(/\/+$/, "");
  return repoNameFromSegment(withoutTrailingSlashes.slice(withoutTrailingSlashes.lastIndexOf("/") + 1));
}

function repoNameFromLocalPath(localPath: string): string | null {
  const trimmedPath = localPath.replace(/[\\/]+$/, "");
  const base = /^[A-Za-z]:\\/.test(trimmedPath) ? path.win32.basename(trimmedPath) : path.basename(trimmedPath);
  if (!base) return null;
  return base.replace(/\.git$/, "");
}

export function parseGitUrl(url: string): ParsedGitUrl | null {
  if (/^\s|\s$/.test(url)) return null;

  if (LOCAL_PATH_PATTERN.test(url)) {
    const repoName = repoNameFromLocalPath(url);
    return repoName === null ? null : { kind: "local", repoName };
  }

  const schemeMatch = SCHEME_URL_PATTERN.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!GIT_URL_SCHEMES.has(scheme)) return null;
    const rest = schemeMatch[2];
    if (scheme === "file") {
      const repoName = repoNameFromUrlPath(rest);
      return repoName === null ? null : { kind: "scheme", repoName };
    }
    const slash = rest.indexOf("/");
    if (!(slash < 0 ? rest : rest.slice(0, slash))) return null;
    const repoName = slash < 0 ? null : repoNameFromUrlPath(rest.slice(slash + 1));
    if (repoName === null && !WEB_ROOT_SCHEMES.has(scheme)) return null;
    return { kind: "scheme", repoName };
  }

  const scpMatch = SCP_URL_PATTERN.exec(url);
  if (scpMatch) {
    const repoName = repoNameFromUrlPath(scpMatch[1]);
    return repoName === null ? null : { kind: "scp", repoName };
  }

  return null;
}

export function isValidGitUrl(url: string): boolean {
  return parseGitUrl(url) !== null;
}

export function extractRepoNameFromUrl(gitUrl: string): string {
  const parsed = parseGitUrl(gitUrl.trim());
  if (!parsed) {
    throw new Error(`Invalid Git URL format: ${redactSecretsInText(gitUrl)}`);
  }
  if (parsed.repoName === null) {
    throw new Error(`Git URL has no repository path segment to name a directory after: ${redactSecretsInText(gitUrl)}`);
  }
  return parsed.repoName;
}

const URL_USERINFO_PATTERN = /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]+)@/g;
const REDACTED_USERINFO = "***";

export function redactRepoUrl(url: string): string {
  return url.replace(/^(\s*[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]+)@/, `$1${REDACTED_USERINFO}@`);
}

export function repoDisplayLabel(repo: { name?: string; repoUrl: string }): string {
  return repo.name || redactRepoUrl(repo.repoUrl);
}

export function redactSecretsInText(text: string): string {
  return text.replace(URL_USERINFO_PATTERN, `$1${REDACTED_USERINFO}@`);
}

export function getDefaultBareRepoDir(repoUrl: string, baseDir: string = ".bare"): string {
  const repoName = extractRepoNameFromUrl(repoUrl);
  return `${baseDir}/${repoName}`;
}

export function normalizeRepoUrlForComparison(url: string): string {
  let normalized = url.trim();
  const isForgeUrl = /^(https?|ssh|git):\/\//i.test(normalized) || /^[\w.-]+@[^/]+:/.test(normalized);
  normalized = normalized.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/, (prefix) => prefix.toLowerCase());
  normalized = normalized.replace(/\/+$/, "");
  if (isForgeUrl) {
    normalized = normalized.replace(/\.git$/, "");
  }
  return normalized;
}
