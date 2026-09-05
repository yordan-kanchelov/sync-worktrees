import { describe, expect, it } from "vitest";

import {
  extractRepoNameFromUrl,
  getDefaultBareRepoDir,
  normalizeRepoUrlForComparison,
  redactRepoUrl,
  redactSecretsInText,
} from "../git-url";

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
    it("redacts credentials from the invalid-URL error", () => {
      expect(() => extractRepoNameFromUrl("https://ci-bot:s3cr3t-token@example.com")).toThrow(
        "Invalid Git URL format: https://***@example.com",
      );
    });
  });
});
