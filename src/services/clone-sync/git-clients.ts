import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, ENV_CONSTANTS, PATH_CONSTANTS } from "../../constants";
import { ConfigError } from "../../errors";
import { getErrorMessage } from "../../utils/errors";
import { createGitClient } from "../../utils/git-client";
import { sshNoPromptEnv } from "../../utils/git-env";
import { makeGitProgressHandler } from "../../utils/git-progress";
import { redactRepoUrl } from "../../utils/git-url";
import { isUnitTestShortcutEnabled } from "../../utils/unit-test-shortcut";

import { lstatOrNull, realPathOrNull } from "./git-helpers";

import type { CloneSyncContext } from "./types";
import type { Stats } from "fs";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

const PRIMARY_CHECKOUT_VERIFIED: unique symbol = Symbol("primaryCheckoutVerified");

export interface MutatingGitClients {
  readonly [PRIMARY_CHECKOUT_VERIFIED]: true;
  readonly git: SimpleGit;
  readonly networkGit: SimpleGit;
  readonly unshallowGit: SimpleGit;
}

type ClientHost = Pick<CloneSyncContext, "config" | "gitService" | "logger" | "repoName" | "emitProgress">;

export class CloneGitClients {
  constructor(
    private readonly host: ClientHost,
    private readonly baseEnv: NodeJS.ProcessEnv = {},
  ) {}

  getCloneTimeoutMs(): number {
    if (isUnitTestShortcutEnabled()) return 0;
    return this.host.config.cloneTimeoutMs ?? DEFAULT_CONFIG.CLONE_TIMEOUT_MS;
  }

  getFetchTimeoutMs(): number {
    if (isUnitTestShortcutEnabled()) return 0;
    return this.host.config.fetchTimeoutMs ?? DEFAULT_CONFIG.FETCH_TIMEOUT_MS;
  }

