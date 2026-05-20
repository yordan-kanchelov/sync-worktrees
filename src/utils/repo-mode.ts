import type { Config, RepositoryMode } from "../types";

export function resolveMode(cfg: Pick<Config, "mode">): RepositoryMode {
  return cfg.mode ?? "worktree";
}
