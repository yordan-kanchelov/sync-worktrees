/**
 * Extracts the repository name from a Git URL
 * @param gitUrl - The Git URL (HTTPS or SSH format)
 * @returns The repository name without .git extension
 * @throws Error if the URL format is invalid
 */
export function extractRepoNameFromUrl(gitUrl: string): string {
  // Remove trailing spaces
  const url = gitUrl.trim();

  // Handle SSH format: git@github.com:user/repo.git or ssh://git@domain/path/repo.git
  const sshMatch = url.match(/^git@[^:]+:(?:.+\/)?([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // Handle SSH URL format: ssh://git@domain.com/path/repo.git
  const sshUrlMatch = url.match(/^ssh:\/\/[^/]+\/(?:.+\/)?([^/]+?)(?:\.git)?$/);
  if (sshUrlMatch) {
    return sshUrlMatch[1];
  }

  // Handle HTTPS format: https://github.com/user/repo.git
  const httpsMatch = url.match(/^https?:\/\/[^/]+\/(?:.+\/)?([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  // Handle file:// URLs for local repositories
  const fileMatch = url.match(/^file:\/\/(?:.+\/)?([^/]+?)(?:\.git)?$/);
  if (fileMatch) {
    return fileMatch[1];
  }

  throw new Error(`Invalid Git URL format: ${gitUrl}`);
}

/**
 * Generates the default bare repository directory path
 * @param repoUrl - The Git repository URL
 * @param baseDir - The base directory for bare repos (default: .bare)
 * @returns The path to the bare repository
 */
export function getDefaultBareRepoDir(repoUrl: string, baseDir: string = ".bare"): string {
  const repoName = extractRepoNameFromUrl(repoUrl);
  return `${baseDir}/${repoName}`;
}

/**
 * Normalizes a Git remote URL for equivalence comparison only: trims, lowercases
 * a leading `scheme://host`, and strips a trailing slash and a single trailing
 * `.git`. Intentionally does NOT equate scp-style (git@host:path) with https://
 * forms — those are left distinct. Use only to decide whether two URLs point at
 * the same remote, never as a canonical URL for git operations.
 */
export function normalizeRepoUrlForComparison(url: string): string {
  let normalized = url.trim();
  // Only forge-style remotes (http(s)/ssh/git:// and scp git@host:path) treat a
  // trailing ".git" as optional/equivalent. For file:// and bare local paths,
  // "foo.git" and "foo" can be genuinely different directories, so we must NOT
  // strip ".git" there or we'd hide a real origin mismatch.
  const isForgeUrl = /^(https?|ssh|git):\/\//i.test(normalized) || /^[\w.-]+@[^/]+:/.test(normalized);
  normalized = normalized.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/, (prefix) => prefix.toLowerCase());
  normalized = normalized.replace(/\/+$/, "");
  if (isForgeUrl) {
    normalized = normalized.replace(/\.git$/, "");
  }
  return normalized;
}
