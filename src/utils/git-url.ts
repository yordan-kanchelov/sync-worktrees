import * as path from "path";

// `repoName` is `null` when the URL is a remote git can dial but carries no path
// segment to name a directory after: `https://git.example.com`, a repository
// served at a web root. It comes out as the empty string in one other case — a
// local path whose basename is `.git`, as in `/srv/project/.git` — which has
// always produced an empty name and so an on-disk `.bare/`. That is left as it
// is rather than "fixed", because changing it would move an existing user's
// bare repository and force a re-clone. Prose that explains rather than
// specifies is kept out of JSDoc throughout this file: tsc copies JSDoc on an
// exported declaration into dist/utils/git-url.d.ts, which ships in the tarball,
// whereas a `//` comment reaches neither the declarations nor the esbuild
// bundles (which strip the statement-level and JSDoc comments this file has;
// comments inside object and array literals do survive into them).
/**
 * A Git URL that {@link parseGitUrl} recognised, and which of git's three
 * remote syntaxes it is written in.
 */
export interface ParsedGitUrl {
  kind: "local" | "scheme" | "scp";
  /**
   * The final path segment with one trailing `.git` removed, or `null` when the
   * URL has no path segment to take a name from.
   */
  repoName: string | null;
}

// Schemes git speaks that this tool also understands. Compared lowercased,
// because RFC 3986 scheme names are case-insensitive and git accepts
// `HTTPS://host/path`. `git+ssh://` and `ftp://` are deliberately absent: they
// were refused before this grammar existed and nothing asked for them.
const GIT_URL_SCHEMES = new Set(["http", "https", "ssh", "git", "file"]);
// Of those, the ones whose authority alone is already a location a repository
// can be served from: `git clone https://git.example.com` clones a repository
// published at a web root, so a path-less http(s) URL is a remote, just not one
// a directory can be named after. No other scheme works that way — git answers
// `fatal: no path specified` for `ssh://git@host`, `git://host` and `file://`,
// and over ssh or the git daemon a path of `/` is not a repository either — so
// for those, no path segment means no remote at all.
const WEB_ROOT_SCHEMES = new Set(["http", "https"]);
// `scheme://rest`. Scheme spelling is RFC 3986's. `.` rather than `[\s\S]`, so
// a URL carrying an embedded newline or carriage return is refused. That is a
// change, not a preservation: the extractor's old `[^/]+?` matched one and
// named a directory `re\npo` after it. git itself warns "url contains a newline
// in its path component" on such a remote, so nothing working is being lost.
const SCHEME_URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/;
// git's scp-like shorthand, `user@host:path`. The host alternative accepts a
// bracketed IPv6 literal (`git@[2001:db8::1]:org/repo.git`), which git takes
// and which this tool has always extracted a name from.
const SCP_URL_PATTERN = /^[\w.-]+@(?:\[[^\]/@]+\]|[^/:@]+):(.+)$/;
// An absolute filesystem path: POSIX, or a Windows drive letter with a
// backslash. `C:/repos/r` is intentionally not included — it was refused by
// both the validator and the extractor before, and widening to it was not
// asked for here.
const LOCAL_PATH_PATTERN = /^(?:\/|[A-Za-z]:\\)/;

/** `repo.git` -> `repo`. A segment that is exactly `.git` is kept whole rather than emptied. */
function repoNameFromSegment(segment: string): string | null {
  if (!segment) return null;
  return segment.replace(/\.git$/, "") || segment;
}

/** Last `/`-separated segment of a URL or scp path, trailing slashes ignored. */
function repoNameFromUrlPath(urlPath: string): string | null {
  const withoutTrailingSlashes = urlPath.replace(/\/+$/, "");
  return repoNameFromSegment(withoutTrailingSlashes.slice(withoutTrailingSlashes.lastIndexOf("/") + 1));
}

function repoNameFromLocalPath(localPath: string): string | null {
  const trimmedPath = localPath.replace(/[\\/]+$/, "");
  const base = /^[A-Za-z]:\\/.test(trimmedPath) ? path.win32.basename(trimmedPath) : path.basename(trimmedPath);
  if (!base) return null;
  // Not repoNameFromSegment: see ParsedGitUrl.repoName for why `.git` alone
  // must keep emptying here even though it does not for a URL segment.
  return base.replace(/\.git$/, "");
}

