import type { Config, RepositoryMode } from "../types";

export const REPOSITORY_MODES = {
  CLONE: "clone",
  WORKTREE: "worktree",
} as const satisfies Record<string, RepositoryMode>;

export function resolveMode(cfg: Pick<Config, "mode">): RepositoryMode {
  return cfg.mode ?? REPOSITORY_MODES.WORKTREE;
}
