import { describe, expect, it } from "vitest";

import {
  KNOWN_DEFAULTS_KEYS,
  KNOWN_REPOSITORY_KEYS,
  KNOWN_TOP_LEVEL_KEYS,
  NESTED_KNOWN_KEYS,
  collectUnknownConfigKeys,
  formatUnknownConfigKey,
  suggestConfigKey,
} from "../unknown-config-keys";

import type {
  ConfigFile,
  HooksConfig,
  MaintenanceConfig,
  ParallelismConfig,
  RepositoryConfig,
  RetryConfig,
  SparseCheckoutConfig,
  TrashConfig,
} from "../../types";

/**
 * Drift guard, runtime half.
 *
 * `Record<keyof X, true>` cannot be written with a key missing or a key too
 * many, so each map below is `keyof X` made into a runtime value by the
 * compiler rather than by hand. Adding a field to `Config` (or to a nested
 * block) and stopping there fails `pnpm typecheck` twice over — on the
 * `_...KeysComplete` assertions in unknown-config-keys.ts and on the map here.
 * Adding it to both and mis-assembling the exported list — the lists are joined
 * with spreads, which no `satisfies` clause covers — fails the expectations
 * below instead. Between them there is no way to change the real key set and
 * leave the inventory behind.
 */
const EVERY_REPOSITORY_KEY: Record<keyof RepositoryConfig, true> = {
  name: true,
  repoUrl: true,
  worktreeDir: true,
  cronSchedule: true,
  runOnce: true,
  syncOnStart: true,
  bareRepoDir: true,
  retry: true,
  parallelism: true,
  branchMaxAge: true,
  branchInclude: true,
  branchExclude: true,
  skipLfs: true,
  updateExistingWorktrees: true,
  debug: true,
  logger: true,
  filesToCopyOnBranchCreate: true,
  hooks: true,
  sparseCheckout: true,
  maintenance: true,
  trash: true,
  mode: true,
  branch: true,
  depth: true,
  fetchTimeoutMs: true,
  cloneTimeoutMs: true,
  __configFileDir: true,
  __configuredRepoDirs: true,
};

const EVERY_TOP_LEVEL_KEY: Record<keyof ConfigFile, true> = {
  repositories: true,
  defaults: true,
  retry: true,
  parallelism: true,
};

const EVERY_NESTED_KEY: Record<keyof typeof NESTED_KNOWN_KEYS, Record<string, true>> = {
  retry: {
    maxAttempts: true,
    maxLfsRetries: true,
    initialDelayMs: true,
    maxDelayMs: true,
    backoffMultiplier: true,
    jitterMs: true,
  } satisfies Record<keyof RetryConfig, true>,
  parallelism: {
    maxRepositories: true,
    maxWorktreeCreation: true,
    maxWorktreeUpdates: true,
    maxWorktreeRemoval: true,
    maxStatusChecks: true,
    maxBranchFetches: true,
  } satisfies Record<keyof ParallelismConfig, true>,
  sparseCheckout: {
    include: true,
    exclude: true,
    mode: true,
    skipUpdateWhenOutsideSparse: true,
  } satisfies Record<keyof SparseCheckoutConfig, true>,
  trash: {
    enabled: true,
    retentionDays: true,
    warnSizeBytes: true,
    migrateLegacy: true,
  } satisfies Record<keyof TrashConfig, true>,
  maintenance: {
    enabled: true,
    interval: true,
    aggressive: true,
  } satisfies Record<keyof MaintenanceConfig, true>,
  hooks: { onBranchCreated: true } satisfies Record<keyof HooksConfig, true>,
};

describe("config key inventory", () => {
  it("lists exactly the keys a repository entry can carry", () => {
    expect([...KNOWN_REPOSITORY_KEYS].sort()).toEqual(Object.keys(EVERY_REPOSITORY_KEY).sort());
  });

  it("lists exactly the keys `defaults` can carry, which is a repository entry without its name", () => {
    const withoutName = Object.keys(EVERY_REPOSITORY_KEY).filter((key) => key !== "name");
    expect([...KNOWN_DEFAULTS_KEYS].sort()).toEqual(withoutName.sort());
  });

  it("lists exactly the top-level blocks the config file declares", () => {
    expect([...KNOWN_TOP_LEVEL_KEYS].sort()).toEqual(Object.keys(EVERY_TOP_LEVEL_KEY).sort());
  });

  it.each(Object.keys(EVERY_NESTED_KEY))("lists exactly the keys of the '%s' block", (block) => {
    const expected = Object.keys(EVERY_NESTED_KEY[block as keyof typeof EVERY_NESTED_KEY]).sort();
    expect([...NESTED_KNOWN_KEYS[block]].sort()).toEqual(expected);
  });
});

