import type { Config, RepositoryMode } from "../types";

export const REPOSITORY_MODES = {
  CLONE: "clone",
  WORKTREE: "worktree",
} as const satisfies Record<string, RepositoryMode>;

export function isRepositoryMode(value: unknown): value is RepositoryMode {
  return value === REPOSITORY_MODES.CLONE || value === REPOSITORY_MODES.WORKTREE;
}

export function resolveMode(cfg: Pick<Config, "mode">): RepositoryMode {
  return cfg.mode ?? REPOSITORY_MODES.WORKTREE;
}
