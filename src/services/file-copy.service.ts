import * as fs from "fs/promises";
import * as path from "path";

import { glob } from "glob";

import { fileExists } from "../utils/file-exists";

const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
];

export interface FileCopyResult {
  copied: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

export class FileCopyService {
  /**
   * Copy files matching patterns from source to destination directory.
   * Skips files that already exist at destination.
   * Preserves directory structure relative to source.
   */
  async copyFiles(sourceDir: string, destDir: string, patterns: string[]): Promise<FileCopyResult> {
    const result: FileCopyResult = {
      copied: [],
      skipped: [],
      errors: [],
    };

    if (!patterns || patterns.length === 0) {
      return result;
    }

    const safePatterns = patterns.filter((pattern) => {
      if (!this.isSafeRelativePath(pattern)) {
        result.errors.push({ file: pattern, error: "Pattern must be relative and stay inside source directory" });
        return false;
      }
      return true;
    });

    const filesToCopy = await this.expandPatterns(sourceDir, safePatterns);

    for (const relativePath of filesToCopy) {
      if (!this.isSafeRelativePath(relativePath)) {
        result.errors.push({ file: relativePath, error: "Matched file must stay inside source directory" });
        continue;
      }

      const sourcePath = path.join(sourceDir, relativePath);
      const destPath = path.join(destDir, relativePath);

      try {
        const copied = await this.copyFile(sourcePath, destPath);
        if (copied) {
          result.copied.push(relativePath);
        } else {
          result.skipped.push(relativePath);
        }
      } catch (error) {
        result.errors.push({
          file: relativePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  private async expandPatterns(sourceDir: string, patterns: string[]): Promise<string[]> {
    const allFiles = new Set<string>();

    for (const pattern of patterns) {
      try {
        const matches = await glob(pattern, {
          cwd: sourceDir,
          nodir: true,
          dot: true,
          ignore: DEFAULT_IGNORE_PATTERNS,
        });

        for (const match of matches) {
          allFiles.add(match);
        }
      } catch {
        // Pattern matching failed, skip silently
      }
    }

    return Array.from(allFiles);
  }

  private isSafeRelativePath(filePath: string): boolean {
    return !path.isAbsolute(filePath) && !filePath.split(/[\\/]+/).includes("..");
  }

  private async copyFile(sourcePath: string, destPath: string): Promise<boolean> {
    if (await fileExists(destPath)) {
      return false;
    }

    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });

    await fs.copyFile(sourcePath, destPath);
    return true;
  }
}
