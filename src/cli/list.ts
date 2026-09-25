import pLimit from "p-limit";

import { ConfigLoaderService } from "../services/config-loader.service";
import { Logger } from "../services/logger.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { describeConfigPath } from "../utils/config-discovery";
import { configLoadErrorMessage, getErrorMessage } from "../utils/errors";
import { fileExists } from "../utils/file-exists";
import { redactRepoUrl, redactSecretsInText } from "../utils/git-url";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";

import type { RepositoryConfig, RepositoryMode, SparseCheckoutMode } from "../types";
import type { ResolvedConfigPath } from "../utils/config-discovery";

/** What is on disk for one repository right now. `null` is "could not be read", or no trash (clone mode). */
export interface RepositoryDiskCounts {
  /** Registered worktrees whose directory exists; in clone mode, 1 once the clone exists. */
  worktrees: number | null;
  /** Readable entries under `<worktreeDir>/.trash`; always `null` in clone mode, which has no trash. */
  trashEntries: number | null;
  /** Why a count is `null` when it should have been a number, redacted. */
  error: string | null;
}

/** One element of `sync-worktrees list --json`. Every key is always present. */
export interface ListedRepository {
  name: string;
  mode: RepositoryMode;
  /** With any embedded credentials removed. */
  repoUrl: string;
  worktreeDir: string;
  /** Worktree mode only. */
  bareRepoDir: string | null;
  /** Clone mode only, and only when pinned; `null` tracks the remote default branch. */
  branch: string | null;
  schedule: string;
  runOnce: boolean;
  skipLfs: boolean;
  filters: {
    branchInclude: string[] | null;
    branchExclude: string[] | null;
    branchMaxAge: string | null;
  };
  sparseCheckout: {
    include: string[];
    exclude: string[];
    mode: SparseCheckoutMode;
    skipUpdateWhenOutsideSparse: boolean;
  } | null;
  counts: RepositoryDiskCounts;
}

export interface ListOptions {
  filter?: string;
  json?: boolean;
}

export interface ListDependencies {
  loadRepositories(configPath: string, filter?: string): Promise<RepositoryConfig[]>;
  countOnDisk(repo: RepositoryConfig): Promise<RepositoryDiskCounts>;
}

const COUNT_CONCURRENCY = 4;

/**
 * Local reads only: `git worktree list` against the bare repository and a
 * directory listing of the trash. No fetch, no lock — `list` must stay safe to
 * run next to a sync that holds the repository.
 */
export async function countOnDisk(repo: RepositoryConfig): Promise<RepositoryDiskCounts> {
  const logger = Logger.createDefault(repo.name, false, { quiet: true });
  const cloneMode = resolveMode(repo) === REPOSITORY_MODES.CLONE;
  try {
    const service = new WorktreeSyncService({ ...repo, debug: false, logger });
    if (cloneMode) {
      return { worktrees: (await service.getWorktrees()).length, trashEntries: null, error: null };
    }
    // Before the first sync there is no bare repository to ask, and nothing
    // could have been checked out or trashed without one.
    const bareRepoDir = repo.bareRepoDir;
    const worktrees =
      bareRepoDir && (await fileExists(bareRepoDir))
        ? (await service.getWorktrees({ includeDetached: true })).filter((worktree) => worktree.isPrunable !== true)
            .length
        : 0;
    const { entries } = await service.listTrashEntries();
    return { worktrees, trashEntries: entries.length, error: null };
  } catch (error) {
    return { worktrees: null, trashEntries: null, error: redactSecretsInText(getErrorMessage(error)) };
  }
}

