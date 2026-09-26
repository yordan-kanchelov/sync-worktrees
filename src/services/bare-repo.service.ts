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

// What the bare clone's destination was verified to be. The first three are
// positive verdicts — the path is provably absent, provably an empty
// directory, or a marked leftover this tool just removed — and only those let
// the clone claim the destination with a pending marker. "unverifiable" is
// every outcome the probes could not settle; it is cloned into, but never
// claimed, so a failed clone leaves nothing that would authorize a deletion.
type BareCloneDestination = "missing" | "empty" | "recovered" | "unverifiable";

// Branch names per `git branch -D` invocation when dropping a fresh bare
// clone's refs/heads/* copies. One call per batch keeps a repository with
// thousands of branches to a handful of packed-refs rewrites instead of one
// per ref, while staying far below any platform's argument-length limit.
const BRANCH_DELETE_BATCH_SIZE = 200;

/**
 * The bare repository itself: cloning it (with the pending marker that makes
 * an interrupted clone recoverable), checking an existing one still points at
 * the configured origin, its fetch refspec, and resolving the default branch.
 * Part of GitService, which hands it its cached clients through the shared
 * context.
 */
export class BareRepoService {
  constructor(
    private readonly ctx: GitServiceContext,
    private readonly branchRefs: BranchRefService,
  ) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  // Makes sure a usable bare repository exists at bareRepoPath and carries the
  // fetch refspec worktrees need: an existing one is checked against the
  // configured origin, a missing one is cloned.
  async ensureBareRepository(): Promise<void> {
    const { repoUrl } = this.ctx.config;
    const bareRepoPath = this.ctx.bareRepoPath;

    // Check if bare repo already exists
    let bareRepoExists: boolean;
    try {
      await fs.access(path.join(bareRepoPath, "HEAD"));
      bareRepoExists = true;
    } catch {
      bareRepoExists = false;
    }

    if (bareRepoExists) {
      // A marker next to a repository that has a HEAD is stale (a clone that
      // landed but whose marker removal did not): the repository is complete,
      // so only the marker goes — nothing here may delete a directory.
      await this.clearBareClonePendingMarker();
      await this.assertBareRepoOriginMatches(this.ctx.localGit(bareRepoPath));
    } else {
      const destination = await this.prepareBareCloneDestination();
      // Clone as bare repository
      this.logger.info(`Cloning from "${redactRepoUrl(repoUrl)}" as bare repository into "${bareRepoPath}"...`);
      await fs.mkdir(path.dirname(bareRepoPath), { recursive: true });
      // The marker authorizes a later init to DELETE this directory, so only a
      // destination positively verified as ours may carry one. A destination
      // that could not be verified is cloned into without a marker: the clone
      // reports whatever is wrong with it, and nothing is left behind that
      // would license deleting someone else's data on the next run.
      if (destination !== "unverifiable") await this.writeBareClonePendingMarker();
      const cloneGit = this.ctx.uncachedGit(undefined, {
        useLfsSkip: this.ctx.isLfsSkipEnabled(),
        blockMs: this.ctx.cloneTimeoutMs(),
      });
      try {
        await cloneGit.clone(repoUrl, bareRepoPath, ["--bare", "--progress"]);
      } catch (error) {
        // git removes the destination it created when a clone fails, so the
        // authorization must end with the clone that earned it: it survives
        // only while a partial directory actually remains.
        await this.releaseBareClonePendingMarkerAfterFailure();
        throw error;
      }
      // A clone git reported as successful always wrote HEAD, so ownership
      // ends here, before the post-clone steps. Those are deliberately not
      // covered by it: dropClonedBranchCopies is best-effort and must never
      // run against an adopted repository, whose refs/heads can hold real
      // local-only commits.
      await this.clearBareClonePendingMarker();
      this.logger.info("✅ Clone successful.");
      await this.dropClonedBranchCopies(this.ctx.localGit(bareRepoPath));
    }

    // Configure bare repository for worktrees
    const bareGit = this.ctx.localGit(bareRepoPath);

    // Check if fetch config already exists
    try {
      const existingConfig = await bareGit.raw(["config", "--get-all", "remote.origin.fetch"]);
      if (!existingConfig.includes(GIT_CONSTANTS.FETCH_CONFIG)) {
        await bareGit.addConfig("remote.origin.fetch", GIT_CONSTANTS.FETCH_CONFIG);
      }
    } catch {
      // Config doesn't exist, add it
      await bareGit.addConfig("remote.origin.fetch", GIT_CONSTANTS.FETCH_CONFIG);
    }
  }

