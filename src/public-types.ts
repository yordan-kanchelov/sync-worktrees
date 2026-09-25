// The package's public type surface: what `import("sync-worktrees")` resolves
// to for TypeScript and JSDoc (`@satisfies {import("sync-worktrees").SyncWorktreesConfig}`
// in a config file). package.json `exports["."].types` points at the
// declaration emitted for this file, and `tsconfig.types.json` emits
// declarations for it and what it imports, nothing else. Everything else in
// src/ is internal.
export type {
  SyncWorktreesConfig,
  SyncWorktreesDefaults,
  SyncWorktreesHooksConfig,
  SyncWorktreesParallelismConfig,
  SyncWorktreesRepository,
  SyncWorktreesRepositoryMode,
  SyncWorktreesRetryConfig,
  SyncWorktreesSparseCheckoutConfig,
  SyncWorktreesSparseCheckoutMode,
  SyncWorktreesTrashConfig,
} from "./types";
