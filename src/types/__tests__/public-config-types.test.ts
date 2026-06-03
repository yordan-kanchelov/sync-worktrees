import { describe, expect, it } from "vitest";

import type { SyncWorktreesConfig, SyncWorktreesRepository } from "../../index";
import type { Config, SyncWorktreesWorktreeRepository } from "../index";

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Drift guard: every key of the internal resolved `Config` must be consciously
 * sorted into exactly one bucket below. A newly added `Config` field that nobody
 * classifies makes `UnclassifiedConfigKeys` non-`never`, breaking
 * `_AllConfigKeysClassified` at compile time (`pnpm typecheck`). This forces a
 * deliberate decision about whether each new field belongs on the public config
 * surface instead of letting the hand-written public types silently fall behind.
 */
type CommonConfigKeys =
  | "cronSchedule"
  | "runOnce"
  | "retry"
  | "parallelism"
  | "skipLfs"
  | "debug"
  | "filesToCopyOnBranchCreate"
  | "hooks"
  | "sparseCheckout"
  | "maintenance";
type WorktreeOnlyConfigKeys =
  | "bareRepoDir"
  | "branchMaxAge"
  | "branchInclude"
  | "branchExclude"
  | "updateExistingWorktrees";
type CloneOnlyConfigKeys = "branch" | "depth";
type DiscriminantConfigKeys = "mode";
type BaseIdentityConfigKeys = "repoUrl" | "worktreeDir";
// Set internally or read only at runtime — intentionally absent from the public input surface.
type InternalOnlyConfigKeys = "logger" | "__configFileDir" | "fetchTimeoutMs" | "cloneTimeoutMs";

type ClassifiedConfigKeys =
  | CommonConfigKeys
  | WorktreeOnlyConfigKeys
  | CloneOnlyConfigKeys
  | DiscriminantConfigKeys
  | BaseIdentityConfigKeys
  | InternalOnlyConfigKeys;

type UnclassifiedConfigKeys = Exclude<keyof Config, ClassifiedConfigKeys>;
type _AllConfigKeysClassified = Expect<Equal<UnclassifiedConfigKeys, never>>;

/**
 * Each common field must exist on the public repository type with a value type
 * matching internal `Config` (optionality stripped — public input is optional even
 * where the resolved `Config` is required). Both sides are normalized to concrete
 * object shapes before comparison: a per-key `Equal` stays deferred (`boolean`)
 * while `K` is generic, but comparing the assembled shapes resolves to a literal.
 * A common key missing from the public repository type makes `[K]` an index error,
 * so a forgotten public field also fails closed.
 */
type PublicCommonShape = { [K in CommonConfigKeys]-?: Exclude<SyncWorktreesWorktreeRepository[K], undefined> };
type InternalCommonShape = { [K in CommonConfigKeys]-?: Exclude<Config[K], undefined> };
type _CommonFieldTypesMatch = Expect<Equal<PublicCommonShape, InternalCommonShape>>;

const minimalConfig = {
  repositories: [
    {
      name: "minimal",
      repoUrl: "https://github.com/example/minimal.git",
      worktreeDir: "./worktrees/minimal",
    },
  ],
} satisfies SyncWorktreesConfig;

const worktreeModeConfig = {
  defaults: {
    cronSchedule: "0 * * * *",
    runOnce: false,
    retry: {
      maxAttempts: "unlimited",
      maxLfsRetries: 2,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      backoffMultiplier: 2,
      jitterMs: 500,
    },
    parallelism: {
      maxRepositories: 2,
      maxBranchFetches: 3,
    },
    debug: true,
    sparseCheckout: {
      include: ["src"],
      skipUpdateWhenOutsideSparse: false,
    },
    hooks: {
      onBranchCreated: ["echo {WORKTREE_PATH}"],
    },
  },
  repositories: [
    {
      name: "worktree",
      repoUrl: "https://github.com/example/worktree.git",
      worktreeDir: "./worktrees/worktree",
      mode: "worktree",
      bareRepoDir: "./.bare/worktree",
      branchInclude: ["feature/*"],
      branchExclude: ["feature/wip-*"],
      branchMaxAge: "30d",
      updateExistingWorktrees: false,
    },
  ],
} satisfies SyncWorktreesConfig;

const cloneModeConfig = {
  repositories: [
    {
      name: "clone",
      repoUrl: "https://github.com/example/clone.git",
      worktreeDir: "./clone",
      mode: "clone",
      branch: "main",
      depth: 1,
      skipLfs: true,
      debug: false,
      filesToCopyOnBranchCreate: [".env.local"],
      sparseCheckout: { include: ["packages/app"] },
    },
  ],
} satisfies SyncWorktreesConfig;

// @ts-expect-error clone mode does not accept worktree branch filters.
const invalidCloneRepository: SyncWorktreesRepository = {
  name: "bad-clone",
  repoUrl: "https://github.com/example/bad-clone.git",
  worktreeDir: "./bad-clone",
  mode: "clone",
  branchInclude: ["feature/*"],
};

// @ts-expect-error worktree mode does not accept clone-only branch pins.
const invalidWorktreeRepository: SyncWorktreesRepository = {
  name: "bad-worktree",
  repoUrl: "https://github.com/example/bad-worktree.git",
  worktreeDir: "./worktrees/bad-worktree",
  mode: "worktree",
  branch: "main",
};

describe("public config types", () => {
  it("accept user-authored config shapes without cronSchedule or runOnce on repositories", () => {
    expect(minimalConfig.repositories[0]).not.toHaveProperty("cronSchedule");
    expect(minimalConfig.repositories[0]).not.toHaveProperty("runOnce");
    expect(worktreeModeConfig.repositories[0].mode).toBe("worktree");
    expect(cloneModeConfig.repositories[0].mode).toBe("clone");
    expect(invalidCloneRepository.mode).toBe("clone");
    expect(invalidWorktreeRepository.mode).toBe("worktree");
  });
});
