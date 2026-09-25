import * as fs from "fs/promises";
import * as path from "path";

import { ENV_CONSTANTS, GIT_CONSTANTS } from "../constants";
import { getErrorMessage } from "../utils/errors";
import { isGitLfsInstalled, isLfsSmudgeSkippedByEnv, warnGitLfsMissingOnce } from "../utils/git-lfs-probe";

import type { GitServiceContext } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { SimpleGit } from "simple-git";

// How many of a worktree's LFS files are read back after a checkout. The check
// answers "did the smudge filter run here at all", which a sample settles just
// as well as reading every file.
const LFS_VERIFICATION_SAMPLE_SIZE = 5;

// The `.gitattributes` entry that hands a path to git-lfs. A repository whose
// HEAD declares none never had LFS content, so nothing about LFS is worth
// running (or warning about) for it.
const LFS_FILTER_ATTRIBUTE = "filter=lfs";

// How many tree oids keep their "declares an LFS filter" verdict. The entries
// are content-addressed and can never go stale, so this only bounds memory in a
// daemon that runs for weeks.
const LFS_ATTRIBUTE_CACHE_LIMIT = 256;

/**
 * Checks that a checkout actually materialized a repository's LFS content
 * rather than leaving git-lfs pointer files behind. Part of GitService: it
 * reads GitService's cached clients and LFS setting through the shared context.
 */
export class LfsVerificationService {
  // Tree oid -> whether that tree's .gitattributes declare an LFS filter.
  private lfsAttributeCache = new Map<string, boolean>();

  constructor(private readonly ctx: GitServiceContext) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  // Verification only means something when the checkout was meant to
  // materialize LFS content. `skipLfs` (configured, or the per-sync override
  // after an LFS checkout failure) and a GIT_LFS_SKIP_SMUDGE inherited from the
  // shell or the CI job both make pointer files on disk the expected outcome —
  // not a fault to sample for, and not something to warn about.
  private isLfsVerificationDisabled(): boolean {
    return this.ctx.isLfsSkipEnabled() || isLfsSmudgeSkippedByEnv();
  }

  // One look at what `git worktree add` (or, in clone mode, `git clone`) just
  // checked out: `git checkout` — git-lfs delayed checkout and the
  // post-checkout hook included — completes before the command returns, so
  // nothing rewrites those files afterwards and the first read is already the
  // final answer. Earlier releases re-read the samples once a second for up to
  // 30 s per created worktree, serialized across branches, which turned a first
  // sync of 100 branches whose LFS content stayed pointers (an exported
  // GIT_LFS_SKIP_SMUDGE, an `lfs.fetchexclude` pattern, an LFS server outage)
  // into ~50 minutes of sleeping and 100 warnings.
  async verifyLfsFilesDownloaded(worktreePath: string, branchName: string): Promise<void> {
    if (this.isLfsVerificationDisabled()) return;

    const worktreeGit = this.ctx.config.sparseCheckout
      ? // `lfs ls-files` reads the index and .gitattributes — a local command,
        // so no inactivity kill, same as the cached client used otherwise.
        this.ctx.uncachedGit(worktreePath, {
          useLfsSkip: false,
          extraEnv: { [ENV_CONSTANTS.GIT_ATTR_SOURCE]: "HEAD" },
          blockMs: 0,
        })
      : this.ctx.localGit(worktreePath);

    try {
      if (!(await this.headDeclaresLfsFilter(worktreeGit))) return;

      // Only repositories that actually use LFS get here, so a machine without
      // git-lfs is worth one warning per process — never one per worktree, and
      // never at all for the repositories that have no LFS content.
      if (!(await isGitLfsInstalled(() => worktreeGit.raw(["lfs", "version"])))) {
        warnGitLfsMissingOnce((message) => this.logger.warn(message));
        return;
      }

      const lfsFiles = await this.listCheckedOutLfsFiles(worktreeGit, worktreePath);
      if (lfsFiles.length === 0) return;

      if (this.ctx.config.debug) {
        this.logger.info(`  - Verifying ${lfsFiles.length} LFS files are downloaded...`);
      }

      const samples = LfsVerificationService.sampleFiles(lfsFiles, LFS_VERIFICATION_SAMPLE_SIZE);
      const pointers = await LfsVerificationService.findPointerFiles(worktreePath, samples);

      if (pointers.length === 0) {
        if (this.ctx.config.debug) {
          this.logger.info(`  - ✅ LFS files verified (${samples.length} samples checked)`);
        }
        return;
      }

      this.logger.warn(
        `  - ⚠️ LFS content was not downloaded into '${worktreePath}': ${pointers.join(", ")} still hold git-lfs ` +
          `pointer files. Check that git-lfs can fetch this repository's objects (credentials, \`lfs.fetchexclude\`, ` +
          `a GIT_LFS_SKIP_SMUDGE exported in this environment), or set 'skipLfs: true' for it to keep pointers on purpose.`,
      );
    } catch (error) {
      this.logger.warn(`  - ⚠️ Warning: Could not verify LFS files for '${branchName}': ${String(error)}`);
    }
  }

