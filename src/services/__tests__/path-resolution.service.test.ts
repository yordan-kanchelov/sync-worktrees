import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../path-resolution.service";

describe("PathResolutionService", () => {
  let service: PathResolutionService;

  beforeEach(() => {
    service = new PathResolutionService();
  });

  describe("sanitizeBranchName", () => {
    it("should start sanitized output with readable branch stem", () => {
      expect(service.sanitizeBranchName("feature/test")).toMatch(/^feature-test-[a-f0-9]{8}$/);
    });

    it("should replace special characters with underscores in readable stem", () => {
      expect(service.sanitizeBranchName("bug#123")).toMatch(/^bug_123-[a-f0-9]{8}$/);
      expect(service.sanitizeBranchName("user@domain")).toMatch(/^user_domain-[a-f0-9]{8}$/);
    });

    it("should handle complex branch names", () => {
      expect(service.sanitizeBranchName("feature/bug#123@hotfix")).toMatch(/^feature-bug_123_hotfix-[a-f0-9]{8}$/);
    });

    it("should preserve alphanumeric and basic characters in stem", () => {
      expect(service.sanitizeBranchName("feat-123_test")).toMatch(/^feat-123_test-[a-f0-9]{8}$/);
    });

    it("should produce different outputs for collision-prone branch names", () => {
      const a = service.sanitizeBranchName("feature/test");
      const b = service.sanitizeBranchName("feature-test");
      expect(a).not.toBe(b);
    });

    it("should be deterministic for the same input", () => {
      expect(service.sanitizeBranchName("feature/test")).toBe(service.sanitizeBranchName("feature/test"));
    });
  });

  describe("isPathInsideBaseDir", () => {
    it("should return true for path inside base directory", () => {
      expect(service.isPathInsideBaseDir("/base/sub/path", "/base")).toBe(true);
    });

    it("should return false for path outside base directory", () => {
      expect(service.isPathInsideBaseDir("/outside", "/base")).toBe(false);
    });

    it("should return false for path traversal attempts", () => {
      expect(service.isPathInsideBaseDir("/base/../outside", "/base")).toBe(false);
    });

    it("should return false for a deep traversal escape", () => {
      expect(service.isPathInsideBaseDir("/base/worktrees/../../etc/passwd", "/base/worktrees")).toBe(false);
    });

    it("should return true when path equals base directory", () => {
      expect(service.isPathInsideBaseDir("/base", "/base")).toBe(true);
    });
  });

  describe("symlink boundary", () => {
    let tmpRoot: string;
    let baseDir: string;
    let outsideDir: string;
    let symlinkInsideBase: string;
    let symlinkSupported = true;

    beforeAll(async () => {
      tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "path-res-")));
      baseDir = path.join(tmpRoot, "base");
      outsideDir = path.join(tmpRoot, "outside");
      await fs.mkdir(baseDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      symlinkInsideBase = path.join(baseDir, "escape");
      try {
        await fs.symlink(outsideDir, symlinkInsideBase, "dir");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Environments without symlink privileges return EPERM/EACCES/UNKNOWN/ENOSYS.
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN" || code === "ENOSYS") {
          symlinkSupported = false;
          return;
        }
        throw err;
      }
    });

    afterAll(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("isPathInsideBaseDir should return false for symlink escaping base", () => {
      if (!symlinkSupported) return;
      const target = path.join(symlinkInsideBase, "child");
      expect(service.isPathInsideBaseDir(target, baseDir)).toBe(false);
    });

    it("isPathInsideResolvedBaseDir should return false for symlink escaping base", async () => {
      if (!symlinkSupported) return;
      const target = path.join(symlinkInsideBase, "child");
      const resolvedBase = await service.resolveBaseDir(baseDir);
      expect(await service.isPathInsideResolvedBaseDir(target, resolvedBase)).toBe(false);
    });
  });

  // The async variant is the one the sync runner partitions with, so it has to
  // answer exactly what the synchronous variant answers — a divergence here is
  // a hole in the boundary that decides which directories the tool may touch.
  describe("isPathInsideResolvedBaseDir parity with isPathInsideBaseDir", () => {
    let tmpRoot: string;
    let baseDir: string;
    let cases: { label: string; target: string; base: string }[];
    let symlinkSupported = true;

    beforeAll(async () => {
      tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "path-res-parity-")));
      baseDir = path.join(tmpRoot, "base");
      const outsideDir = path.join(tmpRoot, "outside");
      await fs.mkdir(path.join(baseDir, "real", "nested"), { recursive: true });
      await fs.mkdir(path.join(outsideDir, "secret"), { recursive: true });
      await fs.writeFile(path.join(baseDir, "file.txt"), "x");

      try {
        await fs.symlink(outsideDir, path.join(baseDir, "escape"), "dir");
        await fs.symlink(path.join(baseDir, "real"), path.join(baseDir, "inward"), "dir");
        await fs.symlink(path.join(baseDir, "loop-b"), path.join(baseDir, "loop-a"));
        await fs.symlink(path.join(baseDir, "loop-a"), path.join(baseDir, "loop-b"));
        await fs.symlink(path.join(tmpRoot, "nothing-here"), path.join(baseDir, "dangling"));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN" || code === "ENOSYS") {
          symlinkSupported = false;
        } else {
          throw err;
        }
      }

      const inBase = (...segments: string[]): string => path.join(baseDir, ...segments);
      cases = [
        { label: "the base itself", target: baseDir, base: baseDir },
        { label: "an existing child", target: inBase("real"), base: baseDir },
        { label: "an existing grandchild", target: inBase("real", "nested"), base: baseDir },
        // The worktree a create action is about to make does not exist yet, so
        // the walk up over missing components is the common case, not an edge.
        { label: "a path that does not exist yet", target: inBase("real", "nested", "not", "created"), base: baseDir },
        { label: "a whole missing subtree", target: inBase("brand", "new", "worktree"), base: baseDir },
        { label: "a sibling of the base", target: path.join(tmpRoot, "outside", "secret"), base: baseDir },
        { label: "a traversal back out of the base", target: inBase("..", "outside"), base: baseDir },
        { label: "a deep traversal escape", target: inBase("real", "..", "..", "outside", "secret"), base: baseDir },
        { label: "a name sharing the base's prefix", target: `${baseDir}-sibling`, base: baseDir },
        { label: "a file rather than a directory", target: inBase("file.txt"), base: baseDir },
        { label: "a child of a file", target: inBase("file.txt", "child"), base: baseDir },
        { label: "a base that does not exist", target: inBase("real"), base: path.join(tmpRoot, "absent") },
        { label: "a relative target", target: "relative/candidate", base: baseDir },
        { label: "a target with a NUL byte", target: inBase("nul\u0000name"), base: baseDir },
        { label: "the filesystem root as base", target: baseDir, base: path.sep },
      ];

      if (symlinkSupported) {
        cases.push(
          { label: "a symlink out of the base", target: inBase("escape"), base: baseDir },
          {
            label: "a child reached through a symlink out of the base",
            target: inBase("escape", "secret"),
            base: baseDir,
          },
          {
            label: "a missing child reached through a symlink out of the base",
            target: inBase("escape", "secret", "gone"),
            base: baseDir,
          },
          { label: "a symlink pointing back into the base", target: inBase("inward", "nested"), base: baseDir },
          { label: "a symlink loop", target: inBase("loop-a"), base: baseDir },
          { label: "a child of a symlink loop", target: inBase("loop-a", "child"), base: baseDir },
          { label: "a dangling symlink", target: inBase("dangling"), base: baseDir },
          { label: "a child of a dangling symlink", target: inBase("dangling", "child"), base: baseDir },
          { label: "a symlinked base", target: inBase("real", "nested"), base: inBase("inward") },
        );
      }
    });

    afterAll(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("should agree with the synchronous check on every boundary case", async () => {
      const verdicts = new Set<boolean>();
      for (const { label, target, base } of cases) {
        const expected = service.isPathInsideBaseDir(target, base);
        const actual = await service.isPathInsideResolvedBaseDir(target, await service.resolveBaseDir(base));
        expect({ label, inside: actual }).toEqual({ label, inside: expected });
        verdicts.add(expected);
      }
      // Agreement is only worth anything if the matrix admits some paths and
      // refuses others; an all-false run would pass against a check that never
      // says yes.
      expect([...verdicts].sort()).toEqual([false, true]);
    });
  });
});
