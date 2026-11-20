import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, GitOperationError } from "../errors";
import { getErrorMessage } from "../utils/errors";
import { fileExists, probePathExists } from "../utils/file-exists";
import { normalizeRepoUrlForComparison, redactRepoUrl } from "../utils/git-url";

import type { BranchRefService } from "./branch-ref.service";
import type { GitServiceContext } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { SimpleGit } from "simple-git";

type BareCloneDestination = "missing" | "empty" | "recovered" | "unverifiable";

const BRANCH_DELETE_BATCH_SIZE = 200;

export class BareRepoService {
  constructor(
    private readonly ctx: GitServiceContext,
    private readonly branchRefs: BranchRefService,
  ) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  async ensureBareRepository(): Promise<void> {
    const { repoUrl } = this.ctx.config;
    const bareRepoPath = this.ctx.bareRepoPath;

    let bareRepoExists: boolean;
    try {
      await fs.access(path.join(bareRepoPath, "HEAD"));
      bareRepoExists = true;
    } catch {
      bareRepoExists = false;
    }

    if (bareRepoExists) {
      await this.clearBareClonePendingMarker();
      await this.assertBareRepoOriginMatches(this.ctx.localGit(bareRepoPath));
    } else {
      const destination = await this.prepareBareCloneDestination();
      this.logger.info(`Cloning from "${redactRepoUrl(repoUrl)}" as bare repository into "${bareRepoPath}"...`);
      await fs.mkdir(path.dirname(bareRepoPath), { recursive: true });
      if (destination !== "unverifiable") await this.writeBareClonePendingMarker();
      const cloneGit = this.ctx.uncachedGit(undefined, {
        useLfsSkip: this.ctx.isLfsSkipEnabled(),
        blockMs: this.ctx.cloneTimeoutMs(),
      });
      try {
        await cloneGit.clone(repoUrl, bareRepoPath, ["--bare", "--progress"]);
      } catch (error) {
        await this.releaseBareClonePendingMarkerAfterFailure();
        throw error;
      }
      await this.clearBareClonePendingMarker();
      this.logger.info("✅ Clone successful.");
      await this.dropClonedBranchCopies(this.ctx.localGit(bareRepoPath));
    }

    const bareGit = this.ctx.localGit(bareRepoPath);

    try {
      const existingConfig = await bareGit.raw(["config", "--get-all", "remote.origin.fetch"]);
      if (!existingConfig.includes(GIT_CONSTANTS.FETCH_CONFIG)) {
        await bareGit.addConfig("remote.origin.fetch", GIT_CONSTANTS.FETCH_CONFIG);
      }
    } catch {
      await bareGit.addConfig("remote.origin.fetch", GIT_CONSTANTS.FETCH_CONFIG);
    }
  }

  private getBareClonePendingMarkerPath(): string {
    const resolved = path.resolve(this.ctx.bareRepoPath);
    return path.join(
      path.dirname(resolved),
      `${path.basename(resolved)}${PATH_CONSTANTS.BARE_CLONE_PENDING_MARKER_SUFFIX}`,
    );
  }

  private async writeBareClonePendingMarker(): Promise<void> {
    try {
      await fs.writeFile(this.getBareClonePendingMarkerPath(), new Date().toISOString());
    } catch (error) {
      this.logger.warn(`Could not write the bare-clone pending marker: ${getErrorMessage(error)}`);
    }
  }

  private async clearBareClonePendingMarker(): Promise<void> {
    const markerPath = this.getBareClonePendingMarkerPath();
    if (!(await fileExists(markerPath))) return;
    try {
      await fs.unlink(markerPath);
    } catch (error) {
      this.logger.debug(`Could not remove the bare-clone pending marker at '${markerPath}': ${getErrorMessage(error)}`);
    }
  }

  private async releaseBareClonePendingMarkerAfterFailure(): Promise<void> {
    const probe = await probePathExists(this.ctx.bareRepoPath);
    if (probe === "unknown") return;
    if (probe === "exists" && (await this.listBareRepoDir()).entries?.length !== 0) return;
    await this.clearBareClonePendingMarker();
  }

