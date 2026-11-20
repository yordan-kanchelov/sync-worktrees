import * as fs from "fs/promises";
import * as path from "path";

import { ENV_CONSTANTS, GIT_CONSTANTS } from "../constants";
import { isGitLfsInstalled, isLfsSmudgeSkippedByEnv, warnGitLfsMissingOnce } from "../utils/git-lfs-probe";

import type { GitServiceContext } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { SimpleGit } from "simple-git";

const LFS_VERIFICATION_SAMPLE_SIZE = 5;

const LFS_FILTER_ATTRIBUTE = "filter=lfs";

const LFS_ATTRIBUTE_CACHE_LIMIT = 256;

export class LfsVerificationService {
  private lfsAttributeCache = new Map<string, boolean>();

  constructor(private readonly ctx: GitServiceContext) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  private isLfsVerificationDisabled(): boolean {
    return this.ctx.isLfsSkipEnabled() || isLfsSmudgeSkippedByEnv();
  }

  async verifyLfsFilesDownloaded(worktreePath: string, branchName: string): Promise<void> {
    if (this.isLfsVerificationDisabled()) return;

    const worktreeGit = this.ctx.config.sparseCheckout
      ? this.ctx.uncachedGit(worktreePath, {
          useLfsSkip: false,
          extraEnv: { [ENV_CONSTANTS.GIT_ATTR_SOURCE]: "HEAD" },
          blockMs: 0,
        })
      : this.ctx.localGit(worktreePath);

    try {
      if (!(await this.headDeclaresLfsFilter(worktreeGit))) return;

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

  private async headDeclaresLfsFilter(git: SimpleGit): Promise<boolean> {
    let treeOid: string;
    try {
      treeOid = (await git.revparse(["HEAD^{tree}"])).trim();
    } catch {
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
    } catch {
      return true;
    }
  }

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

  private static sampleFiles(files: string[], count: number): string[] {
    const sampleSize = Math.min(count, files.length);
    const shuffled = [...files];
    for (let i = 0; i < sampleSize; i++) {
      const randomIndex = i + Math.floor(Math.random() * (shuffled.length - i));
      [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
    }
    return shuffled.slice(0, sampleSize);
  }

  private static async findPointerFiles(worktreePath: string, files: string[]): Promise<string[]> {
    const pointers: string[] = [];
    for (const file of files) {
      if (await LfsVerificationService.holdsLfsPointer(path.join(worktreePath, file))) {
        pointers.push(file);
      }
    }
    return pointers;
  }

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
