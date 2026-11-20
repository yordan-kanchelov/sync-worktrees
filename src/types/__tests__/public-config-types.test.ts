import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SyncWorktreesConfig, SyncWorktreesMaintenanceConfig, SyncWorktreesRepository } from "../../public-types";
import type { Config, MaintenanceConfig, SyncWorktreesWorktreeRepository } from "../index";

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type CommonConfigKeys =
  | "cronSchedule"
  | "retry"
  | "parallelism"
  | "skipLfs"
  | "debug"
  | "filesToCopyOnBranchCreate"
  | "hooks"
  | "sparseCheckout"
  | "maintenance"
  | "fetchTimeoutMs"
  | "cloneTimeoutMs";
type WorktreeOnlyConfigKeys =
  "bareRepoDir" | "branchMaxAge" | "branchInclude" | "branchExclude" | "updateExistingWorktrees" | "trash";
type CloneOnlyConfigKeys = "branch" | "depth";
type DefaultsOnlyConfigKeys = "runOnce" | "syncOnStart";
type DiscriminantConfigKeys = "mode";
type BaseIdentityConfigKeys = "repoUrl" | "worktreeDir";
type InternalOnlyConfigKeys = "logger" | "__configFileDir" | "__configuredRepoDirs";

type ClassifiedConfigKeys =
  | CommonConfigKeys
  | WorktreeOnlyConfigKeys
  | CloneOnlyConfigKeys
  | DefaultsOnlyConfigKeys
  | DiscriminantConfigKeys
  | BaseIdentityConfigKeys
  | InternalOnlyConfigKeys;

type UnclassifiedConfigKeys = Exclude<keyof Config, ClassifiedConfigKeys>;
type _AllConfigKeysClassified = Expect<Equal<UnclassifiedConfigKeys, never>>;

type PublicCommonShape = { [K in CommonConfigKeys]-?: Exclude<SyncWorktreesWorktreeRepository[K], undefined> };
type InternalCommonShape = { [K in CommonConfigKeys]-?: Exclude<Config[K], undefined> };
type _CommonFieldTypesMatch = Expect<Equal<PublicCommonShape, InternalCommonShape>>;

type PublicWorktreeOnlyShape = {
  [K in WorktreeOnlyConfigKeys]-?: Exclude<SyncWorktreesWorktreeRepository[K], undefined>;
};
type InternalWorktreeOnlyShape = { [K in WorktreeOnlyConfigKeys]-?: Exclude<Config[K], undefined> };
type _WorktreeOnlyFieldTypesMatch = Expect<Equal<PublicWorktreeOnlyShape, InternalWorktreeOnlyShape>>;
type _MaintenanceAliasMatches = Expect<Equal<SyncWorktreesMaintenanceConfig, MaintenanceConfig>>;

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function publicTypeModules(): string[] {
  const seen = new Set<string>();
  const queue = [path.join(srcDir, "public-types.ts")];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s*["'](\.\.?\/[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const target = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((c) => existsSync(c));
      if (!target) throw new Error(`${file}: cannot resolve ${match[1]}`);
      queue.push(target);
    }
  }
  return [...seen].map((file) => path.relative(srcDir, file).split(path.sep).join("/")).sort();
}

const _minimalConfig = {
  repositories: [
    {
      name: "minimal",
      repoUrl: "https://github.com/example/minimal.git",
      worktreeDir: "./worktrees/minimal",
    },
  ],
} satisfies SyncWorktreesConfig;

const _worktreeModeConfig = {
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
    fetchTimeoutMs: 0,
    cloneTimeoutMs: 1_800_000,
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

const _cloneModeConfig = {
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
      fetchTimeoutMs: 600_000,
      cloneTimeoutMs: 0,
    },
  ],
} satisfies SyncWorktreesConfig;

// @ts-expect-error clone mode does not accept worktree branch filters.
const _invalidCloneRepository: SyncWorktreesRepository = {
  name: "bad-clone",
  repoUrl: "https://github.com/example/bad-clone.git",
  worktreeDir: "./bad-clone",
  mode: "clone",
  branchInclude: ["feature/*"],
};

// @ts-expect-error worktree mode does not accept clone-only branch pins.
const _invalidWorktreeRepository: SyncWorktreesRepository = {
  name: "bad-worktree",
  repoUrl: "https://github.com/example/bad-worktree.git",
  worktreeDir: "./worktrees/bad-worktree",
  mode: "worktree",
  branch: "main",
};

describe("public config types", () => {
  it("keeps the public declaration graph free of internal modules", () => {
    expect(publicTypeModules()).toEqual(["public-types.ts", "types/public-config.ts"]);
  });
});
