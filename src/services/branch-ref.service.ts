import { GIT_CONSTANTS } from "../constants";
import { GitOperationError } from "../errors";
import { getErrorMessage } from "../utils/errors";

import type { GitServiceContext } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { SimpleGit } from "simple-git";

const REMOTE_REF_PREFIX = `${GIT_CONSTANTS.REFS.REMOTES}/`;

const REMOTES_GLOB = `--glob=${REMOTE_REF_PREFIX}`;

const ORIGIN_HEAD_REF = `${REMOTE_REF_PREFIX}HEAD`;

export class BranchRefService {
  constructor(private readonly ctx: GitServiceContext) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  private bareGit(): SimpleGit {
    return this.ctx.localGit(this.ctx.bareRepoPath);
  }

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

  private static remoteBranchFromRef(ref: string): string | null {
    if (!ref.startsWith(REMOTE_REF_PREFIX) || ref === ORIGIN_HEAD_REF) return null;
    const branch = ref.slice(REMOTE_REF_PREFIX.length);
    return branch.length > 0 ? branch : null;
  }

  async getRemoteBranchesWithActivity(git: SimpleGit): Promise<{ branch: string; lastActivity: Date }[]> {
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
      const branch = BranchRefService.remoteBranchFromRef(ref);
      if (branch === null) continue;
      const lastActivity = new Date(dateStr);
      if (!isNaN(lastActivity.getTime())) {
        branches.push({ branch, lastActivity });
      }
    }

    return branches;
  }

  async updateRef(refName: string, sha: string): Promise<void> {
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

  async createBranchAt(branchName: string, sha: string): Promise<void> {
    await this.bareGit().raw(["branch", "--", branchName, sha]);
  }

  async deleteLocalBranch(branchName: string): Promise<void> {
    await this.bareGit().raw(["branch", "-D", "--", branchName]);
  }

  async deleteLocalBranchIfAt(branchName: string, expectedOid: string): Promise<void> {
    const bareGit = this.bareGit();
    await bareGit.raw(["update-ref", "-d", "--", `${GIT_CONSTANTS.REFS.HEADS}${branchName}`, expectedOid]);
    await this.removeBranchConfigSection(bareGit, branchName);
  }

  private async removeBranchConfigSection(bareGit: SimpleGit, branchName: string): Promise<void> {
    try {
      await bareGit.raw(["config", "--remove-section", `branch.${branchName}`]);
    } catch (error) {
      this.logger.debug(
        `  - Left the config section of the deleted branch '${branchName}' in place: ${getErrorMessage(error)}`,
      );
    }
  }

  async createBundleFromRef(bundlePath: string, refName: string): Promise<boolean> {
    const bareGit = this.bareGit();
    if ((await this.countCommitsNotOnAnyRemote(refName)) === 0) {
      return false;
    }
    await bareGit.raw(["bundle", "create", bundlePath, refName, "--not", REMOTES_GLOB]);
    return true;
  }

  async countCommitsNotOnAnyRemote(rev: string): Promise<number> {
    const raw = (await this.bareGit().raw(["rev-list", "--count", rev, "--not", REMOTES_GLOB])).trim();
    const count = Number.parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || !Number.isInteger(count)) {
      throw new Error(
        `Could not read a commit count from 'git rev-list --count ${rev} --not ${REMOTES_GLOB}': '${raw}'`,
      );
    }
    return count;
  }

  async getRemoteCommit(ref: string): Promise<string> {
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

  async refExists(git: SimpleGit, ref: string): Promise<boolean> {
    try {
      await git.raw(["show-ref", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  }

  async trackRemoteBranchIfExists(branchName: string, worktreePath: string): Promise<boolean> {
    if (!(await this.refExists(this.bareGit(), `${GIT_CONSTANTS.REFS.REMOTES}/${branchName}`))) {
      return false;
    }
    const upstream = `${GIT_CONSTANTS.REMOTE_PREFIX}${branchName}`;
    try {
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
      } catch {}
    }

    return candidates[0];
  }

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

    await bareGit.push(["origin", `${ref}:${ref}`, "-u", `--force-with-lease=${ref}:`]);
    this.logger.info(`Pushed branch '${branchName}' to remote`);
  }
}