  private async prepareBareCloneDestination(): Promise<BareCloneDestination> {
    const probe = await probePathExists(this.ctx.bareRepoPath);
    if (probe === "missing") return "missing";
    if (probe === "unknown") return "unverifiable";

    const bareRepoPath = path.resolve(this.ctx.bareRepoPath);
    if (await fileExists(this.getBareClonePendingMarkerPath())) {
      this.logger.warn(
        `Bare repository at '${bareRepoPath}' has no HEAD and still carries this tool's clone-in-progress marker ` +
          `(a leftover of an interrupted initialization). Removing it and cloning again.`,
      );
      try {
        await fs.rm(this.ctx.bareRepoPath, { recursive: true, force: true });
      } catch (error) {
        throw new GitOperationError(
          "clone",
          `could not remove the interrupted bare clone at '${bareRepoPath}': ${getErrorMessage(error)}. ` +
            `Remove the directory manually and run again.`,
          error instanceof Error ? error : undefined,
        );
      }
      return "recovered";
    }

    const { entries, error } = await this.listBareRepoDir();
    if (!entries) {
      if (error?.code === "ENOENT") return "missing";
      throw new ConfigError(
        `Cannot clone into '${bareRepoPath}': it already exists and could not be inspected ` +
          `(${getErrorMessage(error)}). Remove it, or point bareRepoDir at a fresh path.`,
        "BARE_DESTINATION_UNREADABLE",
      );
    }

    if (entries.length > 0) {
      throw new ConfigError(
        `Cannot clone into '${bareRepoPath}': the directory exists, has no HEAD (it is not a git repository) ` +
          `and was not created by sync-worktrees. Inspect it and remove it, or point bareRepoDir at a fresh path.`,
        "BARE_DESTINATION_NOT_EMPTY",
      );
    }
    return "empty";
  }

  private async listBareRepoDir(): Promise<{ entries: string[] | null; error?: NodeJS.ErrnoException }> {
    try {
      return { entries: await fs.readdir(this.ctx.bareRepoPath) };
    } catch (error) {
      return { entries: null, error: error as NodeJS.ErrnoException };
    }
  }

  async assertBareRepoOriginMatches(bareGit: SimpleGit): Promise<void> {
    const bareRepoPath = path.resolve(this.ctx.bareRepoPath);

    let originUrl = "";
    try {
      originUrl = (await bareGit.raw(["config", "--local", "--get", "remote.origin.url"])).trim();
    } catch {}
    if (!originUrl) {
      this.logger.warn(`Could not read 'origin' remote URL from existing bare repository at '${bareRepoPath}'.`);
      return;
    }

    const { repoUrl } = this.ctx.config;
    if (normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(repoUrl)) {
      return;
    }

    const actual = redactRepoUrl(originUrl);
    const expected = redactRepoUrl(repoUrl);
    throw new ConfigError(
      `Existing bare repository at '${bareRepoPath}' has origin '${actual}', expected '${expected}'. ` +
        `Update the remote (git -C "${bareRepoPath}" remote set-url origin <the repoUrl configured for this ` +
        `repository>) or point bareRepoDir at a fresh directory.`,
      "ORIGIN_MISMATCH",
    );
  }

  private async dropClonedBranchCopies(bareGit: SimpleGit): Promise<void> {
    try {
      const headRef = (await bareGit.raw(["symbolic-ref", "-q", "HEAD"])).trim();
      const branches = (await bareGit.raw(["for-each-ref", "--format=%(refname)", GIT_CONSTANTS.REFS.HEADS]))
        .split("\n")
        .map((line) => line.trim())
        .filter((ref) => ref.startsWith(GIT_CONSTANTS.REFS.HEADS) && ref !== headRef)
        .map((ref) => ref.slice(GIT_CONSTANTS.REFS.HEADS.length));
      if (branches.length === 0) return;

      for (let start = 0; start < branches.length; start += BRANCH_DELETE_BATCH_SIZE) {
        await bareGit.raw(["branch", "-D", "--", ...branches.slice(start, start + BRANCH_DELETE_BATCH_SIZE)]);
      }
      this.logger.info(
        `Removed ${branches.length} clone-time local branch ${branches.length === 1 ? "copy" : "copies"}; worktrees are created from origin/* instead.`,
      );
    } catch (error) {
      this.logger.warn(`Could not remove clone-time local branch copies: ${getErrorMessage(error)}`);
    }
  }