  // Whether HEAD declares an LFS filter in any .gitattributes. A repository
  // that never used LFS answers no, and then no `git lfs ls-files` walks its
  // whole index for every worktree created.
  //
  // Cached by the tree oid HEAD points at: a tree's content is its name, so an
  // entry is right forever — no per-sync invalidation to get wrong in a daemon
  // that runs for weeks — and branches sharing a tree share the answer.
  private async headDeclaresLfsFilter(git: SimpleGit): Promise<boolean> {
    let treeOid: string;
    try {
      treeOid = (await git.revparse(["HEAD^{tree}"])).trim();
    } catch {
      // No resolvable HEAD (an unborn branch, a checkout that never landed)
      // means there are no checked-out files to verify.
      return false;
    }

    const cached = this.lfsAttributeCache.get(treeOid);
    if (cached !== undefined) return cached;

    const declaresFilter = await LfsVerificationService.treeDeclaresLfsFilter(git, treeOid);
    if (this.lfsAttributeCache.size >= LFS_ATTRIBUTE_CACHE_LIMIT) {
      const oldest = this.lfsAttributeCache.keys().next();
      if (!oldest.done) this.lfsAttributeCache.delete(oldest.value);
    }
    this.lfsAttributeCache.set(treeOid, declaresFilter);
    return declaresFilter;
  }

  // Greps the tree rather than the working copy: with sparse checkout most
  // .gitattributes files are not on disk, and the pathspec keeps the search to
  // those files wherever in the tree they sit.
  private static async treeDeclaresLfsFilter(git: SimpleGit, treeOid: string): Promise<boolean> {
    try {
      const matches = await git.raw([
        "grep",
        "--name-only",
        "-I",
        "--fixed-strings",
        "-e",
        LFS_FILTER_ATTRIBUTE,
        treeOid,
        "--",
        "*.gitattributes",
      ]);
      return matches.trim().length > 0;
    } catch (error) {
      // Exit 1 is `git grep`'s "nothing matched" — a definite no. Any other
      // failure leaves the question open, and verifying is the safe answer.
      return !getErrorMessage(error).includes(GIT_CONSTANTS.GIT_NO_MATCH_EXIT);
    }
  }

  // The LFS files that are actually on disk. With sparse checkout,
  // GIT_ATTR_SOURCE=HEAD lists every LFS file HEAD's .gitattributes declare,
  // including ones outside the cone that were never written — sampling those
  // would report a checkout failure that never happened.
  private async listCheckedOutLfsFiles(git: SimpleGit, worktreePath: string): Promise<string[]> {
    const listed = (await git.raw(["lfs", "ls-files", "--name-only"]))
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (!this.ctx.config.sparseCheckout || listed.length === 0) return listed;

    const existence = await Promise.all(
      listed.map(async (f) => {
        try {
          await fs.access(path.join(worktreePath, f));
          return f;
        } catch {
          return null;
        }
      }),
    );
    return existence.filter((f): f is string => f !== null);
  }

  // Up to `count` distinct files, picked with a partial Fisher-Yates shuffle so
  // a repeated sync does not keep checking the same ones.
  private static sampleFiles(files: string[], count: number): string[] {
    const sampleSize = Math.min(count, files.length);
    const shuffled = [...files];
    for (let i = 0; i < sampleSize; i++) {
      const randomIndex = i + Math.floor(Math.random() * (shuffled.length - i));
      [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
    }
    return shuffled.slice(0, sampleSize);
  }

  // The sampled files that still hold a pointer, plus any that cannot be read
  // at all: both mean the checkout did not materialize the content.
  private static async findPointerFiles(worktreePath: string, files: string[]): Promise<string[]> {
    const pointers: string[] = [];
    for (const file of files) {
      if (await LfsVerificationService.holdsLfsPointer(path.join(worktreePath, file))) {
        pointers.push(file);
      }
    }
    return pointers;
  }

  // Reads the first bytes only: a pointer is a small text blob starting with
  // the git-lfs spec header, while the real content can be gigabytes.
  private static async holdsLfsPointer(filePath: string): Promise<boolean> {
    try {
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(200);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8").startsWith(GIT_CONSTANTS.LFS_HEADER);
      } finally {
        await handle.close();
      }
    } catch {
      return true;
    }
  }
}
