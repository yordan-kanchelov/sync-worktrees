import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

  describe("plainBranchName", () => {
    it("flattens slashes to dashes and keeps everything else", () => {
      expect(service.plainBranchName("feature/login")).toBe("feature-login");
      expect(service.plainBranchName("feat/LCR-8879")).toBe("feat-LCR-8879");
      expect(service.plainBranchName("release/v1.2.3")).toBe("release-v1.2.3");
      expect(service.plainBranchName("fix_bug")).toBe("fix_bug");
    });

    it("has no plain name for branches that would need substitution", () => {
      expect(service.plainBranchName("bug#123")).toBeNull();
      expect(service.plainBranchName("user@domain")).toBeNull();
      expect(service.plainBranchName("feature/ünïcode")).toBeNull();
    });

    it("has no plain name for names that are awkward or unsafe as a directory", () => {
      expect(service.plainBranchName("-leading-dash")).toBeNull();
      expect(service.plainBranchName("trailing.")).toBeNull();
      expect(service.plainBranchName("CON")).toBeNull();
      expect(service.plainBranchName("nul.txt")).toBeNull();
      expect(service.plainBranchName("a".repeat(81))).toBeNull();
      expect(service.plainBranchName("a".repeat(80))).toBe("a".repeat(80));
    });
  });

  describe("branchDirectoryName", () => {
    const contextFor = (
      branches: string[],
      extra: Partial<Parameters<PathResolutionService["createNamingContext"]>[0]> = {},
    ) => service.createNamingContext({ branches, ...extra });

    it("uses the plain name when nothing else claims it", () => {
      expect(service.branchDirectoryName("feature/login", contextFor(["main", "feature/login"]))).toBe("feature-login");
    });

    it("hashes a branch whose name cannot be plain", () => {
      expect(service.branchDirectoryName("bug#123", contextFor(["bug#123"]))).toBe(
        service.sanitizeBranchName("bug#123"),
      );
    });

    it("hashes both sides of a slash/dash collision", () => {
      const context = contextFor(["feature/login", "feature-login"]);
      expect(service.branchDirectoryName("feature/login", context)).toBe(service.sanitizeBranchName("feature/login"));
      expect(service.branchDirectoryName("feature-login", context)).toBe(service.sanitizeBranchName("feature-login"));
    });

    it("hashes both sides of a case-only collision", () => {
      const context = contextFor(["Feature/Login", "feature/login"]);
      expect(service.branchDirectoryName("Feature/Login", context)).toBe(service.sanitizeBranchName("Feature/Login"));
      expect(service.branchDirectoryName("feature/login", context)).toBe(service.sanitizeBranchName("feature/login"));
    });

    it("hashes a name a registered worktree of another branch holds, whatever its case", () => {
      const context = contextFor(["docs"], { worktrees: [{ path: "/w/Docs", branch: "old/docs" }] });
      expect(service.branchDirectoryName("docs", context)).toBe(service.sanitizeBranchName("docs"));
    });

    it("keeps the plain name its own registration holds", () => {
      const context = contextFor(["docs"], { worktrees: [{ path: "/w/docs", branch: "docs" }] });
      expect(service.branchDirectoryName("docs", context)).toBe("docs");
    });

    it("hashes a name a detached checkout holds", () => {
      const context = contextFor(["docs"], { worktrees: [{ path: "/w/docs", branch: "" }] });
      expect(service.branchDirectoryName("docs", context)).toBe(service.sanitizeBranchName("docs"));
    });

    it("hashes a name the default branch's worktree path uses", () => {
      const context = contextFor(["MAIN", "release/2024", "2024"], { defaultBranch: "release/2024" });
      expect(service.branchDirectoryName("2024", context)).toBe(service.sanitizeBranchName("2024"));
      expect(service.branchDirectoryName("MAIN", context)).toBe("MAIN");
      expect(service.branchDirectoryName("MAIN", contextFor(["MAIN"], { defaultBranch: "main" }))).toBe(
        service.sanitizeBranchName("MAIN"),
      );
    });

    it("gives a leftover metadata record's name back only to the branch it belonged to", () => {
      const context = contextFor(["feature/x"], { taken: [["feature-x", "feature-x"]] });
      expect(service.branchDirectoryName("feature/x", context)).toBe(service.sanitizeBranchName("feature/x"));
      const own = contextFor(["feature/x"], { taken: [["feature-x", "feature/x"]] });
      expect(service.branchDirectoryName("feature/x", own)).toBe("feature-x");
    });

    it("returns the preferred name without a context", () => {
      expect(service.getBranchWorktreePath("/w", "feature/login")).toBe(path.join("/w", "feature-login"));
    });
  });

  describe("probeTakenNames", () => {
    let root: string;
    let worktreeDir: string;
    let bareRepoPath: string;

    beforeEach(async () => {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "path-res-names-")));
      worktreeDir = path.join(root, "worktrees");
      bareRepoPath = path.join(root, ".bare");
      await fs.mkdir(worktreeDir, { recursive: true });
      await fs.mkdir(path.join(bareRepoPath, "worktrees", "x"), { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    const probe = (branches: string[], owners: Record<string, string> = {}): Promise<Array<[string, string | null]>> =>
      service.probeTakenNames(branches, service.createNamingContext({ branches }), {
        worktreeDir,
        bareRepoPath,
        readMetadataOwner: async (name) => owners[name] ?? null,
      });

    it("reports nothing for names with nothing on disk", async () => {
      expect(await probe(["feature/a"])).toEqual([]);
    });

    it("reports a stray directory, file or dangling symlink at the plain name as held by nobody", async () => {
      await fs.mkdir(path.join(worktreeDir, "notes"));
      await fs.writeFile(path.join(worktreeDir, "todo"), "x");
      await fs.symlink(path.join(root, "missing"), path.join(worktreeDir, "gone"));

      expect(await probe(["notes", "todo", "gone"])).toEqual([
        ["notes", null],
        ["todo", null],
        ["gone", null],
      ]);
    });

    it("reports a checkout of another repository as held by nobody", async () => {
      await fs.mkdir(path.join(worktreeDir, "other"));
      await fs.writeFile(
        path.join(worktreeDir, "other", ".git"),
        `gitdir: ${path.join(root, "elsewhere", "worktrees", "o")}\n`,
      );

      expect(await probe(["other"])).toEqual([["other", null]]);
    });

    it("leaves this repository's own worktree directory for worktree creation to adopt", async () => {
      await fs.mkdir(path.join(worktreeDir, "mine"));
      await fs.writeFile(
        path.join(worktreeDir, "mine", ".git"),
        `gitdir: ${path.join(bareRepoPath, "worktrees", "x")}\n`,
      );

      expect(await probe(["mine"])).toEqual([]);
    });

    it("reports a leftover metadata record under its branch", async () => {
      expect(await probe(["feature/x"], { "feature-x": "feature-x" })).toEqual([["feature-x", "feature-x"]]);
    });

    it("does not probe branches that are hashed anyway", async () => {
      await fs.mkdir(path.join(worktreeDir, "feature-x"));
      expect(await probe(["feature/x", "feature-x", "bug#1"])).toEqual([]);
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