  localClientFor(dir: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(0));
  }

  networkClientFor(dir?: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(this.getFetchTimeoutMs()));
  }

  cloneClient(): SimpleGit {
    return createGitClient(undefined, this.buildGitEnv(), this.buildGitOptions(this.getCloneTimeoutMs()));
  }

  lfsSkipFetchClient(_clients: MutatingGitClients, worktreeDir: string): SimpleGit {
    return createGitClient(
      worktreeDir,
      this.buildGitEnv({ forceLfsSkip: true }),
      this.buildGitOptions(this.getFetchTimeoutMs()),
    );
  }

  lfsSkipCheckoutClient(_clients: MutatingGitClients, worktreeDir: string): SimpleGit {
    return createGitClient(worktreeDir, this.buildGitEnv({ forceLfsSkip: true }), this.buildGitOptions(0));
  }

  async mutatingClientsFor(worktreeDir: string): Promise<MutatingGitClients> {
    await this.assertPrimaryCheckout(worktreeDir);
    return {
      [PRIMARY_CHECKOUT_VERIFIED]: true,
      git: this.localClientFor(worktreeDir),
      networkGit: this.networkClientFor(worktreeDir),
      unshallowGit: this.unshallowClientFor(worktreeDir),
    };
  }

  private unshallowClientFor(dir: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(this.getCloneTimeoutMs()));
  }

  private isLfsSkipEnabled(): boolean {
    return this.host.config.skipLfs === true || this.host.gitService.isLfsSkipEnabled();
  }

  private buildGitEnv(opts: { forceLfsSkip?: boolean } = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...sshNoPromptEnv(this.host.config.repoUrl), ...this.baseEnv };
    if (opts.forceLfsSkip || this.isLfsSkipEnabled()) {
      env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] = "1";
    }
    return env;
  }

  private buildGitOptions(blockMs: number): Partial<SimpleGitOptions> {
    const options: Partial<SimpleGitOptions> = {
      progress: makeGitProgressHandler(
        () => this.host.logger,
        (event) => this.host.emitProgress(event),
      ),
    };
    if (blockMs > 0) options.timeout = { block: blockMs };
    return options;
  }

  private async assertPrimaryCheckout(worktreeDir: string): Promise<void> {
    const resolvedDir = path.resolve(worktreeDir);
    const ownGitDir = path.join(resolvedDir, PATH_CONSTANTS.GIT_DIR);

    let output: string;
    try {
      output = await this.localClientFor(resolvedDir).raw(["rev-parse", "--git-dir", "--git-common-dir"]);
    } catch (error) {
      throw this.notPrimaryCheckoutError(
        resolvedDir,
        `its git directory could not be read (${getErrorMessage(error)})`,
        null,
      );
    }

    const [gitDirOutput, commonDirOutput] = output.split(/\r?\n/).map((line) => line.trim());
    if (!gitDirOutput || !commonDirOutput) {
      throw this.notPrimaryCheckoutError(resolvedDir, "'git rev-parse' did not report its git directory", null);
    }
    const gitDir = path.resolve(resolvedDir, gitDirOutput);
    const commonDir = path.resolve(resolvedDir, commonDirOutput);

    const gitEntry = await lstatOrNull(ownGitDir);
    if (gitEntry === null || !gitEntry.isDirectory()) {
      throw this.notPrimaryCheckoutError(
        resolvedDir,
        await describeGitEntry(ownGitDir, gitEntry),
        (await realPathOrNull(commonDir)) ?? commonDir,
      );
    }

    if (gitDir === ownGitDir && commonDir === ownGitDir) return;

    const [realOwnGitDir, realGitDir, realCommonDir] = await Promise.all([
      realPathOrNull(ownGitDir),
      realPathOrNull(gitDir),
      realPathOrNull(commonDir),
    ]);
    if (realOwnGitDir !== null && realGitDir === realOwnGitDir && realCommonDir === realOwnGitDir) return;

    const detail =
      gitDir === ownGitDir
        ? `its git directory is shared with another repository`
        : `git reports its git directory as '${gitDir}'`;
    throw this.notPrimaryCheckoutError(resolvedDir, detail, commonDir);
  }

  private notPrimaryCheckoutError(worktreeDir: string, detail: string, commonDir: string | null): ConfigError {
    const owner = commonDir === null ? "" : ` Its shared git directory is '${commonDir}'.`;
    return new ConfigError(
      `Cannot manage '${worktreeDir}' as a clone-mode repository for '${this.host.repoName}': it is not a primary ` +
        `checkout — ${detail}.${owner} Clone mode would narrow 'remote.origin.fetch', delete ` +
        `'refs/remotes/origin/*' and fetch with --prune there — in the repository that owns that git directory, ` +
        `not in this one — the fetch on every sync, the rest whenever that repository's remote config does not ` +
        `already read as clone mode leaves it. Point 'worktreeDir' at a path this tool owns: an empty directory it ` +
        `can clone into, or a standalone clone of '${redactRepoUrl(this.host.config.repoUrl)}' whose '.git' is a ` +
        `directory in the checkout itself. A checkout whose git directory lives elsewhere — cloned with ` +
        `--separate-git-dir, or with '.git' symlinked away — is refused as well, because nothing distinguishes ` +
        `it from a checkout sharing a git directory that is still in use.`,
      "CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
    );
  }
}

async function describeGitEntry(ownGitDir: string, entry: Stats | null): Promise<string> {
  if (entry === null) return `'${ownGitDir}' could not be read`;
  if (entry.isSymbolicLink()) {
    const target = (await realPathOrNull(ownGitDir)) ?? "another location";
    return `'${ownGitDir}' is a symlink to '${target}', so another checkout could be using that git directory too`;
  }
  if (!entry.isFile()) return `'${ownGitDir}' is not a directory`;
  const pointer = await readGitDirPointer(ownGitDir);
  return pointer
    ? `'${ownGitDir}' is a gitdir pointer to '${pointer}'`
    : `'${ownGitDir}' is a file, not this checkout's own git directory`;
}

async function readGitDirPointer(ownGitDir: string): Promise<string | null> {
  try {
    const contents = await fs.readFile(ownGitDir, "utf-8");
    return /^gitdir:\s*(.+)$/m.exec(contents)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
