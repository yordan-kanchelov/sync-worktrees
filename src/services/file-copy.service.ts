import * as fs from "fs/promises";
import * as path from "path";

import { glob } from "glob";

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

    const filesToCopy = await this.expandPatterns(sourceDir, patterns);

    for (const relativePath of filesToCopy) {
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

  private async copyFile(sourcePath: string, destPath: string): Promise<boolean> {
    try {
      await fs.access(destPath);
      return false;
    } catch {
      // File doesn't exist, proceed with copy
    }

    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });

    await fs.copyFile(sourcePath, destPath);
    return true;
  }
}