describe("suggestConfigKey", () => {
  it.each([
    ["updateExistingWorktree", "updateExistingWorktrees"],
    ["branchIncludes", "branchInclude"],
    ["sparseCheckOut", "sparseCheckout"],
    ["SKIPLFS", "skipLfs"],
    ["worktreDir", "worktreeDir"],
    // Two edits in each direction, on names long enough for the threshold to
    // allow two. A one-edit pair cannot tell a deletion from an insertion from
    // a substitution: every one of them costs 1 whatever the weights are, so
    // these are what pin the costs inside the distance itself.
    ["updateExistingWorktreesss", "updateExistingWorktrees"],
    ["worktrDir", "worktreeDir"],
    ["retyr", "retry"],
  ])("suggests the near miss: %s", (typo, expected) => {
    expect(suggestConfigKey(typo, KNOWN_REPOSITORY_KEYS)).toBe(expected);
  });

  it.each([["retries"], ["maxAge"], ["somethingEntirelyElse"]])(
    "offers no suggestion for a wrong word rather than a misspelling: %s",
    (typo) => {
      expect(suggestConfigKey(typo, KNOWN_REPOSITORY_KEYS)).toBeUndefined();
    },
  );

  it("does not call a short key a misspelling of a different short key", () => {
    // What the length gate is for: `nope` is two substitutions from `mode`, and
    // a four-letter key is allowed one edit, so it is not offered. The price is
    // the transposition: `anme` is two edits from `name` and gets nothing
    // either. `name` and `mode` are three edits apart — that pair is held apart
    // by the distance and would be with no gate at all.
    expect(suggestConfigKey("nope", KNOWN_REPOSITORY_KEYS)).toBeUndefined();
    expect(suggestConfigKey("anme", KNOWN_REPOSITORY_KEYS)).toBeUndefined();
    expect(suggestConfigKey("name", KNOWN_DEFAULTS_KEYS)).toBeUndefined();
  });

  it("breaks a tie alphabetically so the message does not depend on list order", () => {
    expect(suggestConfigKey("aaa", ["aab", "aac"])).toBe("aab");
    expect(suggestConfigKey("aaa", ["aac", "aab"])).toBe("aab");
  });
});