// The two callers had drifted: validation lived in the config loader as its own
// set of regexes, which blessed `https://host/org/repo.git/` (copied with a
// trailing slash) and `git://host/repo.git`, and then — with no explicit
// `bareRepoDir` — the run died in getDefaultBareRepoDir with "Invalid Git URL
// format", contradicting the validation that had just passed. The converse held
// too: `deploy@host:org/repo.git`, ordinary on self-hosted Gitea and Gerrit, was
// refused although git takes it.
//
// How the three syntaxes are told apart, in the order they are tried:
//  - `local` — starts with `/` or a Windows drive (`C:\`). Neither can begin a
//    `scheme://` URL, and neither carries the `@` the scp form requires.
//  - `scheme` — recognised by `://`, so an `ssh://git@host/path` URL is read
//    here and never re-read as the scp form below.
//  - `scp` — `user@host:path`. The `user@` is required precisely so that a
//    Windows path cannot be mistaken for it: `C:\repos\r` and `C:/repos/r` have
//    no `@`, so nothing but the local branch can claim them. `user` and `host`
//    also exclude `/` and `:`, which is the second, independent reason an
//    `ssh://` URL cannot match this pattern.
//
// Two questions are answered separately, because conflating them is what turned
// this fix into a regression on its first cut. "Can git dial this?" is what a
// null return answers, and it is all the loader's repoUrl check needs. "Can a
// directory be named after it?" is a second question, and only an entry with no
// explicit `bareRepoDir` has to ask it — so a path-less `https://git.example.com`,
// a repository served at a web root, parses with `repoName: null` instead of
// being refused outright. Refusing it would have hard-blocked a configuration
// that loads and clones today, with no other spelling of the same URL to move
// to; `ssh://git@host`, `git://host` and `file://` are refused, because git
// cannot dial those at all.
//
// Surrounding whitespace is refused rather than trimmed away, because a
// `repoUrl` in a config file must be the exact string git is handed: accepting
// `"https://host/org/repo.git "` would derive the name from the trimmed URL and
// then pass the padded one to git. Refusing it is also what keeps the two
// callers in step — extractRepoNameFromUrl trims before calling in (the init
// wizard feeds it raw keystrokes), so anything that validates is already trimmed
// and both see the identical string. Without this guard `git://host/ ` validates,
// since its path is a one-space segment, and then has no name left once trimmed:
// the exact failure this grammar exists to make impossible. Leading whitespace
// has to be refused for the same reason and was already refused by the loader's
// old anchored regexes, so both ends are pinned by tests.
/**
 * The one Git URL grammar. {@link isValidGitUrl} and
 * {@link extractRepoNameFromUrl} are both built on it, so the two cannot drift
 * apart: everything the config loader accepts either yields a `repoName` here
 * or is a URL the loader knows needs an explicit `bareRepoDir`. Surrounding
 * whitespace is refused rather than trimmed.
 *
 * @returns the parse, or `null` if the URL is not one this tool recognises.
 */
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
    // `file://` has an empty authority in practice (`file:///srv/git/r.git`)
    // and git also takes `file://host/path`; either way the repository is the
    // last path segment, so the whole remainder is the path.
    if (scheme === "file") {
      const repoName = repoNameFromUrlPath(rest);
      return repoName === null ? null : { kind: "scheme", repoName };
    }
    // Every other scheme needs a non-empty authority, which is what refuses
    // `https://` and `https:///acme/repo.git`. A path after it is required too,
    // except for the schemes whose authority is itself a place a repository can
    // live: those parse with no name rather than failing to parse.
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

/**
 * Whether `url` is a Git remote this tool can use. The config loader's
 * `repoUrl` check; see {@link parseGitUrl} for the grammar, which is the same
 * one {@link extractRepoNameFromUrl} reads.
 */
export function isValidGitUrl(url: string): boolean {
  return parseGitUrl(url) !== null;
}

// This is the "derive a name" entry point, so it throws for both ways that can
// fail — a URL the grammar does not recognise, and one it does recognise but
// that carries no path segment. The two get different messages, because telling
// someone `https://git.example.com` is malformed would be wrong: it is a remote
// git clones, and what it needs is an explicit `bareRepoDir`.
/**
 * Extracts the repository name from a Git URL
 * @param gitUrl - The Git URL (HTTPS, SSH, git://, scp-style or a local path)
 * @returns The repository name without .git extension
 * @throws Error if the URL is not a Git URL, or has no repository path segment
 */
export function extractRepoNameFromUrl(gitUrl: string): string {
  // Trimmed, unlike isValidGitUrl: the init wizard calls this with whatever
  // was typed, before its own answer is trimmed and stored.
  const parsed = parseGitUrl(gitUrl.trim());
  if (!parsed) {
    throw new Error(`Invalid Git URL format: ${redactSecretsInText(gitUrl)}`);
  }
  if (parsed.repoName === null) {
    throw new Error(`Git URL has no repository path segment to name a directory after: ${redactSecretsInText(gitUrl)}`);
  }
  return parsed.repoName;
}

// `scheme://userinfo@` — the userinfo part of an RFC 3986 URL. Only the
// prefix is matched, so the host (IPv6 literals and ports included) and the
// path are left as they are. Userinfo cannot contain `/`, `@` or whitespace,
// which is what keeps a match from running past its own URL.
// The lookbehind anchors the scheme so long runs of scheme characters without "://" stay linear.
const URL_USERINFO_PATTERN = /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]+)@/g;
const REDACTED_USERINFO = "***";

/**
 * Strips the credentials from a repository URL for display. `https://user:token@host/repo.git`
 * becomes `https://***@host/repo.git`; a bare username is redacted too because
 * forges accept access tokens in the username position. scp-style remotes
 * (`git@host:path`) and local paths carry no secret and are returned unchanged.
 * Never feed the result to git — it is for logs, messages and API responses only.
 */
export function redactRepoUrl(url: string): string {
  return url.replace(/^(\s*[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]+)@/, `$1${REDACTED_USERINFO}@`);
}

/**
 * The label a repository is shown under: its configured `name`, or — for a
 * repository configured without one — its URL with the credentials redacted.
 * Every log line, progress row and message that names a repository takes its
 * label from here; a raw `repoUrl` fallback is refused by the lint config.
 */
export function repoDisplayLabel(repo: { name?: string; repoUrl: string }): string {
  return repo.name || redactRepoUrl(repo.repoUrl);
}

/**
 * Scrubs every `scheme://userinfo@` occurrence inside free text (git's own
 * error output, log lines, messages that embed one or more URLs), so a
 * credential-bearing remote URL never reaches a terminal or an API client.
 * Text without such URLs is returned unchanged.
 */
export function redactSecretsInText(text: string): string {
  return text.replace(URL_USERINFO_PATTERN, `$1${REDACTED_USERINFO}@`);
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

// Deliberately not routed through parseGitUrl: this answers "are these the same
// remote", not "is this a remote", and it must keep answering for strings the
// grammar rejects — a `git remote get-url` reading `origin` can return anything
// git accepted at clone time. Its forge test already covers every shape the
// grammar now accepts, `git://` and `user@host:path` included.
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
