import * as fs from "fs/promises";
import * as path from "path";

import { glob, hasMagic } from "glob";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { fileExists } from "../utils/file-exists";
import { getErrorMessage } from "../utils/errors";
import { isPathEqualOrInside, isPathStrictlyInside } from "../utils/path-compare";

import { PathResolutionService } from "./path-resolution.service";

import type { IgnoreLike, Path } from "glob";

const DEFAULT_IGNORE_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  PATH_CONSTANTS.GIT_DIR,
  "dist",
  "build",
  ".next",
  "coverage",
  GIT_CONSTANTS.BARE_DIR_NAME,
  GIT_CONSTANTS.TRASH_DIR_NAME,
  GIT_CONSTANTS.REMOVED_DIR_NAME,
  GIT_CONSTANTS.DIVERGED_DIR_NAME,
  PATH_CONSTANTS.STATE_DIR_NAME,
  PATH_CONSTANTS.LOCK_DIR_NAME,
]);

const NO_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set();

const MAGIC_UNDER_GLOBS_PARSE = { nonegate: true, nocomment: true, magicalBraces: false } as const;

function wandersBeyondWhatItSpells(pattern: string): boolean {
  return hasMagic(pattern, MAGIC_UNDER_GLOBS_PARSE);
}

function toPosixPath(relative: string): string {
  return relative.split(path.sep).join("/");
}

interface ExcludedDirs {
  readonly relativePaths: ReadonlySet<string>;
  readonly realPaths: readonly string[];
}

class CopyIgnore implements IgnoreLike {
  constructor(
    private readonly dirNames: ReadonlySet<string>,
    private readonly excluded: ExcludedDirs,
  ) {}

  ignored(p: Path): boolean {
    return this.hitsExcludedDir(p.parent, this.depth(p) - 1);
  }

  childrenIgnored(p: Path): boolean {
    return this.hitsExcludedDir(p, this.depth(p));
  }

  private depth(p: Path): number {
    const relative = p.relative();
    return relative ? relative.split(/[\\/]+/).length : 0;
  }

  private hitsExcludedDir(dir: Path | undefined, levels: number): boolean {
    let node = dir;
    for (let i = 0; i < levels && node; i++) {
      if (this.dirNames.has(node.name)) return true;
      if (this.excluded.relativePaths.has(node.relativePosix())) return true;
      if (this.resolvesIntoExcluded(node)) return true;
      node = node.parent;
    }
    return false;
  }

  private resolvesIntoExcluded(dir: Path): boolean {
    if (this.excluded.realPaths.length === 0 || !this.reachedThroughLink(dir)) return false;
    const target = dir.realpathSync()?.fullpath();
    return !!target && this.excluded.realPaths.some((excluded) => isPathEqualOrInside(target, excluded));
  }

  private reachedThroughLink(dir: Path): boolean {
    for (let node: Path | undefined = dir; node && node.relative(); node = node.parent) {
      if (node.isSymbolicLink() || node.isUnknown()) return true;
    }
    return false;
  }
}

export interface FileCopyResult {
  copied: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

export interface FileCopyOptions {
  excludeDirs?: string[];
}

export class FileCopyService {
  constructor(private readonly pathResolution: PathResolutionService = new PathResolutionService()) {}

  async copyFiles(
    sourceDir: string,
    destDir: string,
    patterns: string[],
    options: FileCopyOptions = {},
  ): Promise<FileCopyResult> {
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

    const excluded = await this.buildExcludedDirs(sourceDir, options.excludeDirs);
    const filesToCopy = await this.expandPatterns(sourceDir, safePatterns, excluded, result);

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

  private async buildExcludedDirs(sourceDir: string, excludeDirs?: string[]): Promise<ExcludedDirs> {
    const relativePaths = new Set<string>();
    const realPaths: string[] = [];
    if (!excludeDirs?.length) return { relativePaths, realPaths };

    const absoluteSource = path.resolve(sourceDir);
    const canonicalSource = await this.pathResolution.resolveBaseDir(sourceDir);

    for (const dir of excludeDirs) {
      if (!dir) continue;
      const absolute = path.resolve(absoluteSource, dir);

      const lexical = path.relative(absoluteSource, absolute);
      if (lexical && !lexical.split(path.sep).includes("..")) relativePaths.add(toPosixPath(lexical));

      const canonical = await this.pathResolution.resolveBaseDir(absolute);
      if (isPathStrictlyInside(canonical, canonicalSource)) {
        relativePaths.add(toPosixPath(path.relative(canonicalSource, canonical)));
      }
      if (!isPathEqualOrInside(canonicalSource, canonical)) realPaths.push(canonical);
    }

    return { relativePaths, realPaths };
  }

  private async expandPatterns(
    sourceDir: string,
    patterns: string[],
    excluded: ExcludedDirs,
    result: FileCopyResult,
  ): Promise<string[]> {
    const allFiles = new Set<string>();
    const wanderingIgnore = new CopyIgnore(DEFAULT_IGNORE_DIR_NAMES, excluded);
    const literalIgnore = new CopyIgnore(NO_IGNORED_DIR_NAMES, excluded);

    for (const pattern of patterns) {
      try {
        const matches = await glob(pattern, {
          cwd: sourceDir,
          nodir: true,
          dot: true,
          ignore: wandersBeyondWhatItSpells(pattern) ? wanderingIgnore : literalIgnore,
        });

        for (const match of matches) {
          allFiles.add(match);
        }
      } catch (error) {
        result.errors.push({ file: pattern, error: getErrorMessage(error) });
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
