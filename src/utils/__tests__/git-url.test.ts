import { describe, expect, it } from "vitest";

import {
  extractRepoNameFromUrl,
  getDefaultBareRepoDir,
  isValidGitUrl,
  normalizeRepoUrlForComparison,
  parseGitUrl,
  redactRepoUrl,
  redactSecretsInText,
} from "../git-url";

import type { ParsedGitUrl } from "../git-url";

describe("git-url utilities", () => {
  describe("extractRepoNameFromUrl", () => {
    it("should extract repo name from HTTPS URL with .git", () => {
      expect(extractRepoNameFromUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
    });

    it("should extract repo name from HTTPS URL without .git", () => {
      expect(extractRepoNameFromUrl("https://github.com/user/my-repo")).toBe("my-repo");
    });

    it("should extract repo name from SSH URL with .git", () => {
      expect(extractRepoNameFromUrl("git@github.com:user/my-repo.git")).toBe("my-repo");
    });

    it("should extract repo name from SSH URL without .git", () => {
      expect(extractRepoNameFromUrl("git@github.com:user/my-repo")).toBe("my-repo");
    });

    it("should handle URLs with multiple path segments", () => {
      expect(extractRepoNameFromUrl("https://gitlab.com/group/subgroup/project.git")).toBe("project");
      expect(extractRepoNameFromUrl("git@gitlab.com:group/subgroup/project.git")).toBe("project");
    });

    it("should handle file:// URLs", () => {
      expect(extractRepoNameFromUrl("file:///home/user/repos/my-project.git")).toBe("my-project");
      expect(extractRepoNameFromUrl("file:///home/user/repos/my-project")).toBe("my-project");
    });

    it("should handle absolute local paths", () => {
      expect(extractRepoNameFromUrl("/srv/git/repo.git")).toBe("repo");
      expect(extractRepoNameFromUrl("/srv/git/repo.git/")).toBe("repo");
      expect(extractRepoNameFromUrl("C:\\srv\\git\\repo.git\\")).toBe("repo");
    });

    it("should handle URLs with different domains", () => {
      expect(extractRepoNameFromUrl("https://bitbucket.org/user/repo.git")).toBe("repo");
      expect(extractRepoNameFromUrl("git@bitbucket.org:user/repo.git")).toBe("repo");
    });

    it("should handle SSH URL format (ssh://)", () => {
      expect(extractRepoNameFromUrl("ssh://git@github.com/user/my-repo.git")).toBe("my-repo");
      expect(extractRepoNameFromUrl("ssh://git@github.com/user/my-repo")).toBe("my-repo");
      expect(extractRepoNameFromUrl("ssh://git@bitbucket.tech.amusnet.io/lc/live-casino-monorepo.git")).toBe(
        "live-casino-monorepo",
      );
      expect(extractRepoNameFromUrl("ssh://git@gitlab.com/group/subgroup/project.git")).toBe("project");
    });

    it("should trim whitespace", () => {
      expect(extractRepoNameFromUrl("  https://github.com/user/repo.git  ")).toBe("repo");
    });

    it("should throw error for invalid URLs", () => {
      expect(() => extractRepoNameFromUrl("not-a-url")).toThrow("Invalid Git URL format");
      expect(() => extractRepoNameFromUrl("")).toThrow("Invalid Git URL format");
      expect(() => extractRepoNameFromUrl("relative/path")).toThrow("Invalid Git URL format");
    });
  });

  // The validator (which the config loader calls on every `repoUrl`) and the
  // extractor (which names `.bare/<repo>`) used to be two independent sets of
  // regexes. They disagreed: `https://host/org/repo.git/` and
  // `git://host/repo.git` validated and then died in getDefaultBareRepoDir with
  // "Invalid Git URL format", contradicting the validation that had just
  // passed, while `deploy@host:org/repo.git` was refused although git takes it.
  // Both now answer from parseGitUrl, and these tests hold that shut.
  describe("one grammar for isValidGitUrl and extractRepoNameFromUrl", () => {
    // [url, extracted name, which syntax it is]. Every branch of the grammar
    // is reached by at least one row.
    const ACCEPTED: Array<[string, string, ParsedGitUrl["kind"]]> = [
      // https, the shapes that already worked
      ["https://github.com/acme/repo.git", "repo", "scheme"],
      ["https://github.com/acme/repo", "repo", "scheme"],
      ["http://git.example.com/acme/repo.git", "repo", "scheme"],
      ["https://git.example.com:8443/acme/repo.git", "repo", "scheme"],
      ["https://ci-bot:s3cr3t-token@github.com/acme/repo.git", "repo", "scheme"],
      ["https://git.example.com/repo.git", "repo", "scheme"],
      ["https://gitlab.com/group/subgroup/repo.git", "repo", "scheme"],
      // https with the trailing slash a copy-paste from a browser leaves behind
      ["https://github.com/acme/repo.git/", "repo", "scheme"],
      ["https://github.com/acme/repo/", "repo", "scheme"],
      ["https://github.com/acme/repo.git//", "repo", "scheme"],
      // git://, which had no branch in the extractor at all
      ["git://git.example.com/repo.git", "repo", "scheme"],
      ["git://git.example.com/acme/repo.git", "repo", "scheme"],
      ["git://git.example.com:9418/acme/repo.git", "repo", "scheme"],
      ["git://git.example.com/acme/repo.git/", "repo", "scheme"],
      // ssh://
      ["ssh://git@github.com/acme/repo.git", "repo", "scheme"],
      ["ssh://git@git.example.com:2222/acme/repo.git", "repo", "scheme"],
      ["ssh://git@github.com/acme/repo.git/", "repo", "scheme"],
      ["ssh://git.example.com/acme/repo.git", "repo", "scheme"],
      // RFC 3986 makes the scheme case-insensitive and git agrees
      ["GIT://git.example.com/acme/repo.git", "repo", "scheme"],
      ["HTTPS://github.com/acme/repo.git", "repo", "scheme"],
      // scp form: the classic, and the non-`git` user self-hosted forges use
      ["git@github.com:acme/repo.git", "repo", "scp"],
      ["git@github.com:acme/repo", "repo", "scp"],
      ["git@gitlab.com:group/subgroup/repo.git", "repo", "scp"],
      ["deploy@git.example.com:team/repo.git", "repo", "scp"],
      ["build-bot@gerrit.example.com:repo.git", "repo", "scp"],
      ["my.user@gitea.example.com:team/repo.git", "repo", "scp"],
      ["git@github.com:acme/repo.git/", "repo", "scp"],
      ["git@github.com:/srv/git/repo.git", "repo", "scp"],
      ["git@github.com:~acme/repo.git", "repo", "scp"],
      // git's bracketed IPv6 literal, which only the scp form spells this way.
      // A one-segment path is the shape that proves the brackets are really
      // part of the host: split anywhere else and the name comes out as
      // "db8::1]:repo", which is what this function used to return.
      ["git@[2001:db8::1]:repo.git", "repo", "scp"],
      ["git@[2001:db8::1]:acme/repo.git", "repo", "scp"],
      // file:// with an empty authority, and with a host
      ["file:///srv/git/repo.git", "repo", "scheme"],
      ["file:///srv/git/repo", "repo", "scheme"],
      ["file:///srv/git/repo.git/", "repo", "scheme"],
      ["file://nas.example.com/srv/repo.git", "repo", "scheme"],
      // absolute local paths
      ["/srv/git/repo.git", "repo", "local"],
      ["/srv/git/repo.git/", "repo", "local"],
      ["C:\\srv\\git\\repo.git", "repo", "local"],
      ["C:\\srv\\git\\repo.git\\", "repo", "local"],
    ];

    // Remotes git dials happily that carry no path segment to name a directory
    // after: a repository published at a web root. `git clone https://host`
    // clones one, so refusing these would hard-block a working configuration
    // with no other spelling to move to. They parse, with no name, and only an
    // entry without an explicit `bareRepoDir` has to care.
    const VALID_WITHOUT_NAME: string[] = [
      "https://github.com",
      "https://github.com/",
      "https://github.com//",
      "http://git.example.com",
      "https://git.example.com:8443",
      "HTTPS://git.example.com",
      "https://ci-bot:s3cr3t-token@git.example.com",
    ];

    // Refused by the validator *and* by the extractor. The first group is the
    // reason the validator had to be narrowed as well as widened: each of these
    // validated before and then had no final path segment to name a directory
    // after, so the run died later with the message this grammar exists to
    // prevent. Unlike the http(s) rows above, git cannot use any of them:
    // `ssh://git@host`, `git://host` and `file://` get "fatal: no path
    // specified" from git itself, and a path of `/` is not a repository either.
    const REJECTED: string[] = [
      "git://git.example.com",
      "git://git.example.com/",
      "ssh://git@github.com",
      "ssh://git@github.com/",
      "https://",
      "http://",
      "git@github.com:",
      "git@github.com:/",
      "file://",
      "file:///",
      "https:///acme/repo.git",
      "/",
      "//",
      // never accepted, and still not
      "relative/path",
      "not-a-url",
      "",
      "user@example.com",
      "ftp://example.com/acme/repo.git",
      "git+ssh://git@host.example/acme/repo.git",
      "@github.com:acme/repo.git",
      // an scp form needs a host as well as a user
      "git@:repo.git",
      // surrounding whitespace: the config file must hold the exact string git
      // is handed, so a padded repoUrl is refused rather than silently trimmed.
      // Both ends are listed separately: a guard that checked only one of them
      // still passes a both-ends-padded row, so only these pin it.
      "  https://github.com/acme/repo.git  ",
      "https://github.com/acme/repo.git ",
      " https://github.com/acme/repo.git",
      "git://git.example.com/ ",
      // an embedded newline is refused too. This one is a narrowing: the old
      // extractor matched it and named a directory after it, newline and all.
      "https://github.com/acme/re\npo.git",
      "git@github.com:acme/re\npo.git",
    ];

    it.each(ACCEPTED)("accepts %s, extracting %s as a %s URL", (url, expectedName, expectedKind) => {
      expect(parseGitUrl(url)).toEqual({ kind: expectedKind, repoName: expectedName });
      expect(isValidGitUrl(url)).toBe(true);
      expect(extractRepoNameFromUrl(url)).toBe(expectedName);
      expect(getDefaultBareRepoDir(url)).toBe(`.bare/${expectedName}`);
    });

    it.each(REJECTED.map((url) => [url]))("rejects %j from the validator and the extractor alike", (url) => {
      expect(isValidGitUrl(url)).toBe(false);
      expect(parseGitUrl(url)).toBeNull();
    });

    it.each(VALID_WITHOUT_NAME.map((url) => [url]))("accepts %j as a remote but derives no name from it", (url) => {
      expect(isValidGitUrl(url)).toBe(true);
      expect(parseGitUrl(url)).toEqual({ kind: "scheme", repoName: null });
      // The "derive a name" entry point still throws — with its own message,
      // because calling this URL malformed would be wrong.
      expect(() => extractRepoNameFromUrl(url)).toThrow("has no repository path segment");
      expect(() => extractRepoNameFromUrl(url)).not.toThrow("Invalid Git URL format");
    });

    // The invariant the whole change exists for, asserted over every row above
    // rather than one shape at a time: nothing the config loader accepts may
    // fail later for a reason the loader could have seen at validation time. A
    // URL that validates either names a directory, or is one of the rows the
    // loader knows to demand an explicit `bareRepoDir` for. The converse holds
    // too for every URL that is not space-padded — padding is the one
    // deliberate asymmetry, and it runs the safe way round (refused at load,
    // never accepted and then dropped later).
    it("never validates a URL that getDefaultBareRepoDir then refuses", () => {
      const disagreements: string[] = [];
      for (const url of [...ACCEPTED.map(([u]) => u), ...REJECTED, ...VALID_WITHOUT_NAME]) {
        const validated = isValidGitUrl(url);
        const namedAtLoad = validated && parseGitUrl(url)?.repoName !== null;
        let resolves: boolean;
        try {
          getDefaultBareRepoDir(url);
          resolves = true;
        } catch {
          resolves = false;
        }
        const paddedAndRefused = url !== url.trim() && !validated;
        if (namedAtLoad !== resolves && !paddedAndRefused) {
          disagreements.push(`${JSON.stringify(url)}: namedAtLoad=${namedAtLoad} resolves=${resolves}`);
        }
      }
      expect(disagreements).toEqual([]);
    });

    // `git://host/ ` is the trap: its path is a one-character space segment, so
    // a grammar that did not refuse surrounding whitespace would validate it
    // and then find nothing left to name once the extractor trimmed.
    it("refuses a padded URL rather than validating one name and extracting another", () => {
      expect(isValidGitUrl("git://git.example.com/ ")).toBe(false);
      expect(() => extractRepoNameFromUrl("git://git.example.com/ ")).toThrow("Invalid Git URL format");
      expect(isValidGitUrl("  https://github.com/acme/repo.git  ")).toBe(false);
      // The extractor still trims, because the init wizard calls it with raw
      // keystrokes before its own answer is trimmed and stored.
      expect(extractRepoNameFromUrl("  https://github.com/acme/repo.git  ")).toBe("repo");
    });

    it("tells the scp form apart from ssh:// URLs and from Windows paths", () => {
      // `://` is checked first, and the scp user/host classes exclude `/` and
      // `:`, so an ssh:// URL can never be read as scp.
      expect(parseGitUrl("ssh://git@github.com/acme/repo.git")?.kind).toBe("scheme");
      // A Windows path has no `user@`, which the scp form requires.
      expect(parseGitUrl("C:\\repos\\repo.git")?.kind).toBe("local");
      expect(parseGitUrl("deploy@git.example.com:team/repo.git")?.kind).toBe("scp");
      // Unchanged: a drive letter with forward slashes was refused by both
      // functions before this grammar and is still refused by it.
      expect(isValidGitUrl("C:/repos/repo.git")).toBe(false);
    });

    // Names that change move an existing user's .bare/<name> and force a
    // re-clone, so the odd corners keep the names they always had.
    it("keeps the names the extractor already produced for its odd corners", () => {
      expect(extractRepoNameFromUrl("https://h/o/.git")).toBe(".git");
      expect(extractRepoNameFromUrl("/srv/project/.git")).toBe("");
      expect(extractRepoNameFromUrl("https://h/o/repo.git.git")).toBe("repo.git");
      expect(extractRepoNameFromUrl("https://h/o/repo?x=1")).toBe("repo?x=1");
      expect(extractRepoNameFromUrl("https://h//o//repo.git")).toBe("repo");
      expect(extractRepoNameFromUrl("/srv/git/")).toBe("git");
      expect(extractRepoNameFromUrl("file://repo.git")).toBe("repo");
      expect(extractRepoNameFromUrl("git@h:.")).toBe(".");
    });

    // Widening the grammar must not widen what reaches a log. These are the
    // newly-accepted shapes, carrying a real token.
    it("still redacts credentials in every newly-accepted shape", () => {
      expect(redactRepoUrl("git://ci-bot:s3cr3t-token@git.example.com/acme/repo.git")).toBe(
        "git://***@git.example.com/acme/repo.git",
      );
      expect(redactRepoUrl("https://ci-bot:s3cr3t-token@github.com/acme/repo.git/")).toBe(
        "https://***@github.com/acme/repo.git/",
      );
      expect(redactRepoUrl("GIT://ghp_abcdef123456@git.example.com/acme/repo.git")).toBe(
        "GIT://***@git.example.com/acme/repo.git",
      );
      expect(redactSecretsInText("fatal: unable to access 'git://ci-bot:s3cr3t-token@h/acme/repo.git/': 403")).toBe(
        "fatal: unable to access 'git://***@h/acme/repo.git/': 403",
      );
      // scp form carries no password field; a username is not a secret, and it
      // was returned unchanged before this grammar accepted a non-`git` one.
      expect(redactRepoUrl("deploy@git.example.com:team/repo.git")).toBe("deploy@git.example.com:team/repo.git");
      // And the error the extractor throws is still scrubbed.
      expect(() => extractRepoNameFromUrl("git://ci-bot:s3cr3t-token@git.example.com")).toThrow(
        "Invalid Git URL format: git://***@git.example.com",
      );
    });
  });

  describe("normalizeRepoUrlForComparison", () => {
    it("treats trailing .git and trailing slash as equivalent", () => {
      const base = normalizeRepoUrlForComparison("https://github.com/u/r.git");
      expect(normalizeRepoUrlForComparison("https://github.com/u/r")).toBe(base);
      expect(normalizeRepoUrlForComparison("https://github.com/u/r/")).toBe(base);
      expect(normalizeRepoUrlForComparison("  https://github.com/u/r.git  ")).toBe(base);
    });

    it("lowercases scheme and host but preserves path case", () => {
      expect(normalizeRepoUrlForComparison("HTTPS://GitHub.com/User/Repo.git")).toBe("https://github.com/User/Repo");
    });

    it("keeps scp-style and https forms distinct (no false equivalence)", () => {
      expect(normalizeRepoUrlForComparison("git@github.com:u/r.git")).not.toBe(
        normalizeRepoUrlForComparison("https://github.com/u/r.git"),
      );
    });

    it("does NOT strip .git for local filesystem paths or file:// URLs", () => {
      expect(normalizeRepoUrlForComparison("/tmp/project.git")).not.toBe(normalizeRepoUrlForComparison("/tmp/project"));
      expect(normalizeRepoUrlForComparison("file:///tmp/project.git")).not.toBe(
        normalizeRepoUrlForComparison("file:///tmp/project"),
      );
    });
  });

  describe("getDefaultBareRepoDir", () => {
    it("should generate default bare repo path", () => {
      expect(getDefaultBareRepoDir("https://github.com/user/my-repo.git")).toBe(".bare/my-repo");
    });

    it("should use custom base directory", () => {
      expect(getDefaultBareRepoDir("https://github.com/user/my-repo.git", "custom-bare")).toBe("custom-bare/my-repo");
    });

    it("should handle complex repo names", () => {
      expect(getDefaultBareRepoDir("git@github.com:org/complex-repo-name.git")).toBe(".bare/complex-repo-name");
    });
  });

  describe("redactRepoUrl", () => {
    it("strips user:token from http(s) URLs", () => {
      expect(redactRepoUrl("https://ci-bot:s3cr3t-token@example.com/org/repo.git")).toBe(
        "https://***@example.com/org/repo.git",
      );
      expect(redactRepoUrl("http://ci-bot:s3cr3t-token@example.com/org/repo.git")).toBe(
        "http://***@example.com/org/repo.git",
      );
    });

    it("strips a bare username too, since forges accept tokens in the username slot", () => {
      expect(redactRepoUrl("https://ghp_abcdef123456@github.com/org/repo.git")).toBe(
        "https://***@github.com/org/repo.git",
      );
    });

    it("strips userinfo from ssh://, git+ssh:// and ftp(s):// URLs", () => {
      expect(redactRepoUrl("ssh://git@github.com/org/repo.git")).toBe("ssh://***@github.com/org/repo.git");
      expect(redactRepoUrl("git+ssh://deploy:secret@host.example/repo.git")).toBe(
        "git+ssh://***@host.example/repo.git",
      );
      expect(redactRepoUrl("ftps://deploy:secret@host.example/repo.git")).toBe("ftps://***@host.example/repo.git");
    });

    it("keeps IPv6 hosts and ports intact", () => {
      expect(redactRepoUrl("https://u:p@[2001:db8::1]:8443/repo.git")).toBe("https://***@[2001:db8::1]:8443/repo.git");
      expect(redactRepoUrl("http://u:p@10.0.0.5:8080/repo.git")).toBe("http://***@10.0.0.5:8080/repo.git");
    });

    it("leaves scp-style remotes, local paths and credential-free URLs unchanged", () => {
      for (const url of [
        "git@github.com:org/repo.git",
        "/srv/git/repo.git",
        "C:\\srv\\git\\repo.git",
        "file:///srv/git/repo.git",
        "https://github.com/org/repo.git",
        "https://github.com/org/repo@v1",
      ]) {
        expect(redactRepoUrl(url)).toBe(url);
      }
    });

    it("tolerates leading whitespace and is idempotent", () => {
      expect(redactRepoUrl("  https://u:p@example.com/r.git")).toBe("  https://***@example.com/r.git");
      expect(redactRepoUrl(redactRepoUrl("https://u:p@example.com/r.git"))).toBe("https://***@example.com/r.git");
    });
  });

  describe("redactSecretsInText", () => {
    it("scrubs every credential-bearing URL embedded in a sentence", () => {
      const text =
        "fatal: unable to access 'https://ci-bot:s3cr3t-token@example.com/r.git/': 403; " +
        "origin 'ssh://bot:pw@host/x.git' is not 'git+ssh://u@host/y.git'";
      expect(redactSecretsInText(text)).toBe(
        "fatal: unable to access 'https://***@example.com/r.git/': 403; " +
          "origin 'ssh://***@host/x.git' is not 'git+ssh://***@host/y.git'",
      );
    });

    it("scrubs URLs inside multi-line git output", () => {
      const text =
        "Cloning into bare repository '.bare/repo'...\nfatal: could not read from remote repository https://u:tok@h/r.git\nPlease make sure you have the correct access rights.";
      const scrubbed = redactSecretsInText(text);
      expect(scrubbed).toContain("https://***@h/r.git\nPlease make sure");
      expect(scrubbed).not.toContain("tok");
    });

    it("returns text without credential-bearing URLs unchanged", () => {
      for (const text of [
        "",
        "plain message",
        "mail user@example.com",
        "git@github.com:org/repo.git failed",
        "https://github.com/org/repo.git",
        "https://example.com/pkg/@scope/name",
        "https://***@example.com/r.git",
      ]) {
        expect(redactSecretsInText(text)).toBe(text);
      }
    });
  });

  describe("extractRepoNameFromUrl error messages", () => {
    // Both ways this can fail carry the URL into the message, so both have to
    // redact. `https://user:token@example.com` is a remote git dials, it just
    // has no name in it, so it takes the second message rather than the first.
    it("redacts credentials from the invalid-URL error", () => {
      expect(() => extractRepoNameFromUrl("git+ssh://ci-bot:s3cr3t-token@example.com/r.git")).toThrow(
        "Invalid Git URL format: git+ssh://***@example.com/r.git",
      );
    });

    it("redacts credentials from the no-path-segment error", () => {
      expect(() => extractRepoNameFromUrl("https://ci-bot:s3cr3t-token@example.com")).toThrow(
        "Git URL has no repository path segment to name a directory after: https://***@example.com",
      );
    });
  });
});
