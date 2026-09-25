import { GIT_CONSTANTS } from "../constants";
import { GitOperationError } from "../errors";
import { getErrorMessage } from "../utils/errors";

import type { GitServiceContext } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { SimpleGit } from "simple-git";

// Full-ref prefix of origin's remote-tracking branches. Every inventory
// listing reads %(refname) and strips this literal prefix, never
// %(refname:short): git's short form is ambiguity-dependent and silently
// renames refs. It shortens refs/remotes/origin/feature/HEAD to
// "origin/feature" (a branch that does not exist) and prints
// "remotes/origin/x" whenever a local branch literally named "origin/x"
// exists — either way the real branch leaves the inventory and its worktree
// then reads as stale and is pruned.
const REMOTE_REF_PREFIX = `${GIT_CONSTANTS.REFS.REMOTES}/`;

// `--not <this>` excludes everything reachable from origin's remote-tracking
// refs, and only those. Deliberately not `--remotes`: see
// countCommitsNotOnAnyRemote for why every remote-tracking ref in the
// repository is the wrong set to trust.
const REMOTES_GLOB = `--glob=${REMOTE_REF_PREFIX}`;

// The one ref under that prefix that is not a branch: the symref
// `git remote set-head` writes. It is excluded by its full name only —
// "feature/HEAD" is a legal branch name, so an endsWith("/HEAD") test would
// drop a real branch (and prune its worktree) along with the symref.
const ORIGIN_HEAD_REF = `${REMOTE_REF_PREFIX}HEAD`;

/**
 * Branch and ref operations on the bare repository: existence probes, the
 * origin branch inventory, branch creation and push, ref writes and deletes
 * (including the compare-and-swap branch delete the removal pipeline uses),
 * and the "commits no remote has" count behind trash bundles. Part of
 * GitService, which hands it its cached clients through the shared context.
 */
export class BranchRefService {
  constructor(private readonly ctx: GitServiceContext) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  private bareGit(): SimpleGit {
    return this.ctx.localGit(this.ctx.bareRepoPath);
  }

