import { describe, expect, it } from "@jest/globals";

import { extractRepoNameFromUrl, getDefaultBareRepoDir } from "../git-url";

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

    it("should handle URLs with different domains", () => {
      expect(extractRepoNameFromUrl("https://bitbucket.org/user/repo.git")).toBe("repo");
      expect(extractRepoNameFromUrl("git@bitbucket.org:user/repo.git")).toBe("repo");
    });

    it("should trim whitespace", () => {
      expect(extractRepoNameFromUrl("  https://github.com/user/repo.git  ")).toBe("repo");
    });

    it("should throw error for invalid URLs", () => {
      expect(() => extractRepoNameFromUrl("not-a-url")).toThrow("Invalid Git URL format");
      expect(() => extractRepoNameFromUrl("")).toThrow("Invalid Git URL format");
      expect(() => extractRepoNameFromUrl("/local/path")).toThrow("Invalid Git URL format");
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
});
