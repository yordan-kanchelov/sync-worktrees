import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileCopyService } from "../file-copy.service";

describe("FileCopyService", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;
  let service: FileCopyService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-copy-test-"));
    sourceDir = path.join(tempDir, "source");
    destDir = path.join(tempDir, "dest");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destDir, { recursive: true });
    service = new FileCopyService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("copyFiles", () => {
    it("should copy a single file", async () => {
      await fs.writeFile(path.join(sourceDir, "test.txt"), "content");

      const result = await service.copyFiles(sourceDir, destDir, ["test.txt"]);

      expect(result.copied).toEqual(["test.txt"]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);

      const destContent = await fs.readFile(path.join(destDir, "test.txt"), "utf-8");
      expect(destContent).toBe("content");
    });

    it("should skip existing files at destination", async () => {
      await fs.writeFile(path.join(sourceDir, "test.txt"), "source content");
      await fs.writeFile(path.join(destDir, "test.txt"), "existing content");

      const result = await service.copyFiles(sourceDir, destDir, ["test.txt"]);

      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual(["test.txt"]);

      const destContent = await fs.readFile(path.join(destDir, "test.txt"), "utf-8");
      expect(destContent).toBe("existing content");
    });

    it("should handle glob patterns", async () => {
      await fs.mkdir(path.join(sourceDir, ".claude"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".claude", "file1.md"), "content1");
      await fs.writeFile(path.join(sourceDir, ".claude", "file2.md"), "content2");

      const result = await service.copyFiles(sourceDir, destDir, [".claude/*"]);

      expect(result.copied.sort()).toEqual([".claude/file1.md", ".claude/file2.md"].sort());
    });

    it("should create parent directories", async () => {
      await fs.mkdir(path.join(sourceDir, "deep", "nested"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "deep", "nested", "file.txt"), "content");

      const result = await service.copyFiles(sourceDir, destDir, ["deep/nested/file.txt"]);

      expect(result.copied).toEqual(["deep/nested/file.txt"]);
      const destContent = await fs.readFile(path.join(destDir, "deep", "nested", "file.txt"), "utf-8");
      expect(destContent).toBe("content");
    });

    it("should return empty result for non-matching patterns", async () => {
      const result = await service.copyFiles(sourceDir, destDir, ["nonexistent.txt"]);

      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("should handle empty patterns array", async () => {
      const result = await service.copyFiles(sourceDir, destDir, []);

      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("should handle dotfiles", async () => {
      await fs.writeFile(path.join(sourceDir, ".env.local"), "SECRET=value");

      const result = await service.copyFiles(sourceDir, destDir, [".env.local"]);

      expect(result.copied).toEqual([".env.local"]);
    });

    it("should handle multiple patterns", async () => {
      await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "claude content");
      await fs.writeFile(path.join(sourceDir, ".env.local"), "env content");
      await fs.writeFile(path.join(sourceDir, "other.txt"), "other content");

      const result = await service.copyFiles(sourceDir, destDir, ["CLAUDE.md", ".env.local"]);

      expect(result.copied.sort()).toEqual([".env.local", "CLAUDE.md"].sort());
    });

    it("should deduplicate files from overlapping patterns", async () => {
      await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "claude content");

      const result = await service.copyFiles(sourceDir, destDir, ["CLAUDE.md", "*.md"]);

      expect(result.copied).toEqual(["CLAUDE.md"]);
    });

    it("should copy files with special characters in name", async () => {
      await fs.writeFile(path.join(sourceDir, "file-with-dash.txt"), "content");
      await fs.writeFile(path.join(sourceDir, "file_with_underscore.txt"), "content2");

      const result = await service.copyFiles(sourceDir, destDir, ["file-with-dash.txt", "file_with_underscore.txt"]);

      expect(result.copied.sort()).toEqual(["file-with-dash.txt", "file_with_underscore.txt"].sort());
    });

    it("should mix copied and skipped files", async () => {
      await fs.writeFile(path.join(sourceDir, "new-file.txt"), "new content");
      await fs.writeFile(path.join(sourceDir, "existing-file.txt"), "source content");
      await fs.writeFile(path.join(destDir, "existing-file.txt"), "dest content");

      const result = await service.copyFiles(sourceDir, destDir, ["new-file.txt", "existing-file.txt"]);

      expect(result.copied).toEqual(["new-file.txt"]);
      expect(result.skipped).toEqual(["existing-file.txt"]);
    });

    it("should handle nested glob patterns", async () => {
      await fs.mkdir(path.join(sourceDir, "a", "b"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "a", "file1.md"), "content1");
      await fs.writeFile(path.join(sourceDir, "a", "b", "file2.md"), "content2");

      const result = await service.copyFiles(sourceDir, destDir, ["**/*.md"]);

      expect(result.copied.sort()).toEqual(["a/b/file2.md", "a/file1.md"].sort());
    });

    it("should copy relative config files into the same target paths", async () => {
      await fs.mkdir(path.join(sourceDir, "config"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "SECRET=value");
      await fs.writeFile(path.join(sourceDir, "config", "local.json"), "{}");

      const result = await service.copyFiles(sourceDir, destDir, [".env", "config/*.json"]);

      expect(result.copied.sort()).toEqual([".env", "config/local.json"].sort());
      await expect(fs.readFile(path.join(destDir, ".env"), "utf-8")).resolves.toBe("SECRET=value");
      await expect(fs.readFile(path.join(destDir, "config", "local.json"), "utf-8")).resolves.toBe("{}");
    });

    it("should reject absolute and escaping patterns", async () => {
      await fs.writeFile(path.join(sourceDir, ".env"), "SECRET=value");

      const result = await service.copyFiles(sourceDir, destDir, [path.join(sourceDir, ".env"), "../escape"]);

      expect(result.copied).toEqual([]);
      expect(result.errors).toEqual([
        { file: path.join(sourceDir, ".env"), error: "Pattern must be relative and stay inside source directory" },
        { file: "../escape", error: "Pattern must be relative and stay inside source directory" },
      ]);
      await expect(fs.stat(path.join(destDir, ".env"))).rejects.toThrow();
    });

    it("should preserve file content exactly", async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      await fs.writeFile(path.join(sourceDir, "binary.bin"), binaryContent);

      await service.copyFiles(sourceDir, destDir, ["binary.bin"]);

      const destContent = await fs.readFile(path.join(destDir, "binary.bin"));
      expect(destContent).toEqual(binaryContent);
    });

    it("should ignore files in node_modules with glob patterns", async () => {
      await fs.mkdir(path.join(sourceDir, "node_modules", "some-package"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "root content");
      await fs.writeFile(path.join(sourceDir, "node_modules", "some-package", "CLAUDE.md"), "package content");

      const result = await service.copyFiles(sourceDir, destDir, ["**/CLAUDE.md"]);

      expect(result.copied).toEqual(["CLAUDE.md"]);
    });

    it("should ignore files in .git directory with glob patterns", async () => {
      await fs.mkdir(path.join(sourceDir, ".git", "hooks"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "README.md"), "readme content");
      await fs.writeFile(path.join(sourceDir, ".git", "hooks", "pre-commit.md"), "hook content");

      const result = await service.copyFiles(sourceDir, destDir, ["**/*.md"]);

      expect(result.copied).toEqual(["README.md"]);
    });

    it("should ignore files in dist/build/coverage directories", async () => {
      await fs.mkdir(path.join(sourceDir, "dist"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, "build"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, "coverage"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "src.md"), "source");
      await fs.writeFile(path.join(sourceDir, "dist", "out.md"), "dist");
      await fs.writeFile(path.join(sourceDir, "build", "out.md"), "build");
      await fs.writeFile(path.join(sourceDir, "coverage", "report.md"), "coverage");

      const result = await service.copyFiles(sourceDir, destDir, ["**/*.md"]);

      expect(result.copied).toEqual(["src.md"]);
    });

    it("should ignore the directories this tool creates for its own bookkeeping", async () => {
      for (const dir of [".bare/tools", ".trash/abc/payload", ".removed/old", ".diverged/old"]) {
        await fs.mkdir(path.join(sourceDir, dir), { recursive: true });
        await fs.writeFile(path.join(sourceDir, dir, ".env"), dir);
      }
      await fs.mkdir(path.join(sourceDir, ".sync-worktrees-state"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".sync-worktrees-state", ".env"), "state");
      await fs.mkdir(path.join(sourceDir, ".sync-worktrees-locks"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".sync-worktrees-locks", ".env"), "locks");
      await fs.writeFile(path.join(sourceDir, ".env"), "root");

      const result = await service.copyFiles(sourceDir, destDir, ["**/.env"]);

      expect(result.copied).toEqual([".env"]);
    });
  });

  describe("copyFiles excludeDirs", () => {
    it("never reads out of an excluded sibling checkout or out of the destination", async () => {
      await fs.mkdir(path.join(sourceDir, "other-repo"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, "dest"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "intended");
      await fs.writeFile(path.join(sourceDir, "other-repo", ".env"), "foreign secret");
      await fs.writeFile(path.join(sourceDir, "dest", ".env"), "already there");

      const result = await service.copyFiles(sourceDir, path.join(sourceDir, "dest"), ["**/.env"], {
        excludeDirs: [path.join(sourceDir, "other-repo"), path.join(sourceDir, "dest")],
      });

      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual([".env"]);
      await expect(fs.stat(path.join(sourceDir, "dest", "other-repo", ".env"))).rejects.toThrow();
      await expect(fs.stat(path.join(sourceDir, "dest", "dest", ".env"))).rejects.toThrow();
      await expect(fs.readFile(path.join(sourceDir, "dest", ".env"), "utf-8")).resolves.toBe("already there");
    });

    it("copies the intended file while excluding a sibling (the same tree, without the pre-existing destination copy)", async () => {
      await fs.mkdir(path.join(sourceDir, "other-repo"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "intended");
      await fs.writeFile(path.join(sourceDir, "other-repo", ".env"), "foreign secret");

      const result = await service.copyFiles(sourceDir, destDir, ["**/.env"], {
        excludeDirs: [path.join(sourceDir, "other-repo"), destDir],
      });

      expect(result.copied).toEqual([".env"]);
      await expect(fs.readFile(path.join(destDir, ".env"), "utf-8")).resolves.toBe("intended");
    });

    it("excludes both halves of a nested pair of checkouts and nothing else", async () => {
      await fs.mkdir(path.join(sourceDir, "outer", "inner", "deep"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, "unrelated"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "root");
      await fs.writeFile(path.join(sourceDir, "outer", ".env"), "outer");
      await fs.writeFile(path.join(sourceDir, "outer", "inner", ".env"), "inner");
      await fs.writeFile(path.join(sourceDir, "outer", "inner", "deep", ".env"), "deep");
      await fs.writeFile(path.join(sourceDir, "unrelated", ".env"), "unrelated");

      const result = await service.copyFiles(sourceDir, destDir, ["**/.env"], {
        excludeDirs: [destDir, path.join(sourceDir, "outer"), path.join(sourceDir, "outer", "inner")],
      });

      expect(result.copied.sort()).toEqual([".env", "unrelated/.env"]);
    });

    it("treats relative, absolute and symlinked spellings of the same checkout alike", async () => {
      await fs.mkdir(path.join(sourceDir, "api"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, "web"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "root");
      await fs.writeFile(path.join(sourceDir, "api", ".env"), "api");
      await fs.writeFile(path.join(sourceDir, "web", ".env"), "web");
      await fs.symlink(path.join(sourceDir, "api"), path.join(sourceDir, "api-link"));

      const spellings = [
        ["api", "web"],
        [path.join(sourceDir, "api"), path.join(sourceDir, "web")],
        // Canonicalized, so the symlink names the checkout it points at.
        [path.join(sourceDir, "api-link"), path.join(sourceDir, "web")],
      ];

      for (const excludeDirs of spellings) {
        await fs.rm(destDir, { recursive: true, force: true });
        await fs.mkdir(destDir, { recursive: true });
        const result = await service.copyFiles(sourceDir, destDir, ["**/.env"], { excludeDirs });
        expect(result.copied).toEqual([".env"]);
      }
    });

    it("keeps the rest of the source readable around an exclusion it cannot place inside it", async () => {
      await fs.mkdir(path.join(sourceDir, "keep"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "root");
      await fs.writeFile(path.join(sourceDir, "keep", ".env"), "keep");
      // Everything under the source resolves into the source, so an exclusion
      // of the source itself would prune every alias in it.
      await fs.symlink(path.join(sourceDir, "keep"), path.join(sourceDir, "keep-alias"));

      const result = await service.copyFiles(sourceDir, destDir, ["**/.env", "*/.env"], {
        // A worktreeDir configured outside the config file's directory, a
        // directory that does not exist at all, and the source directory
        // itself. None of them names a directory the walk spells out, so none
        // of them may take one away either.
        excludeDirs: [path.join(tempDir, "elsewhere"), "/nowhere/at/all", sourceDir, destDir],
      });

      expect(result.copied.sort()).toEqual([".env", "keep-alias/.env", "keep/.env"]);
    });

    // Each excluded name is paired with a sibling the config did NOT exclude but
    // that the excluded name would match if it were read as a pattern: a
    // metacharacter mishandled one way leaks the excluded checkout's own file,
    // and the other way silently drops the sibling.
    it("names an excluded checkout exactly, whatever glob metacharacters it contains", async () => {
      const excluded = ["feature[1]", "a*b", "{a,b}"];
      const siblings = ["feature1", "axxb", "a", "b"];
      for (const dir of [...excluded, ...siblings]) {
        await fs.mkdir(path.join(sourceDir, dir), { recursive: true });
        await fs.writeFile(path.join(sourceDir, dir, ".env"), dir);
      }
      await fs.writeFile(path.join(sourceDir, ".env"), "root");

      const result = await service.copyFiles(sourceDir, destDir, ["**/.env"], {
        excludeDirs: [...excluded.map((dir) => path.join(sourceDir, dir)), destDir],
      });

      expect(result.copied.sort()).toEqual([".env", "a/.env", "axxb/.env", "b/.env", "feature1/.env"]);
      for (const dir of excluded) {
        await expect(fs.stat(path.join(destDir, dir, ".env"))).rejects.toThrow();
      }
    });

    // A prefix comparison instead of a segment-exact one keeps every sibling
    // whose name merely starts with an excluded one out of the copy — a file
    // the user asked for, dropped with no message.
    it("excludes a checkout without excluding the siblings its name is a prefix of", async () => {
      for (const dir of ["api", "api-v2", "api.old", "apiX"]) {
        await fs.mkdir(path.join(sourceDir, dir), { recursive: true });
        await fs.writeFile(path.join(sourceDir, dir, ".env"), dir);
      }
      await fs.writeFile(path.join(sourceDir, ".env"), "root");

      const result = await service.copyFiles(sourceDir, destDir, ["**/.env"], {
        excludeDirs: [path.join(sourceDir, "api"), destDir],
      });

      expect(result.copied.sort()).toEqual([".env", "api-v2/.env", "api.old/.env", "apiX/.env"]);
      await expect(fs.stat(path.join(destDir, "api", ".env"))).rejects.toThrow();
    });

    // glob refuses to traverse a symlinked directory only for `**`; a literal
    // segment or a single-star one resolves straight through it.
    it("excludes a checkout the walk reaches through an alias symlink, and nothing the alias does not name", async () => {
      for (const dir of ["api", "web"]) {
        await fs.mkdir(path.join(sourceDir, dir, "src"), { recursive: true });
        await fs.writeFile(path.join(sourceDir, dir, ".env"), `${dir} secret`);
        await fs.writeFile(path.join(sourceDir, dir, "src", ".env"), `${dir} deep secret`);
      }
      await fs.writeFile(path.join(sourceDir, ".env"), "intended");
      await fs.symlink(path.join(sourceDir, "api"), path.join(sourceDir, "current"));
      await fs.symlink(path.join(sourceDir, "api", "src"), path.join(sourceDir, "api-src"));
      await fs.symlink(path.join(sourceDir, "web"), path.join(sourceDir, "web-alias"));

      const result = await service.copyFiles(sourceDir, destDir, [".env", "*/.env", "current/.env", "*/*/.env"], {
        excludeDirs: [path.join(sourceDir, "api"), destDir],
      });

      expect(result.copied.sort()).toEqual([
        ".env",
        "web-alias/.env",
        "web-alias/src/.env",
        "web/.env",
        "web/src/.env",
      ]);
      for (const alias of ["current", "api-src", "api"]) {
        await expect(fs.stat(path.join(destDir, alias))).rejects.toThrow();
      }
    });

    it("excludes a checkout that is itself a symlink pointing out of the source directory", async () => {
      // `worktreeDir: <config dir>/api`, where that name is a symlink onto
      // another disk. Canonicalizing it alone puts it outside the source and
      // loses it; the walk still reaches it under the name the config spelled.
      await fs.mkdir(path.join(tempDir, "elsewhere", "api"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "elsewhere", "api", ".env"), "API_SECRET=1");
      await fs.symlink(path.join(tempDir, "elsewhere", "api"), path.join(sourceDir, "api"));
      await fs.writeFile(path.join(sourceDir, ".env"), "intended");

      const result = await service.copyFiles(sourceDir, destDir, [".env", "*/.env", "api/.env"], {
        excludeDirs: [path.join(sourceDir, "api"), destDir],
      });

      expect(result.copied).toEqual([".env"]);
      await expect(fs.stat(path.join(destDir, "api"))).rejects.toThrow();
    });

    // Both spellings of the same checkout are directories the walk can spell
    // out, and it reaches each of them under a different name: canonicalizing
    // alone loses `link/api`, taking the config's own string alone loses
    // `real/api`, and the alias `link` itself must survive either way because
    // it holds more than the excluded checkout.
    it("excludes a checkout named through a symlinked parent under both the name given and the real one", async () => {
      for (const dir of ["api", "web"]) {
        await fs.mkdir(path.join(sourceDir, "real", dir), { recursive: true });
        await fs.writeFile(path.join(sourceDir, "real", dir, ".env"), dir);
      }
      await fs.symlink(path.join(sourceDir, "real"), path.join(sourceDir, "link"));

      const result = await service.copyFiles(sourceDir, destDir, ["*/*/.env"], {
        excludeDirs: [path.join(sourceDir, "link", "api"), destDir],
      });

      expect(result.copied.sort()).toEqual(["link/web/.env", "real/web/.env"]);
      await expect(fs.stat(path.join(destDir, "link", "api"))).rejects.toThrow();
      await expect(fs.stat(path.join(destDir, "real", "api"))).rejects.toThrow();
    });

    // An alias onto a checkout's parent, or onto the source itself, leaves the
    // checkout's own node an ordinary directory under a name the config file
    // never spelled — so the test has to be on what a directory is, not on
    // whether the walk stepped through a link to reach it.
    it("excludes a checkout reached through an alias onto its parent or onto the source", async () => {
      for (const dir of ["api", "web", "tools"]) {
        await fs.mkdir(path.join(sourceDir, "repos", dir), { recursive: true });
        await fs.writeFile(path.join(sourceDir, "repos", dir, ".env"), `${dir} secret`);
      }
      await fs.writeFile(path.join(sourceDir, ".env"), "intended");
      await fs.symlink(path.join(sourceDir, "repos"), path.join(sourceDir, "current"));
      await fs.symlink(".", path.join(sourceDir, "self"));

      const result = await service.copyFiles(sourceDir, destDir, [".env", "*/*/.env", "self/*/*/.env"], {
        excludeDirs: [path.join(sourceDir, "repos", "api"), path.join(sourceDir, "repos", "web"), destDir],
      });

      // `tools` is not excluded, so both aliases stay readable for what they
      // legitimately expose — the exclusions take away the two checkouts only.
      // The `self/self/...` entries are the source's own root `.env` reached
      // back through the alias, which is the file the patterns asked for.
      expect(result.copied.sort()).toEqual([
        ".env",
        "current/tools/.env",
        "repos/tools/.env",
        "self/current/tools/.env",
        "self/repos/tools/.env",
        "self/self/.env",
        "self/self/self/.env",
      ]);
      for (const leaked of ["repos/api", "repos/web", "current/api", "self/repos/api", "self/current/api"]) {
        await expect(fs.stat(path.join(destDir, leaked, ".env"))).rejects.toThrow();
      }
    });

    // Worktree mode reaches this on every run: the copy source is one worktree
    // inside the repository's own worktreeDir, and the caller lists that
    // worktreeDir. Every path in the source resolves into it, alias or not.
    it("keeps the source readable around an exclusion that contains it", async () => {
      const trees = path.join(tempDir, "trees");
      const source = path.join(trees, "main-abc");
      await fs.mkdir(path.join(source, "deep", "nested"), { recursive: true });
      await fs.writeFile(path.join(source, ".env"), "shared");
      await fs.writeFile(path.join(source, "deep", "nested", ".env"), "nested");
      await fs.symlink(path.join(source, "deep", "nested"), path.join(source, "alias"));

      const dest = path.join(trees, "feat");
      const result = await service.copyFiles(source, dest, [".env", "*/.env"], {
        excludeDirs: [dest, trees, path.join(tempDir, ".bare", "repo")],
      });

      expect(result.copied.sort()).toEqual([".env", "alias/.env"]);
    });

    // The one shape the canonical rule cannot reach: the excluded name is spelled
    // INSIDE the source but resolves to an ancestor of it. Canonicalizing that
    // entry yields a directory containing the source, which buildExcludedDirs
    // drops on purpose — honouring it would silence the whole copy — so the
    // lexical spelling is the only thing left holding the walk out of the alias.
    it("excludes a name spelled inside the source that resolves to an ancestor of it", async () => {
      const trees = path.join(tempDir, "trees");
      const source = path.join(trees, "main-abc");
      await fs.mkdir(path.join(trees, "other"), { recursive: true });
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, ".env"), "intended");
      await fs.writeFile(path.join(trees, "other", ".env"), "a sibling worktree's");
      await fs.symlink(trees, path.join(source, "up"));

      const dest = path.join(trees, "feat");
      const result = await service.copyFiles(source, dest, [".env", "*/*/.env"], {
        excludeDirs: [path.join(source, "up"), dest],
      });

      expect(result.copied).toEqual([".env"]);
      await expect(fs.stat(path.join(dest, "up"))).rejects.toThrow();
    });

    it("excludes a checkout that a pattern names outright, not only one a recursive pattern reaches", async () => {
      await fs.mkdir(path.join(sourceDir, "api", "src"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, ".env"), "intended");
      await fs.writeFile(path.join(sourceDir, "api", ".env"), "foreign secret");
      await fs.writeFile(path.join(sourceDir, "api", "src", ".env"), "foreign secret");

      const result = await service.copyFiles(sourceDir, destDir, [".env", "api/.env", "api/**/.env"], {
        excludeDirs: [path.join(sourceDir, "api"), destDir],
      });

      expect(result.copied).toEqual([".env"]);
      await expect(fs.stat(path.join(destDir, "api"))).rejects.toThrow();
    });
  });
});
