import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, ENV_CONSTANTS, PATH_CONSTANTS } from "../../constants";
import { ConfigError } from "../../errors";
import { getErrorMessage } from "../../utils/errors";
import { createGitClient } from "../../utils/git-client";
import { makeGitProgressHandler } from "../../utils/git-progress";
import { redactRepoUrl } from "../../utils/git-url";
import { isUnitTestShortcutEnabled } from "../../utils/unit-test-shortcut";

import { lstatOrNull, realPathOrNull } from "./git-helpers";

import type { CloneSyncContext } from "./types";
import type { Stats } from "fs";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

// Brand carried by a clients pair whose directory has been verified as a
// primary, non-linked checkout. Only CloneGitClients.mutatingClientsFor() can
// produce one, and every helper that writes to the repository takes this type
// instead of a bare SimpleGit — so a mutation added later cannot reach an
// adopted directory without passing the guard first.
const PRIMARY_CHECKOUT_VERIFIED: unique symbol = Symbol("primaryCheckoutVerified");

export interface MutatingGitClients {
  readonly [PRIMARY_CHECKOUT_VERIFIED]: true;
  /** Local commands (config, update-ref, switch, merge). */
  readonly git: SimpleGit;
  /** Network commands (fetch) other than the unshallow, killed after fetchTimeoutMs of silence. */
  readonly networkGit: SimpleGit;
  /** The unshallow fetch alone, killed after cloneTimeoutMs of silence — see unshallowClientFor. */
  readonly unshallowGit: SimpleGit;
}

type ClientHost = Pick<CloneSyncContext, "config" | "gitService" | "logger" | "repoName" | "emitProgress">;

// Every git client clone mode runs, with the environment, progress handler and
// inactivity timeout that kind of command needs, and the primary-checkout
// guard every write goes through.
export class CloneGitClients {
  // `baseEnv` is carried by every client built here: optional locks off for
  // the dry run's read-only service, so a clone's reads leave its index alone.
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