  async detectDefaultBranch(bareGit: SimpleGit, options: { readOnly?: boolean } = {}): Promise<string> {
    const remoteBranches = await this.listRemoteBranchNames(bareGit);
    const fromSymref = await this.readOriginHead(bareGit);
    if (fromSymref !== null && (remoteBranches === null || remoteBranches.has(fromSymref))) {
      return fromSymref;
    }

    if (fromSymref !== null) {
      this.logger.info(
        `origin/HEAD points at '${fromSymref}', which no longer exists on origin; asking origin for its default branch...`,
      );
    }
    try {
      const networkGit = this.ctx.networkGit(this.ctx.bareRepoPath);
      if (options.readOnly) {
        const out = await networkGit.raw(["ls-remote", "--symref", "origin", "HEAD"]);
        const advertised = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1];
        if (advertised) return advertised;
        throw new Error("origin did not advertise a HEAD symref");
      }
      await networkGit.raw(["remote", "set-head", "origin", "-a"]);
      const refreshed = await this.readOriginHead(bareGit);
      if (refreshed !== null) {
        return refreshed;
      }
    } catch (error) {
      this.logger.warn(`Could not read the default branch from origin: ${getErrorMessage(error)}`);
    }

    if (remoteBranches !== null) {
      for (const defaultName of GIT_CONSTANTS.COMMON_DEFAULT_BRANCHES) {
        if (remoteBranches.has(defaultName)) {
          return defaultName;
        }
      }
    }
    return GIT_CONSTANTS.DEFAULT_BRANCH;
  }

  private async readOriginHead(bareGit: SimpleGit): Promise<string | null> {
    const originHeadPrefix = `${GIT_CONSTANTS.REFS.REMOTES}/`;
    try {
      const ref = (await bareGit.raw(["symbolic-ref", `${GIT_CONSTANTS.REFS.REMOTES}/HEAD`])).trim();
      const branch = ref.startsWith(originHeadPrefix) ? ref.slice(originHeadPrefix.length) : "";
      return branch.length > 0 ? branch : null;
    } catch {
      return null;
    }
  }

  private async listRemoteBranchNames(bareGit: SimpleGit): Promise<Set<string> | null> {
    try {
      return new Set((await this.branchRefs.readRemoteBranchTips(bareGit)).keys());
    } catch {
      return null;
    }
  }

  async getRemoteDefaultBranch(repoUrl: string): Promise<string> {
    const git = this.ctx.uncachedGit(undefined, { useLfsSkip: false, blockMs: this.ctx.fetchTimeoutMs() });

    try {
      const out = await git.raw(["ls-remote", "--symref", repoUrl, "HEAD"]);
      const match = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
      if (match && match[1]) {
        return match[1];
      }
    } catch {}

    const existing: string[] = [];
    for (const candidate of GIT_CONSTANTS.COMMON_DEFAULT_BRANCHES) {
      try {
        const out = await git.raw(["ls-remote", "--exit-code", repoUrl, `refs/heads/${candidate}`]);
        if (out.trim().length > 0) {
          existing.push(candidate);
        }
      } catch {}
    }

    if (existing.length === 1) {
      this.logger.warn(
        `Could not read symref HEAD for '${redactRepoUrl(repoUrl)}'; using the only common branch found ('${existing[0]}') as the default.`,
      );
      return existing[0];
    }

    if (existing.length > 1) {
      throw new Error(
        `Unable to detect default branch for '${redactRepoUrl(repoUrl)}': symref HEAD is unavailable and multiple common branches exist (${existing.join(", ")}). ` +
          `Set 'branch' explicitly in the repository config.`,
      );
    }

    throw new Error(
      `Unable to detect default branch for '${redactRepoUrl(repoUrl)}'. ` +
        `Set 'branch' explicitly in the repository config or ensure the remote is reachable.`,
    );
  }
}
