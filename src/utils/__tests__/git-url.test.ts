import { describe, expect, it } from "vitest";

import {
  extractRepoNameFromUrl,
  getDefaultBareRepoDir,
  isValidGitUrl,
  normalizeRepoUrlForComparison,
  parseGitUrl,
  redactRepoUrl,
  redactSecretsInText,
  repoDisplayLabel,
} from "../git-url";

import type { ParsedGitUrl } from "../git-url";

describe("git-url utilities", () => {
  describe("extractRepoNameFromUrl", () => {
    it("should throw error for invalid URLs", () => {
      expect(() => extractRepoNameFromUrl("not-a-url")).toThrow("Invalid Git URL format");
      expect(() => extractRepoNameFromUrl("")).toThrow("Invalid Git URL format");
      expect(() => extractRepoNameFromUrl("relative/path")).toThrow("Invalid Git URL format");
    });
  });

  describe("one grammar for isValidGitUrl and extractRepoNameFromUrl", () => {
    const ACCEPTED: Array<[string, string, ParsedGitUrl["kind"]]> = [
      ["https://github.com/acme/repo.git", "repo", "scheme"],
      ["https://github.com/acme/repo", "repo", "scheme"],
      ["http://git.example.com/acme/repo.git", "repo", "scheme"],
      ["https://git.example.com:8443/acme/repo.git", "repo", "scheme"],
      ["https://ci-bot:s3cr3t-token@github.com/acme/repo.git", "repo", "scheme"],
      ["https://git.example.com/repo.git", "repo", "scheme"],
      ["https://gitlab.com/group/subgroup/repo.git", "repo", "scheme"],
      ["https://github.com/acme/repo.git/", "repo", "scheme"],
      ["https://github.com/acme/repo/", "repo", "scheme"],
      ["https://github.com/acme/repo.git//", "repo", "scheme"],
      ["git://git.example.com/repo.git", "repo", "scheme"],
      ["git://git.example.com/acme/repo.git", "repo", "scheme"],
      ["git://git.example.com:9418/acme/repo.git", "repo", "scheme"],
      ["git://git.example.com/acme/repo.git/", "repo", "scheme"],
      ["ssh://git@github.com/acme/repo.git", "repo", "scheme"],
      ["ssh://git@git.example.com:2222/acme/repo.git", "repo", "scheme"],
      ["ssh://git@github.com/acme/repo.git/", "repo", "scheme"],
      ["ssh://git.example.com/acme/repo.git", "repo", "scheme"],
      ["GIT://git.example.com/acme/repo.git", "repo", "scheme"],
      ["HTTPS://github.com/acme/repo.git", "repo", "scheme"],
      ["git@github.com:acme/repo.git", "repo", "scp"],
      ["git@github.com:acme/repo", "repo", "scp"],
      ["git@gitlab.com:group/subgroup/repo.git", "repo", "scp"],
      ["deploy@git.example.com:team/repo.git", "repo", "scp"],
      ["build-bot@gerrit.example.com:repo.git", "repo", "scp"],
      ["my.user@gitea.example.com:team/repo.git", "repo", "scp"],
      ["git@github.com:acme/repo.git/", "repo", "scp"],
      ["git@github.com:/srv/git/repo.git", "repo", "scp"],
      ["git@github.com:~acme/repo.git", "repo", "scp"],
      ["git@[2001:db8::1]:repo.git", "repo", "scp"],
      ["git@[2001:db8::1]:acme/repo.git", "repo", "scp"],
      ["file:///srv/git/repo.git", "repo", "scheme"],
      ["file:///srv/git/repo", "repo", "scheme"],
      ["file:///srv/git/repo.git/", "repo", "scheme"],
      ["file://nas.example.com/srv/repo.git", "repo", "scheme"],
      ["/srv/git/repo.git", "repo", "local"],
      ["/srv/git/repo.git/", "repo", "local"],
      ["C:\\srv\\git\\repo.git", "repo", "local"],
      ["C:\\srv\\git\\repo.git\\", "repo", "local"],
    ];

    const VALID_WITHOUT_NAME: string[] = [
      "https://github.com",
      "https://github.com/",
      "https://github.com//",
      "http://git.example.com",
      "https://git.example.com:8443",
      "HTTPS://git.example.com",
      "https://ci-bot:s3cr3t-token@git.example.com",
    ];

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
      "relative/path",
      "not-a-url",
      "",
      "user@example.com",
      "ftp://example.com/acme/repo.git",
      "git+ssh://git@host.example/acme/repo.git",
      "@github.com:acme/repo.git",
      "git@:repo.git",
      "  https://github.com/acme/repo.git  ",
      "https://github.com/acme/repo.git ",
      " https://github.com/acme/repo.git",
      "git://git.example.com/ ",
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
      expect(() => extractRepoNameFromUrl(url)).toThrow("has no repository path segment");
      expect(() => extractRepoNameFromUrl(url)).not.toThrow("Invalid Git URL format");
    });

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

    it("refuses a padded URL rather than validating one name and extracting another", () => {
      expect(isValidGitUrl("git://git.example.com/ ")).toBe(false);
      expect(() => extractRepoNameFromUrl("git://git.example.com/ ")).toThrow("Invalid Git URL format");
      expect(isValidGitUrl("  https://github.com/acme/repo.git  ")).toBe(false);
      expect(extractRepoNameFromUrl("  https://github.com/acme/repo.git  ")).toBe("repo");
    });

    it("tells the scp form apart from ssh:// URLs and from Windows paths", () => {
      expect(parseGitUrl("ssh://git@github.com/acme/repo.git")?.kind).toBe("scheme");
      expect(parseGitUrl("C:\\repos\\repo.git")?.kind).toBe("local");
      expect(parseGitUrl("deploy@git.example.com:team/repo.git")?.kind).toBe("scp");
      expect(isValidGitUrl("C:/repos/repo.git")).toBe(false);
    });

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
      expect(redactRepoUrl("deploy@git.example.com:team/repo.git")).toBe("deploy@git.example.com:team/repo.git");
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
    it("should use custom base directory", () => {
      expect(getDefaultBareRepoDir("https://github.com/user/my-repo.git", "custom-bare")).toBe("custom-bare/my-repo");
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

  describe("repoDisplayLabel", () => {
    it("is the configured name when there is one", () => {
      expect(repoDisplayLabel({ name: "app", repoUrl: "https://u:token@example.com/org/app.git" })).toBe("app");
    });

    it("falls back to the redacted URL for a repository without a name", () => {
      expect(repoDisplayLabel({ repoUrl: "https://u:token@example.com/org/app.git" })).toBe(
        "https://***@example.com/org/app.git",
      );
      expect(repoDisplayLabel({ name: "", repoUrl: "https://u:token@example.com/org/app.git" })).toBe(
        "https://***@example.com/org/app.git",
      );
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