  // Client for local commands (rev-parse, config, show-ref, for-each-ref,
  // update-ref, merge, switch, checkout, remote get-url). No inactivity kill:
  // simple-git's block timeout only resets on stdout/stderr data, and git is
  // legitimately silent for minutes while a merge or checkout materializes a
  // large tree — killing it there fails a sync that would have succeeded.
  localClientFor(dir: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(0));
  }

  // Client for network commands (fetch, ls-remote). Silence there means a
  // stalled connection or a prompt nobody can answer, so fetchTimeoutMs stays
  // the guard that ends the attempt. `dir` undefined runs without a working
  // directory (ls-remote against a URL).
  networkClientFor(dir?: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(this.getFetchTimeoutMs()));
  }

  // The initial `git clone`, on the clone budget, with no working directory.
  cloneClient(): SimpleGit {
    return createGitClient(undefined, this.buildGitEnv(), this.buildGitOptions(this.getCloneTimeoutMs()));
  }

  // The retry of a fetch that died on an LFS error: the same kind of network
  // client, with LFS smudging forced off. It is built here rather than taken
  // from the branded pair, whose clients carry the configured environment;
  // requiring the brand keeps it in a directory that pair already proved is a
  // primary checkout.
  lfsSkipFetchClient(_clients: MutatingGitClients, worktreeDir: string): SimpleGit {
    return createGitClient(
      worktreeDir,
      this.buildGitEnv({ forceLfsSkip: true }),
      this.buildGitOptions(this.getFetchTimeoutMs()),
    );
  }

  // The client for a checkout init must run with LFS smudging forced off, on
  // the same terms as lfsSkipFetchClient. No inactivity timeout, for the reason
  // localClientFor gives: git is legitimately silent while it materializes a
  // tree.
  //
  // `_clients` is unused on purpose and must stay: requiring the brand is what
  // keeps the writes this client performs behind the primary-checkout guard,
  // exactly like the helpers that do use their pair. Deleting the parameter
  // would let a future caller reach a checkout this tool must not touch.
  lfsSkipCheckoutClient(_clients: MutatingGitClients, worktreeDir: string): SimpleGit {
    return createGitClient(worktreeDir, this.buildGitEnv({ forceLfsSkip: true }), this.buildGitOptions(0));
  }

  // The single choke point for every write path. `worktreeDir` may be a
  // directory a user pointed us at rather than one we cloned, and a checkout
  // whose `.git` is a gitdir pointer — a linked worktree from `git worktree
  // add`, or a submodule — shares the config and refs of the repository that
  // owns it. Narrowing `remote.origin.fetch`, deleting `refs/remotes/origin/*`
  // and fetching with `--prune` there rewrite THAT repository, not this one.
  // The `--prune` fetch repeats on every tick; the narrowing and the ref
  // delete land whenever that repository's config reads unconverged, which for
  // a worktree-mode parent is every run, since its own init re-adds the wide
  // `+refs/heads/*` refspec. Read paths (getWorktrees, the origin/HEAD
  // probes) keep using localClientFor and still work on such a directory; only
  // writes go through here, and the branded return type is the only thing the
  // write helpers accept, so a mutation added later cannot skip the check.
  async mutatingClientsFor(worktreeDir: string): Promise<MutatingGitClients> {
    await this.assertPrimaryCheckout(worktreeDir);
    return {
      [PRIMARY_CHECKOUT_VERIFIED]: true,
      git: this.localClientFor(worktreeDir),
      networkGit: this.networkClientFor(worktreeDir),
      unshallowGit: this.unshallowClientFor(worktreeDir),
    };
  }

  // Client for the unshallow fetch. Same kind of network command as
  // networkClientFor, on the clone budget instead of the fetch one: it
  // transfers every commit the shallow clone skipped, which is the work the
  // initial clone would have done, not the work of an incremental fetch. The
  // budget is an inactivity window, and `--progress` keeps it fed for the whole
  // streaming phase; what it has to cover are the phases git runs silently at
  // either end — the server computing the shallow boundary and enumerating
  // objects before the first progress byte, and the connectivity check after
  // the last one — and both scale with total history, not with what changed.
  // See docs/internal/clone-mode-notes.md for why that is reasoning, not a
  // measurement.
  private unshallowClientFor(dir: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(this.getCloneTimeoutMs()));
  }

  // The configured setting plus the per-sync override the retry policy installs
  // on GitService once an attempt has died on an LFS error, so the retry's
  // fetch and `merge --ff-only` run with LFS downloads actually disabled.
  private isLfsSkipEnabled(): boolean {
    return this.host.config.skipLfs === true || this.host.gitService.isLfsSkipEnabled();
  }

  // Per-client additions layered over the sanitized process environment by
  // createGitClient, which also forces the C locale the missing-remote-ref and
  // LFS error classification depends on.
  private buildGitEnv(opts: { forceLfsSkip?: boolean } = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    if (opts.forceLfsSkip || this.isLfsSkipEnabled()) {
      env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] = "1";
    }
    return env;
  }

  // Progress and inactivity timeout only; createGitClient adds the env and the
  // unsafe-env allowances every client needs.
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
      // Fail closed: this guard exists to protect a repository we may not own,
      // so "cannot tell" must never be treated as "safe to mutate". Every call
      // site has already run a read probe here, so a failure now means the
      // checkout changed or broke under us.
      throw this.notPrimaryCheckoutError(
        resolvedDir,
        `its git directory could not be read (${getErrorMessage(error)})`,
        null,
      );
    }

    // git prints both paths relative to the directory it ran in when they sit
    // inside it (a plain clone prints ".git" twice) and absolute otherwise, so
    // resolve against the checkout rather than the process cwd.
    const [gitDirOutput, commonDirOutput] = output.split(/\r?\n/).map((line) => line.trim());
    if (!gitDirOutput || !commonDirOutput) {
      throw this.notPrimaryCheckoutError(resolvedDir, "'git rev-parse' did not report its git directory", null);
    }
    const gitDir = path.resolve(resolvedDir, gitDirOutput);
    const commonDir = path.resolve(resolvedDir, commonDirOutput);

    // `.git` must be a real directory belonging to this checkout. `git
    // worktree add` and `git submodule add` leave a FILE ('gitdir: ...') there,
    // which is the shape that makes the mutations below land in another
    // repository. A symlink is refused too: git reports a symlinked `.git`
    // exactly like a primary one, so a link that relocates this repo's own git
    // directory cannot be told apart from one aimed at a checkout that is
    // still using it — and only the second is safe to be wrong about.
    const gitEntry = await lstatOrNull(ownGitDir);
    if (gitEntry === null || !gitEntry.isDirectory()) {
      throw this.notPrimaryCheckoutError(
        resolvedDir,
        await describeGitEntry(ownGitDir, gitEntry),
        // git printed the symlink's own path for a symlinked `.git`; the
        // target is the directory the user has to reason about.
        (await realPathOrNull(commonDir)) ?? commonDir,
      );
    }

    if (gitDir === ownGitDir && commonDir === ownGitDir) return;

    // Same directory reached by a different path spelling (a symlinked parent
    // such as macOS '/tmp' -> '/private/tmp') — compare resolved paths before
    // refusing. The lstat above already established `.git` is this checkout's
    // own directory, so this only forgives path normalization.
    const [realOwnGitDir, realGitDir, realCommonDir] = await Promise.all([
      realPathOrNull(ownGitDir),
      realPathOrNull(gitDir),
      realPathOrNull(commonDir),
    ]);
    if (realOwnGitDir !== null && realGitDir === realOwnGitDir && realCommonDir === realOwnGitDir) return;

    // Say which half failed. A relocated linked worktree has a real `.git`
    // directory of its own and is caught only by the common dir, so naming
    // this checkout's own git directory there would read as a non sequitur.
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

// `.git` as a file is how `git worktree add` and `git submodule` mark a
// checkout owned by another repository; quoting the pointer makes the error
// recognizable without the user having to go look.
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
