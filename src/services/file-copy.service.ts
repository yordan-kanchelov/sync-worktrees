import * as fs from "fs/promises";
import * as path from "path";

import { glob } from "glob";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { fileExists } from "../utils/file-exists";
import { isPathEqualOrInside, isPathStrictlyInside } from "../utils/path-compare";

import { PathResolutionService } from "./path-resolution.service";

import type { IgnoreLike, Path } from "glob";

// Never read from: build output and dependency trees, and every directory this
// tool creates for its own bookkeeping. The second group matters because the
// copy source is normally the config file's directory, which in the documented
// layout is the parent of every checkout — so a recursive pattern reaches a
// bare repository's object store (`.bare/`), a trashed worktree still waiting
// out its retention window (`.trash/`, plus the pre-trash `.removed/` and
// `.diverged/`), the per-config removal audit log (`.sync-worktrees-state/`)
// and the cross-process lock files (`.sync-worktrees-locks/`). Names, not
// paths, so this layer holds even for a caller that cannot see the config.
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

/** CopyIgnore compares against `Path.relativePosix()`, which is always `/`-joined. */
function toPosixPath(relative: string): string {
  return relative.split(path.sep).join("/");
}

/**
 * The excluded directories in the two forms {@link CopyIgnore} needs: the paths
 * the walk will spell them as, and the paths they actually are.
 */
interface ExcludedDirs {
  /** Posix paths relative to the glob's `cwd`, compared segment by segment. */
  readonly relativePaths: ReadonlySet<string>;
  /** Canonical absolute paths, compared against what a walked directory is. */
  readonly realPaths: readonly string[];
}

/**
 * Decides what the expansion is allowed to read.
 *
 * glob accepts `ignore` either as glob patterns or as an object like this one,
 * and the excluded checkouts have to go through the object: they are paths,
 * and there is no spelling of a path as a pattern that survives. glob's own
 * `Ignore` class rebuilds every ignore string it is handed from the parsed
 * `Minimatch.globParts`, and that round-trip turns an escaped `\{` back into a
 * live brace — so a checkout named `{a,b}` is brace-expanded into `a` and `b`
 * however it was escaped, leaving its own files readable and two unrelated
 * directories pruned. Comparing path segments is exact for every name.
 */
class CopyIgnore implements IgnoreLike {
  constructor(
    private readonly dirNames: ReadonlySet<string>,
    private readonly excluded: ExcludedDirs,
  ) {}

  /**
   * Rejects a candidate match under an excluded directory. Load-bearing for a
   * pattern that names one outright (`api/.env`): childrenIgnored never sees
   * that path, because glob resolves a literal segment without reading `api`.
   */
  ignored(p: Path): boolean {
    return this.hitsExcludedDir(p.parent, this.depth(p) - 1);
  }

  /**
   * Stops the walk at the top of an excluded directory instead of reading it
   * and discarding the matches — glob gates every descent on this (see
   * `#childrenIgnored` in glob's walker). Same verdict as ignored(), so it
   * changes how much is read, never what comes out.
   */
  childrenIgnored(p: Path): boolean {
    return this.hitsExcludedDir(p, this.depth(p));
  }

  /** How many path segments separate `p` from the glob's `cwd`. */
  private depth(p: Path): number {
    const relative = p.relative();
    return relative ? relative.split(/[\\/]+/).length : 0;
  }

  /** Walks `dir` and its `levels - 1` ancestors, stopping short of the `cwd`. */
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

  /**
   * Catches an excluded checkout the walk reached under some other name. glob
   * refuses to traverse a symlinked directory only for `**`; a literal segment
   * or a single-star one resolves straight through it. So next to a `current`
   * -> `api` alias, a one-star-then-name pattern reads `api` through `current`
   * however carefully `api` itself is excluded.
   *
   * What the alias points at need not be the checkout: `current` -> `repos`,
   * beside `repos/api`, is reached as `current/api`, whose own node is an
   * ordinary directory and whose name is not one the config file spelled. So
   * the test is on the directory, not on the link — every directory the walk
   * reaches is canonicalized, whatever chain of names led to it, and compared
   * against the canonical exclusions. That covers an alias onto the checkout,
   * onto any ancestor of it, and onto the source directory itself in the one
   * rule.
   *
   * path-scurry caches a node's realpath, so a directory costs one resolution
   * however many patterns, candidate matches and descents walk through it.
   */
  private resolvesIntoExcluded(dir: Path): boolean {
    if (this.excluded.realPaths.length === 0) return false;
    const target = dir.realpathSync()?.fullpath();
    return !!target && this.excluded.realPaths.some((excluded) => isPathEqualOrInside(target, excluded));
  }
}

export interface FileCopyResult {
  copied: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

export interface FileCopyOptions {
  /**
   * Directories the expansion must never read from, on top of
   * {@link DEFAULT_IGNORE_DIR_NAMES} — the caller's own list of checkouts a
   * recursive pattern would otherwise walk into. Entries may be absolute or
   * relative to `sourceDir`, in any spelling; see buildExcludedDirs for how
   * they are compared and which of them survive.
   */
  excludeDirs?: string[];
}

export class FileCopyService {
  constructor(private readonly pathResolution: PathResolutionService = new PathResolutionService()) {}

  /**
   * Copy files matching patterns from source to destination directory.
   * Skips files that already exist at destination.
   * Preserves directory structure relative to source.
   */
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

    const ignore = new CopyIgnore(
      DEFAULT_IGNORE_DIR_NAMES,
      await this.buildExcludedDirs(sourceDir, options.excludeDirs),
    );
    const filesToCopy = await this.expandPatterns(sourceDir, safePatterns, ignore);

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

  /**
   * Turns excluded directories into the two forms {@link CopyIgnore} compares
   * against: paths relative to the glob's own `cwd`, and canonical absolute
   * paths for the walked entries that are symlinks.
   *
   * Each entry is recorded twice, because the name the walk will spell and the
   * directory the name leads to are not always the same one:
   *
   * - lexically, as the config file spells it against the source. This is the
   *   path the walk produces, so it holds even when the checkout is itself a
   *   symlink pointing out of the source directory;
   * - canonically, which is what makes relative, absolute and
   *   symlink-traversing spellings of the same checkout agree. PathResolution
   *   walks up to the deepest component that exists, so a directory not created
   *   yet still resolves, and containment is decided with isPathStrictlyInside
   *   rather than by comparing the strings the config happened to spell.
   *
   * Nested exclusions each produce their own entry, and the outer one already
   * prunes the inner — redundant, never wrong.
   *
   * An entry that contributes no canonical path at all is one that contains the
   * source, the source itself included. Every directory under the source
   * resolves into such an entry, so honouring it would silence the whole copy
   * rather than exclude anything inside it. Worktree mode meets that on every
   * run — its source is one worktree inside the repository's own `worktreeDir`,
   * which the caller lists — and in clone mode a `worktreeDir` can be the
   * config file's own directory. A lexical name is still recorded for such an
   * entry if the config spelled one inside the source (a name in the source
   * that leads back out to an ancestor of it), because that name does pick out
   * a single directory.
   *
   * The canonical path is kept for every other entry, outside the source
   * included, as the one handle on a checkout the walk reaches under a name
   * neither spelling contains — see {@link CopyIgnore.resolvesIntoExcluded}.
   */
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

  private async expandPatterns(sourceDir: string, patterns: string[], ignore: IgnoreLike): Promise<string[]> {
    const allFiles = new Set<string>();

    for (const pattern of patterns) {
      try {
        const matches = await glob(pattern, {
          cwd: sourceDir,
          nodir: true,
          dot: true,
          ignore,
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
