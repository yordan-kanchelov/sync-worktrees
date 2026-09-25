import * as fs from "fs/promises";
import * as path from "path";

import { glob, hasMagic } from "glob";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { fileExists } from "../utils/file-exists";
import { getErrorMessage } from "../utils/errors";
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

/** What a pattern that spells one path is measured against instead. */
const NO_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set();

/**
 * The options the verdict below is taken under, chosen so that it answers what
 * `glob()` will do with the string rather than what some other parse would.
 *
 * `nonegate` and `nocomment` are glob's, not ours: it forces both on when it
 * builds the Minimatch it expands with, and a bare `hasMagic(pattern)` parses
 * under neither. They disagree exactly where it matters most. `!(dist)/.env`
 * is, to the bare call, a negated literal `(dist)/.env` — no magic, therefore
 * the empty ignore set — while glob reads the same string as an extglob and
 * walks every directory in the source with it, `node_modules` included. A
 * pattern that reaches furthest would be the one trusted most.
 *
 * `magicalBraces` is deliberately off: see {@link wandersBeyondWhatItSpells}.
 */
const MAGIC_UNDER_GLOBS_PARSE = { nonegate: true, nocomment: true, magicalBraces: false } as const;

/**
 * Whether a pattern can reach a path it does not spell out — the question
 * {@link DEFAULT_IGNORE_DIR_NAMES} exists to answer, and the only thing that
 * list is allowed to be applied on the strength of.
 *
 * Braces are a decision, taken here and not by default: `{build,dist}/x.json`
 * counts as spelling its paths, so the default names do not apply to it. Brace
 * expansion turns one string into a fixed list of strings, and every entry of
 * that list is as spelled-out as a pattern with no braces at all — the config
 * file named `build/x.json` and `dist/x.json`, in one line instead of two, and
 * answering either with silence because a directory on the way is called
 * `build` is the defect this whole distinction exists to fix. It is safe as
 * well as consistent, because `hasMagic` expands the braces and judges each
 * alternative on its own: a single alternative with magic of its own — a star
 * in one of them, as in `{build,dist}` followed by a recursive tail — makes
 * the whole pattern wandering. What this lets through is only the pattern
 * whose every alternative is itself a path.
 */
function wandersBeyondWhatItSpells(pattern: string): boolean {
  return hasMagic(pattern, MAGIC_UNDER_GLOBS_PARSE);
}

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
  /**
   * @param dirNames Names no pattern may descend into. Empty for a pattern that
   *   spells one path: see {@link FileCopyService.expandPatterns}.
   * @param excluded The caller's checkouts, applied to every pattern.
   */
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
   * Directories the expansion must never read from — the caller's own list of
   * checkouts a pattern would otherwise walk into. Unlike
   * {@link DEFAULT_IGNORE_DIR_NAMES}, which only a pattern with glob magic is
   * measured against, these hold for every pattern: a literal path is exactly
   * how one reaches into another repository's working tree. Entries may be
   * absolute or relative to `sourceDir`, in any spelling; see buildExcludedDirs
   * for how they are compared and which of them survive.
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

  /**
   * Expands every pattern against the source directory, collecting the matches
   * and reporting the patterns that could not be expanded at all.
   *
   * {@link DEFAULT_IGNORE_DIR_NAMES} exists for the pattern that wanders: a
   * recursive or wildcard one reaches whatever happens to sit under the source,
   * and reading a dependency tree or a bare repository's object store is never
   * what it was written for. A pattern with no magic in it wanders nowhere — it
   * is the one path the config file spelled, and answering it with silence
   * because a directory along the way is called `build` overrides the only
   * person who knows what that file is. So the default names apply to the first
   * kind of pattern and not to the second.
   *
   * The verdict is glob's own `hasMagic`, taken under the options glob parses
   * with (see {@link MAGIC_UNDER_GLOBS_PARSE} and
   * {@link wandersBeyondWhatItSpells}), so "wanders" means exactly what the
   * expansion will do with the string rather than whether it contains a
   * character that can be magic. It still parts company with the text of the
   * pattern over a class that admits one character: `a[1].json` wanders
   * nowhere by that test — it can only ever produce `a1.json` — and glob still
   * reads it as a class, so it names `a1.json` and not a file whose name
   * contains the brackets. Escape the brackets (`a\[1\].json`) to name that
   * file; neither spelling wanders, so which of the two it is never changes
   * whether the default names apply.
   *
   * The caller's excluded checkouts are not part of that trade. They are the
   * other repositories' working trees and the directory being filled, and a
   * literal path is exactly how a pattern reaches into one.
   */
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
        // A pattern that cannot be expanded is a pattern that copies nothing,
        // which is indistinguishable from one that matched nothing unless it
        // is reported. The caller turns these into log lines. The verdict is
        // taken inside this try as well, so a pattern minimatch refuses to
        // parse at all -- one over its 64 KiB ceiling -- is reported here too
        // rather than ending the whole pass.
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