  // Where the "a bare clone into this directory is in flight" marker lives.
  // Next to the bare repository, never inside it: `git clone` refuses any
  // destination directory that is not empty — dotfiles count — so a marker
  // written inside would break the very clone it guards. It is named after the
  // directory it belongs to, so repositories sharing a `.bare/` parent each get
  // their own.
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
      // Best effort, like clone mode's init marker: without it an interrupted
      // clone only falls back to the old manual-cleanup behaviour.
      this.logger.warn(`Could not write the bare-clone pending marker: ${getErrorMessage(error)}`);
    }
  }

  private async clearBareClonePendingMarker(): Promise<void> {
    const markerPath = this.getBareClonePendingMarkerPath();
    if (!(await fileExists(markerPath))) return;
    try {
      await fs.unlink(markerPath);
    } catch (error) {
      // A marker left behind is harmless while HEAD exists: every later init
      // clears it again and never deletes a repository that has a HEAD.
      this.logger.debug(`Could not remove the bare-clone pending marker at '${markerPath}': ${getErrorMessage(error)}`);
    }
  }

  // The marker's authorization is scoped to the clone that wrote it. git
  // removes the destination directory it created when a clone fails, so once
  // the failure is in hand the marker is dropped again unless a partial
  // directory really is left on disk — an unverifiable destination keeps it,
  // since "cannot tell" must not silently disown a directory we did create.
  private async releaseBareClonePendingMarkerAfterFailure(): Promise<void> {
    const probe = await probePathExists(this.ctx.bareRepoPath);
    if (probe === "unknown") return;
    if (probe === "exists" && (await this.listBareRepoDir()).entries?.length !== 0) return;
    await this.clearBareClonePendingMarker();
  }

  // Decides what `git clone --bare` may be pointed at, and whether the clone
  // may claim the destination as its own (see the caller: only a verified
  // verdict gets a marker).
  //
  // A `git clone --bare` writes HEAD almost immediately — it runs `init_db`
  // before any transfer — so a HEAD-less `bareRepoDir` is not the normal
  // residue of a killed clone; it is what a half-finished cleanup, a partially
  // deleted directory or external damage leaves. However it arose, "bare repo
  // exists" is decided by `<bare>/HEAD`, so initialize() kept re-issuing the
  // clone into that directory and git kept refusing it ("destination path
  // already exists and is not an empty directory"), with nothing in the log
  // naming the fix.
  //
  // The marker is what tells such a leftover apart: it is written only for a
  // destination this tool verified and claimed, so a marked one is ours to
  // delete and clone again. Everything else — a non-empty directory, a path
  // that is not a directory, a directory whose contents cannot be listed — is
  // never deleted and gets a named, actionable error instead. Only ever
  // reached when `<bare>/HEAD` is missing, so a working repository is out of
  // scope by construction.
  private async prepareBareCloneDestination(): Promise<BareCloneDestination> {
    const probe = await probePathExists(this.ctx.bareRepoPath);
    if (probe === "missing") return "missing";
    // "unknown" means the path itself could not be probed (EACCES on a parent,
    // EIO): it may or may not exist, so nothing may be deleted, nothing may be
    // claimed, and the clone below reports the real problem.
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
      // The directory vanished between the two probes: a fresh clone again.
      if (error?.code === "ENOENT") return "missing";
      // Anything else (ENOTDIR — the path is a file — EACCES, EMFILE) is a
      // destination we cannot judge. Never clone into it hoping for the best:
      // that is how a failed clone would leave a marker on a path holding
      // someone's data, licensing its deletion on the next run.
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

  // `entries` is null exactly when the listing failed; `error` says why.
  private async listBareRepoDir(): Promise<{ entries: string[] | null; error?: NodeJS.ErrnoException }> {
    try {
      return { entries: await fs.readdir(this.ctx.bareRepoPath) };
    } catch (error) {
      return { entries: null, error: error as NodeJS.ErrnoException };
    }
  }

  // An existing bare repo is found by path alone, and the default bareRepoDir
  // is `.bare/<repo-name>` — the same directory for old-org/app and
  // new-org/app. So before anything is fetched from it, its origin must be
  // the configured repoUrl; otherwise a changed repoUrl would keep syncing
  // the remote the bare repo was cloned from, and nothing in the log would
  // say so. Mirrors clone mode's origin check: URLs compare normalized
  // (scheme/host case, trailing slash, forge `.git`) so equivalent spellings
  // don't false-positive, and are shown redacted. A bare repo whose origin
  // cannot be read is not a mismatch — the fetch that follows reports it.
  async assertBareRepoOriginMatches(bareGit: SimpleGit): Promise<void> {
    const bareRepoPath = path.resolve(this.ctx.bareRepoPath);

    let originUrl: string;
    try {
      originUrl = (await bareGit.raw(["remote", "get-url", "origin"])).trim();
    } catch {
      this.logger.warn(`Could not read 'origin' remote URL from existing bare repository at '${bareRepoPath}'.`);
      return;
    }

    const { repoUrl } = this.ctx.config;
    if (!originUrl || normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(repoUrl)) {
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

  // `git clone --bare` copies every remote branch into refs/heads/*, and the
  // fetch refspec only ever updates refs/remotes/origin/*, so those copies
  // stay frozen at clone time. A worktree added months later for such a
  // branch would check out that frozen tip: addWorktree fast-forwards a copy
  // that is merely behind to origin's tip, but a copy whose commits were
  // rebased away on the remote is indistinguishable from never-pushed work
  // and is kept.
  // Drop the copies while they are provably copies — right after the clone,
  // before any worktree exists. The branch HEAD points at stays (the
  // default-branch worktree is created from it). An existing bare repository
  // is never touched here: its refs/heads/* may carry real local-only commits
  // from a worktree that was removed. Best-effort — a leftover copy is a
  // stale-checkout risk that addWorktree mitigates, not a broken repository.
  private async dropClonedBranchCopies(bareGit: SimpleGit): Promise<void> {
    try {
      // `-q` is safe here even though simple-git resolves its silent exit 1:
      // the empty string it yields for a HEAD that is not a symref means "no
      // branch to protect", which is what a detached HEAD actually is.
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

  // refs/remotes/origin/HEAD is a symref that only `remote set-head` writes.
  // `fetch --prune` drops refs/remotes/origin/<old> once the remote renamed or
  // deleted its default branch but leaves the symref pointing at the old
  // name, so it is trusted only while its target is still a remote branch.
  // Otherwise the remote is asked again, and failing that a common default
  // name that does exist is used.
  //
  // `readOnly` (the dry run) asks the remote with `ls-remote --symref` instead
  // of `remote set-head -a`: the same question, without rewriting the symref.
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
      // The only command here that talks to the remote, so it runs on the
      // network client (the caller's bareGit is the local one).
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
    // Final fallback
    return GIT_CONSTANTS.DEFAULT_BRANCH;
  }

  // Branch name origin/HEAD points at, or null when the symref is missing or
  // does not name a remote branch.
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

  // null when the listing itself failed, which callers treat as "unknown"
  // rather than "no branches".
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
    } catch {
      /* fall through to probe candidates */
    }

    // symref HEAD was unavailable/unparsed: probe common branch names, but only
    // auto-pick when the choice is unambiguous. Guessing by fixed priority when
    // several exist can silently track the wrong branch (e.g. 'main' when the
    // remote's real default is 'master').
    const existing: string[] = [];
    for (const candidate of GIT_CONSTANTS.COMMON_DEFAULT_BRANCHES) {
      try {
        const out = await git.raw(["ls-remote", "--exit-code", repoUrl, `refs/heads/${candidate}`]);
        if (out.trim().length > 0) {
          existing.push(candidate);
        }
      } catch {
        /* candidate missing — try next */
      }
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