describe("collectUnknownConfigKeys", () => {
  const cleanConfig = {
    retry: { maxAttempts: 3 },
    parallelism: { maxRepositories: 2 },
    defaults: { cronSchedule: "0 * * * *", runOnce: false, syncOnStart: true, trash: { enabled: true } },
    repositories: [
      {
        name: "web",
        repoUrl: "https://example.com/web.git",
        worktreeDir: "/tmp/web",
        sparseCheckout: { include: ["src"], mode: "cone" },
      },
    ],
  };

  it("reports nothing for a config using only known keys", () => {
    expect(collectUnknownConfigKeys(cleanConfig)).toEqual([]);
  });

  it("reports nothing for a defaults-only key the loader rejects per repository", () => {
    // `syncOnStart` (like `runOnce`) is a whole-file switch: `validateConfigFile`
    // throws before this scan ever sees it on a repository entry, but it is a
    // perfectly good `defaults` key and warning on it would be a false alarm.
    expect(collectUnknownConfigKeys({ defaults: { syncOnStart: false }, repositories: [] })).toEqual([]);
    expect(KNOWN_DEFAULTS_KEYS).toContain("syncOnStart");
  });

  it("reports nothing for internal keys the loader writes itself", () => {
    expect(
      collectUnknownConfigKeys({
        repositories: [{ name: "web", __configFileDir: "/tmp", __configuredRepoDirs: ["/tmp/web"], logger: undefined }],
      }),
    ).toEqual([]);
  });

  it("names the repository, the key and the suggestion for a misspelled repository key", () => {
    const found = collectUnknownConfigKeys({
      repositories: [{ name: "reference", updateExistingWorktree: false }],
    });

    expect(found).toEqual([
      {
        location: "in repository 'reference'",
        keyPath: "updateExistingWorktree",
        suggestion: "updateExistingWorktrees",
      },
    ]);
  });

  it("reaches unknown keys under defaults and at the top level", () => {
    const found = collectUnknownConfigKeys({
      cronScedule: "0 * * * *",
      defaults: { updatExistingWorktrees: true },
      repositories: [],
    });

    expect(found).toEqual([
      { location: "at the top level", keyPath: "cronScedule", suggestion: undefined },
      { location: "in defaults", keyPath: "updatExistingWorktrees", suggestion: "updateExistingWorktrees" },
    ]);
  });

  it("holds the three levels apart: each is scanned against its own inventory", () => {
    // A real `Config` key is still unknown at the top level, where nothing
    // reads it; `name` is a repository key and is unknown under `defaults`.
    const found = collectUnknownConfigKeys({
      updateExistingWorktrees: false,
      defaults: { name: "web" },
      repositories: [{ name: "web", repositories: [] }],
    });

    expect(found.map((entry) => `${entry.location}|${entry.keyPath}`)).toEqual([
      "at the top level|updateExistingWorktrees",
      "in defaults|name",
      "in repository 'web'|repositories",
    ]);
  });

  it("reaches one level down, into every block that is an object", () => {
    const found = collectUnknownConfigKeys({
      retry: { maxAttemptz: 5 },
      parallelism: { maxStatusCheck: 4 },
      defaults: { maintenance: { intervals: "7d" }, hooks: { onBranchCreate: [] } },
      repositories: [{ name: "web", trash: { retentionDay: 5 }, sparseCheckout: { includes: ["src"] } }],
    });

    expect(found.map((entry) => `${entry.keyPath}|${entry.suggestion ?? "-"}`)).toEqual([
      "retry.maxAttemptz|maxAttempts",
      "parallelism.maxStatusCheck|maxStatusChecks",
      "maintenance.intervals|interval",
      "hooks.onBranchCreate|onBranchCreated",
      "trash.retentionDay|retentionDays",
      "sparseCheckout.includes|include",
    ]);
  });

  it("treats a key present with the value undefined as present, not unknown", () => {
    // `{ maxStatusChecks: Number(process.env.X) || undefined }` is a real shape
    // in config files: a known key whose value is undefined is a known key.
    const found = collectUnknownConfigKeys({
      repositories: [{ name: "web", updateExistingWorktrees: undefined, parallelism: { maxStatusChecks: undefined } }],
    });

    expect(found).toEqual([]);
  });

  it("still reports an unknown key whose value is undefined", () => {
    const found = collectUnknownConfigKeys({ repositories: [{ name: "web", updateExistingWorktree: undefined }] });

    expect(found.map((entry) => entry.keyPath)).toEqual(["updateExistingWorktree"]);
  });

  it("does not descend into a block whose value is not an object", () => {
    expect(collectUnknownConfigKeys({ repositories: [{ name: "web", retry: "nope" }] })).toEqual([]);
    expect(collectUnknownConfigKeys({ repositories: [{ name: "web", hooks: [{ nope: 1 }] }] })).toEqual([]);
  });

  it("falls back to the index when a repository has no usable name", () => {
    const found = collectUnknownConfigKeys({ repositories: ["not-an-object", { nope: 1 }] });

    expect(found).toEqual([{ location: "in repository at index 1", keyPath: "nope", suggestion: undefined }]);
  });
});

describe("formatUnknownConfigKey", () => {
  it("names the repository and the key, and appends the suggestion when there is one", () => {
    expect(
      formatUnknownConfigKey({
        location: "in repository 'reference'",
        keyPath: "updateExistingWorktree",
        suggestion: "updateExistingWorktrees",
      }),
    ).toBe(
      "[sync-worktrees] Unknown config key 'updateExistingWorktree' in repository 'reference' is ignored " +
        "(did you mean 'updateExistingWorktrees'?)",
    );
  });

  it("omits the parenthetical entirely when nothing is close enough", () => {
    expect(formatUnknownConfigKey({ location: "at the top level", keyPath: "nonsense" })).toBe(
      "[sync-worktrees] Unknown config key 'nonsense' at the top level is ignored",
    );
  });
});
