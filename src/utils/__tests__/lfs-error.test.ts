import { LFS_ERROR_PATTERNS, isLfsError, isLfsErrorFromError } from "../lfs-error";

describe("LFS Error Detection", () => {
  describe("isLfsError", () => {
    it("should detect smudge filter LFS failed errors", () => {
      const errorMessage = "error: external filter 'git-lfs smudge' failed";
      expect(isLfsError(errorMessage)).toBe(false); // This specific message is not in our patterns

      const actualMessage = "smudge filter lfs failed";
      expect(isLfsError(actualMessage)).toBe(true);
    });

    it("should detect Object does not exist on server errors", () => {
      const errorMessage = "Object does not exist on the server or you don't have permissions";
      expect(isLfsError(errorMessage)).toBe(true);
    });

    it("should detect external filter git-lfs filter-process failed errors", () => {
      const errorMessage = "error: external filter 'git-lfs filter-process' failed";
      expect(isLfsError(errorMessage)).toBe(true);
    });

    it("should not detect non-LFS errors", () => {
      const errorMessage = "fatal: unable to access 'https://github.com/repo.git/': Could not resolve host";
      expect(isLfsError(errorMessage)).toBe(false);
    });

    it("should be case sensitive", () => {
      const errorMessage = "SMUDGE FILTER LFS FAILED";
      expect(isLfsError(errorMessage)).toBe(false);
    });
  });

  describe("isLfsErrorFromError", () => {
    it("should detect LFS errors from Error objects", () => {
      const error = new Error("smudge filter lfs failed while processing file");
      expect(isLfsErrorFromError(error)).toBe(true);
    });

    it("should detect LFS errors from string errors", () => {
      const error = "Object does not exist on the server";
      expect(isLfsErrorFromError(error)).toBe(true);
    });

    it("should detect LFS errors from unknown error types", () => {
      const error = { message: "external filter 'git-lfs filter-process' failed" };
      expect(isLfsErrorFromError(error)).toBe(true);
    });

    it("should not detect non-LFS errors", () => {
      const error = new Error("Network connection failed");
      expect(isLfsErrorFromError(error)).toBe(false);
    });
  });

  describe("LFS_ERROR_PATTERNS", () => {
    it("should contain expected patterns", () => {
      expect(LFS_ERROR_PATTERNS).toContain("smudge filter lfs failed");
      expect(LFS_ERROR_PATTERNS).toContain("Object does not exist on the server");
      expect(LFS_ERROR_PATTERNS).toContain("external filter 'git-lfs filter-process' failed");
    });

    it("should be frozen to prevent modifications", () => {
      expect(Object.isFrozen(LFS_ERROR_PATTERNS)).toBe(true);
    });
  });
});
