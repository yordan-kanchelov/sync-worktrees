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
  });
});