export function toListedRepository(repo: RepositoryConfig, counts: RepositoryDiskCounts): ListedRepository {
  const mode = resolveMode(repo);
  const sparse = repo.sparseCheckout;
  return {
    name: repo.name,
    mode,
    repoUrl: redactRepoUrl(repo.repoUrl),
    worktreeDir: repo.worktreeDir,
    bareRepoDir: mode === REPOSITORY_MODES.WORKTREE ? (repo.bareRepoDir ?? null) : null,
    branch: mode === REPOSITORY_MODES.CLONE ? (repo.branch ?? null) : null,
    schedule: repo.cronSchedule,
    runOnce: repo.runOnce,
    skipLfs: repo.skipLfs === true,
    filters: {
      branchInclude: repo.branchInclude ?? null,
      branchExclude: repo.branchExclude ?? null,
      branchMaxAge: repo.branchMaxAge ?? null,
    },
    sparseCheckout: sparse
      ? {
          include: sparse.include,
          exclude: sparse.exclude ?? [],
          mode: sparse.mode ?? "cone",
          skipUpdateWhenOutsideSparse: sparse.skipUpdateWhenOutsideSparse ?? true,
        }
      : null,
    counts,
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatDiskCounts(listed: Pick<ListedRepository, "mode" | "counts">): string {
  const { counts } = listed;
  if (counts.worktrees === null) {
    return `unknown${counts.error ? ` (${counts.error})` : ""}`;
  }
  if (listed.mode === REPOSITORY_MODES.CLONE) {
    return counts.worktrees > 0 ? "cloned" : "not cloned yet";
  }
  const parts = [plural(counts.worktrees, "worktree")];
  if (counts.trashEntries !== null) parts.push(plural(counts.trashEntries, "trash entry", "trash entries"));
  return parts.join(", ");
}

export function formatListedRepository(listed: ListedRepository, index: number): string[] {
  const lines = [
    `${index + 1}. ${listed.name}`,
    `   Mode: ${listed.mode}`,
    `   URL: ${listed.repoUrl}`,
    `   Worktrees: ${listed.worktreeDir}`,
    `   Schedule: ${listed.schedule}`,
    `   Run Once: ${listed.runOnce}`,
  ];
  if (listed.bareRepoDir) lines.push(`   Bare repo: ${listed.bareRepoDir}`);
  if (listed.branch) lines.push(`   Branch: ${listed.branch}`);
  if (listed.skipLfs) lines.push(`   Skip LFS: true`);

  const { branchInclude, branchExclude, branchMaxAge } = listed.filters;
  const filters = [
    branchInclude ? `include ${branchInclude.join(", ")}` : null,
    branchExclude ? `exclude ${branchExclude.join(", ")}` : null,
    branchMaxAge ? `max age ${branchMaxAge}` : null,
  ].filter((part): part is string => part !== null);
  if (filters.length > 0) lines.push(`   Branch filters: ${filters.join("; ")}`);

  const sparse = listed.sparseCheckout;
  if (sparse) {
    const exclude = sparse.exclude.length > 0 ? `; exclude ${sparse.exclude.join(", ")}` : "";
    lines.push(`   Sparse checkout (${sparse.mode}): include ${sparse.include.join(", ")}${exclude}`);
  }

  lines.push(`   On disk: ${formatDiskCounts(listed)}`);
  return lines;
}

const defaultDependencies: ListDependencies = {
  loadRepositories: async (configPath, filter) =>
    (await new ConfigLoaderService().buildRepositories(configPath, { filter })).repositories,
  countOnDisk,
};

/**
 * `sync-worktrees list`. Resolves to the exit code: 1 when the config does not
 * load or `--filter` matches nothing, both reported on stderr so that `--json`
 * leaves stdout empty rather than half a document.
 */
export async function runList(
  config: ResolvedConfigPath,
  options: ListOptions = {},
  deps: ListDependencies = defaultDependencies,
): Promise<number> {
  let repositories: RepositoryConfig[];
  try {
    repositories = await deps.loadRepositories(config.path, options.filter);
  } catch (error) {
    console.error("❌ Error loading config file:", configLoadErrorMessage(error));
    return 1;
  }

  if (options.filter && repositories.length === 0) {
    console.error(`❌ No repositories match filter: ${options.filter}`);
    return 1;
  }

  const limit = pLimit(COUNT_CONCURRENCY);
  const listed = await Promise.all(
    repositories.map((repo) => limit(async () => toListedRepository(repo, await deps.countOnDisk(repo)))),
  );

  if (options.json === true) {
    console.log(JSON.stringify(listed, null, 2));
    return 0;
  }

  console.log(`📄 Using config: ${describeConfigPath(config)}`);
  console.log("\n📋 Configured repositories:\n");
  listed.forEach((repo, index) => {
    for (const line of formatListedRepository(repo, index)) console.log(line);
    console.log("");
  });
  return 0;
}