  // Every origin branch and its tip oid, from one `for-each-ref` over
  // refs/remotes/origin. This replaced `branch -v -r`, which asked git to
  // resolve and print a commit subject for every branch only for the names to
  // be thrown away: on a repository with hundreds of branches that is the
  // difference between reading the ref store and walking the object database,
  // and it ran on every tick.
  //
  // Output shape is fixed by --format, not by the reader's terminal or config:
  // a full %(refname), never %(refname:short) (ambiguity-dependent — git prints
  // "remotes/origin/x" once a local branch literally named "origin/x" exists,
  // and shortens refs/remotes/origin/feature/HEAD to "origin/feature", a branch
  // that does not exist), and no color escapes to strip under color.ui=always.
  // A NUL separates the two fields because a refname can hold neither NUL nor
  // newline, so no branch name can corrupt a line.
  async readRemoteBranchTips(git: SimpleGit): Promise<Map<string, string>> {
    const raw = await git.raw(["for-each-ref", "--format=%(refname)%00%(objectname)", GIT_CONSTANTS.REFS.REMOTES]);
    const tips = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ref, oid] = trimmed.split("\0", 2);
      if (!ref || !oid) continue;
      const branch = BranchRefService.remoteBranchFromRef(ref);
      if (branch === null) continue;
      tips.set(branch, oid);
    }
    return tips;
  }

  // Branch name for one full remote-tracking ref, or null when the ref is not
  // one of origin's branches (a foreign prefix, the origin/HEAD symref, or the
  // prefix with nothing after it).
  private static remoteBranchFromRef(ref: string): string | null {
    if (!ref.startsWith(REMOTE_REF_PREFIX) || ref === ORIGIN_HEAD_REF) return null;
    const branch = ref.slice(REMOTE_REF_PREFIX.length);
    return branch.length > 0 ? branch : null;
  }

  async getRemoteBranchesWithActivity(git: SimpleGit): Promise<{ branch: string; lastActivity: Date }[]> {
    // NUL delimiter: "|" is a legal branch-name character, so a branch like
    // "feature|wip" would corrupt a "|"-delimited line and be silently dropped
    // from the inventory (and its worktree then pruned as stale). A refname can
    // never contain NUL or newline.
    const result = await git.raw([
      "for-each-ref",
      "--format=%(refname)%00%(committerdate:iso8601)",
      GIT_CONSTANTS.REFS.REMOTES,
    ]);

    const branches: { branch: string; lastActivity: Date }[] = [];
    const lines = result
      .trim()
      .split("\n")
      .filter((line) => line);

    for (const line of lines) {
      const [ref, dateStr] = line.split("\0", 2);
      if (!ref || !dateStr) continue;
      // Same rule as readRemoteBranchTips: strip the literal prefix off the
      // full refname, never filter the stripped name (a branch literally named
      // "origin" is real, and so is one named "feature/HEAD").
      const branch = BranchRefService.remoteBranchFromRef(ref);
      if (branch === null) continue;
      const lastActivity = new Date(dateStr);
      // Skip if the date is invalid
      if (!isNaN(lastActivity.getTime())) {
        branches.push({ branch, lastActivity });
      }
    }

    return branches;
  }

  async updateRef(refName: string, sha: string): Promise<void> {
    // `--` because the reaper promotes a trash pin to a permanent keep ref
    // through here with a manifest-sourced oid: `git update-ref <ref> -d`
    // DELETES the ref it was asked to write (measured, exit 0). With the
    // separator the same call is `fatal: -d: not a valid SHA1` and the ref
    // survives.
    await this.bareGit().raw(["update-ref", "--", refName, sha]);
  }

  async deleteRef(refName: string): Promise<void> {
    await this.bareGit().raw(["update-ref", "-d", "--", refName]);
  }

  async listRefs(prefix: string): Promise<string[]> {
    const raw = await this.bareGit().raw(["for-each-ref", "--format=%(refname)", prefix]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async getLocalBranchCommit(branchName: string): Promise<string | null> {
    const bareGit = this.bareGit();
    try {
      return (await bareGit.raw(["rev-parse", `${GIT_CONSTANTS.REFS.HEADS}${branchName}^{commit}`])).trim();
    } catch {
      return null;
    }
  }

  // `--` before the two positionals, because both of them come back out of a
  // trash manifest and git's option parser permutes: without it `git branch
  // <name> -m` and `git branch -m <sha>` are both `git branch -m`, which in a
  // bare repo renames the branch HEAD points at. Verified on git 2.43.0 —
  // after `--`, an option-shaped name is "not a valid branch name" and an
  // option-shaped start-point is "not a valid object name", and refs/heads/
  // is untouched either way.
  async createBranchAt(branchName: string, sha: string): Promise<void> {
    await this.bareGit().raw(["branch", "--", branchName, sha]);
  }

  async deleteLocalBranch(branchName: string): Promise<void> {
    await this.bareGit().raw(["branch", "-D", "--", branchName]);
  }

  // Compare-and-swap delete: removes the branch ref only while it still
  // points at expectedOid, so a commit racing the removal pipeline keeps its
  // ref instead of being orphaned by an unconditional `branch -D`.
  async deleteLocalBranchIfAt(branchName: string, expectedOid: string): Promise<void> {
    const bareGit = this.bareGit();
    await bareGit.raw(["update-ref", "-d", "--", `${GIT_CONSTANTS.REFS.HEADS}${branchName}`, expectedOid]);
    // Only after the delete actually succeeded: a CAS that the ref moved
    // under rejects above, and the still-live branch keeps its upstream.
    await this.removeBranchConfigSection(bareGit, branchName);
  }

  // `branch -D` drops the branch's `[branch "<name>"]` config section along
  // with the ref; `update-ref -d` removes the ref only. Without this the CAS
  // delete above would strand `branch.<name>.remote`/`.merge` in the bare
  // repo's config on every pruned worktree, so the file grows without bound
  // and a later restore of the same name silently inherits a stale upstream.
  // Best-effort by design, and every failure mode here is one to swallow: git
  // reports an absent section as a hard failure (exit 128 with stderr, which
  // simple-git rejects), and a concurrent `git` holding `config.lock` fails it
  // outright with no retry. A section left behind is untidiness — never a
  // reason to report a branch deletion that did succeed as failed — so the
  // catch is deliberately every error, not just the git ones.
  //
  // `--remove-section` splits its argument at the first dot and treats the
  // whole remainder as one literal subsection, so a branch named `v1.2`
  // addresses `[branch "v1.2"]` and leaves a sibling `[branch "v1"]` alone.
  // The subsection is matched case-sensitively, so the name must be passed
  // through exactly as git recorded it.
  private async removeBranchConfigSection(bareGit: SimpleGit, branchName: string): Promise<void> {
    try {
      await bareGit.raw(["config", "--remove-section", `branch.${branchName}`]);
    } catch (error) {
      this.logger.debug(
        `  - Left the config section of the deleted branch '${branchName}' in place: ${getErrorMessage(error)}`,
      );
    }
  }

  // Bundles only commits not reachable from any remote — for fully-pushed
  // refs that set is empty and `bundle create` would fail. Emptiness is
  // pre-checked with rev-list (locale-independent) instead of parsing git's
  // localized "empty bundle" stderr; after the pre-check, any bundle-create
  // error is a real failure the caller must treat as fail-closed.
  async createBundleFromRef(bundlePath: string, refName: string): Promise<boolean> {
    const bareGit = this.bareGit();
    if ((await this.countCommitsNotOnAnyRemote(refName)) === 0) {
      return false;
    }
    await bareGit.raw(["bundle", "create", bundlePath, refName, "--not", REMOTES_GLOB]);
    return true;
  }

  // How many commits reachable from `rev` are on no `refs/remotes/origin/*`
  // ref — "is there anything here the remote does not already have?". The
  // bundle decision above and the reaper's keep-ref re-check are the same
  // question asked of the same ref set, so they ask it the same way.
  //
  // Scoped to `origin` rather than `--remotes`, which is every remote-tracking
  // ref the repository happens to hold. `git fetch --all --prune` only prunes
  // remotes still in config, so a `refs/remotes/<removed-remote>/*` left behind
  // by a remote the user has since deleted survives every fetch and still
  // anchors its commits under `--remotes` — measured: the count reads 0 with
  // such a ref present and 2 once it is gone. Reading that zero would release
  // the only anchor for commits no remote actually has. `origin` is the one
  // remote this tool manages and the one it fetches, so it is the only ref set
  // whose freshness anything here can vouch for. Narrowing can only over-count,
  // which means bundling or pinning more than strictly necessary.
  //
  // Even so this proves reachability from those refs as they stand right now,
  // nothing more: a ref `fetch --prune` has not yet dropped still anchors its
  // commits. Callers that act on a zero must say why their ref set is current.
  //
  // Unparseable output throws rather than reading as zero: every caller treats
  // zero as "nothing to preserve", so a number that could not be read must not
  // become one.
  async countCommitsNotOnAnyRemote(rev: string): Promise<number> {
    const raw = (await this.bareGit().raw(["rev-list", "--count", rev, "--not", REMOTES_GLOB])).trim();
    // `/^\d+$/` is the real gate; `Number.isInteger` catches only the digit
    // string too long to survive parseInt (400 digits reads back as Infinity),
    // which would otherwise be returned as a non-zero and mint the ref anyway.
    const count = Number.parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || !Number.isInteger(count)) {
      throw new Error(
        `Could not read a commit count from 'git rev-list --count ${rev} --not ${REMOTES_GLOB}': '${raw}'`,
      );
    }
    return count;
  }

  async getRemoteCommit(ref: string): Promise<string> {
    // Use the bare repository to read remote commit to avoid dependency on main worktree path
    const commit = await this.bareGit().revparse([ref]);
    return commit.trim();
  }

  async branchExists(branchName: string): Promise<{ local: boolean; remote: boolean }> {
    const bareGit = this.bareGit();
    const [local, remote] = await Promise.all([
      this.refExists(bareGit, `${GIT_CONSTANTS.REFS.HEADS}${branchName}`),
      this.refExists(bareGit, `${GIT_CONSTANTS.REFS.REMOTES}/${branchName}`),
    ]);

    return { local, remote };
  }

  // `git` is the caller's client: the probe runs wherever the operation it
  // belongs to runs (worktree creation uses the bare repo's LFS-aware client).
  async refExists(git: SimpleGit, ref: string): Promise<boolean> {
    try {
      // simple-git resolves `show-ref --quiet` when Git exits 1, so keep stdout enabled.
      await git.raw(["show-ref", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  }

  // Points branch.<name>.remote/merge at origin/<name> when that remote branch
  // is known locally. Sync itself never relies on the upstream — its probes
  // name origin/<name> explicitly — but `git pull`, `git status` and the
  // ahead/behind views in the worktree do, so a branch registered without
  // tracking (a trash restore, `branch --no-track`, the no-tracking add
  // fallback) gets one whenever it can. Resolves to whether it was set and
  // never throws: no remote branch is the normal state of an unpushed branch,
  // and a failure to set it leaves a working worktree, so it is only logged.
  async trackRemoteBranchIfExists(branchName: string, worktreePath: string): Promise<boolean> {
    if (!(await this.refExists(this.bareGit(), `${GIT_CONSTANTS.REFS.REMOTES}/${branchName}`))) {
      return false;
    }
    const upstream = `${GIT_CONSTANTS.REMOTE_PREFIX}${branchName}`;
    try {
      // Config-only: works on a --no-checkout worktree too.
      await this.ctx.localGit(worktreePath).raw(["branch", `--set-upstream-to=${upstream}`, "--", branchName]);
      this.logger.info(`  - Set upstream of '${branchName}' to ${upstream}`);
      return true;
    } catch (error) {
      this.logger.warn(`  - ⚠️ Could not set upstream of '${branchName}' to ${upstream}: ${getErrorMessage(error)}`);
      return false;
    }
  }

  private async resolveCreateBranchBaseRef(bareGit: SimpleGit, baseBranch: string): Promise<string> {
    const candidates =
      baseBranch.startsWith(GIT_CONSTANTS.REMOTE_PREFIX) || baseBranch.startsWith("refs/")
        ? [baseBranch]
        : [`${GIT_CONSTANTS.REMOTE_PREFIX}${baseBranch}`, baseBranch];

    for (const candidate of candidates) {
      try {
        await bareGit.revparse(["--verify", candidate]);
        return candidate;
      } catch {
        // Try the next candidate before letting git branch report the original failure.
      }
    }

    return candidates[0];
  }

  // A live look at origin, not at refs/remotes: the remote-tracking refs are
  // only as fresh as the last fetch, and `branchMaxAge`/`branchInclude`/
  // `branchExclude` mean a branch that is on origin very often has no local
  // head here at all — so the collision check `git branch` performs sees
  // nothing and the name is taken anyway. A fully-qualified `ls-remote`
  // pattern matches that one ref and nothing that merely starts with it.
  async remoteBranchExists(branchName: string): Promise<boolean> {
    const ref = `${GIT_CONSTANTS.REFS.HEADS}${branchName}`;
    const output = await this.ctx.networkGit(this.ctx.bareRepoPath).raw(["ls-remote", "--heads", "origin", ref]);
    return output
      .split("\n")
      .map((line) => line.split(/\s+/)[1] ?? "")
      .includes(ref);
  }

  async createBranch(branchName: string, baseBranch: string): Promise<void> {
    const bareGit = this.bareGit();
    const baseRef = await this.resolveCreateBranchBaseRef(bareGit, baseBranch);

    // The wording matters: the TUI retries the whole call with a '-1', '-2', …
    // suffix on exactly "already exists", which is how a local collision has
    // always behaved, so a remote-only one takes the same route.
    //
    // A probe that cannot reach the remote must not stop a branch from being
    // created — `create_worktree` without a push works offline — so failure
    // here is not fatal. The create-only lease in pushBranch is what actually
    // guarantees an existing remote branch is never advanced; this probe only
    // buys the better message, and the suffix, before anything is written.
    let onOrigin = false;
    try {
      onOrigin = await this.remoteBranchExists(branchName);
    } catch (error) {
      this.logger.debug(`Could not ask origin whether '${branchName}' exists: ${getErrorMessage(error)}`);
    }
    if (onOrigin) {
      throw new GitOperationError("branch", `branch '${branchName}' already exists on origin; choose another name`);
    }

    await bareGit.raw(["branch", "--no-track", branchName, baseRef]);
    this.logger.info(`Created branch '${branchName}' from '${baseRef}'`);
  }

  async pushBranch(branchName: string): Promise<void> {
    const bareGit = this.ctx.networkGit(this.ctx.bareRepoPath);
    const ref = `${GIT_CONSTANTS.REFS.HEADS}${branchName}`;

    // `--force-with-lease` with an EMPTY expected value leases the ref against
    // "does not exist", so an existing remote ref is never advanced or
    // force-updated: git rejects the push with "stale info" instead. Without
    // it, `origin <name>:<name>` FAST-FORWARDS a branch that is already on
    // origin whenever its tip is an ancestor of the base — silently moving
    // somebody else's branch, and with it any open PR or CI run pinned to that
    // ref, while the wizard reports a successful creation.
    //
    // It does not require the ref to be absent, because git enforces a lease
    // only on a ref the push would CHANGE: a remote ref already at exactly
    // this commit is `[up to date]`, exit 0, and `-u` still sets the upstream.
    // Nothing moves in that case either, which is the whole guarantee. (Both
    // directions — ancestor and diverged — verified on git 2.43.)
    await bareGit.push(["origin", `${ref}:${ref}`, "-u", `--force-with-lease=${ref}:`]);
    this.logger.info(`Pushed branch '${branchName}' to remote`);
  }
}
