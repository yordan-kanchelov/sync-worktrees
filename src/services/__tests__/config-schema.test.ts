import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "../../errors";
import { KNOWN_CONFIG_KEYS, configFileSchema, validateConfigFile } from "../config-schema";

import type { defaultsSchema, repositorySchema } from "../config-schema";
import type { ConfigValidationIssue } from "../../errors";
import type { SyncWorktreesConfig } from "../../public-types";
import type {
  Config,
  ConfigFile,
  HooksConfig,
  MaintenanceConfig,
  ParallelismConfig,
  RepositoryConfig,
  RetryConfig,
  SparseCheckoutConfig,
  TrashConfig,
} from "../../types";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Type-level half: the schema and the handwritten types describe the same
// config. The handwritten types stay the source of the public surface — its
// clone/worktree discriminated unions are not something `z.infer` produces —
// so these assertions are what keeps the two from drifting. A field added to
// one and not the other fails `pnpm typecheck`.
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RepositoryOutput = z.output<typeof repositorySchema>;
type DefaultsOutput = z.output<typeof defaultsSchema>;
type ConfigFileOutput = z.output<typeof configFileSchema>;

/** Declared so they are known keys, but never validated: the loader computes or ignores them. */
type InternalKeys = "logger" | "__configFileDir" | "__configuredRepoDirs";
/** Whole-file settings: booleans under `defaults`, rejected on a repository entry. */
type WholeFileKeys = "runOnce" | "syncOnStart";

type ValueShape<T, K extends keyof T> = { [P in K]-?: Exclude<T[P], undefined> };

type _RepositoryKeysMatch = Expect<Equal<keyof RepositoryOutput, keyof RepositoryConfig>>;
type _DefaultsKeysMatch = Expect<Equal<keyof DefaultsOutput, keyof Config>>;
type _TopLevelKeysMatch = Expect<Equal<keyof ConfigFileOutput, keyof ConfigFile>>;

type RepositoryValueKeys = Exclude<keyof RepositoryConfig, InternalKeys | WholeFileKeys>;
type _RepositoryValuesMatch = Expect<
  Equal<ValueShape<RepositoryOutput, RepositoryValueKeys>, ValueShape<RepositoryConfig, RepositoryValueKeys>>
>;
type DefaultsValueKeys = Exclude<keyof Config, InternalKeys>;
type _DefaultsValuesMatch = Expect<
  Equal<ValueShape<DefaultsOutput, DefaultsValueKeys>, ValueShape<Config, DefaultsValueKeys>>
>;

// Each nested block on its own, so a mismatch names the block.
type _RetryMatches = Expect<Equal<Exclude<RepositoryOutput["retry"], undefined>, RetryConfig>>;
type _ParallelismMatches = Expect<Equal<Exclude<RepositoryOutput["parallelism"], undefined>, ParallelismConfig>>;
type _HooksMatch = Expect<Equal<Exclude<RepositoryOutput["hooks"], undefined>, HooksConfig>>;
type _SparseCheckoutMatches = Expect<
  Equal<Exclude<RepositoryOutput["sparseCheckout"], undefined>, SparseCheckoutConfig>
>;
type _MaintenanceMatches = Expect<Equal<Exclude<RepositoryOutput["maintenance"], undefined>, MaintenanceConfig>>;
type _TrashMatches = Expect<Equal<Exclude<RepositoryOutput["trash"], undefined>, TrashConfig>>;

// Every config the public type admits is one the schema's input type admits.
type _PublicConfigIsSchemaInput = Expect<SyncWorktreesConfig extends z.input<typeof configFileSchema> ? true : false>;

// ---------------------------------------------------------------------------
// Runtime half
// ---------------------------------------------------------------------------

const URL = "https://github.com/example/web.git";

function repo(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "web", repoUrl: URL, worktreeDir: "/tmp/web", ...extra };
}

function config(extra: Record<string, unknown> = {}, repoExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repositories: [repo(repoExtra)], ...extra };
}

function issuesOf(value: unknown): ConfigValidationIssue[] {
  try {
    validateConfigFile(value);
    return [];
  } catch (error) {
    if (error instanceof ConfigValidationError) return [...error.issues];
    throw error;
  }
}

/** The one issue a config raises, as `field: reason`. */
function onlyIssue(value: unknown): string {
  const issues = issuesOf(value);
  expect(issues).toHaveLength(1);
  return `${issues[0].field}: ${issues[0].reason}`;
}

const TIMEOUT_RULE = "must be 0 (disables the timeout) or a whole number of milliseconds from 1000 to 2147483647, got";

describe("validateConfigFile: the file and its repository entries", () => {
  it.each<[string, unknown, string]>([
    ["a string export", "nope", `default export: must be an object with a 'repositories' array, got "nope"`],
    ["an array export", [], "default export: must be an object with a 'repositories' array, got an array"],
    ["a null export", null, "default export: must be an object with a 'repositories' array, got null"],
    ["no repositories", {}, "repositories: is required"],
    [
      "repositories that is not an array",
      { repositories: {} },
      "repositories: must be an array of repository entries, got an object",
    ],
    ["no repository at all", { repositories: [] }, "repositories: must contain at least one repository"],
    ["an entry that is not an object", { repositories: [42] }, "repositories[0]: must be an object, got 42"],
    [
      "an entry without a name",
      { repositories: [{ repoUrl: URL, worktreeDir: "/w" }] },
      "repositories[0].name: is required",
    ],
    ["a blank name", config({}, { name: "  " }), `repositories[0].name: must be a non-empty string, got "  "`],
    ["a non-string name", config({}, { name: 7 }), "repositories[0].name: must be a non-empty string, got 7"],
    ["no repoUrl", config({}, { repoUrl: undefined }), "repositories[0].repoUrl: is required"],
    ["no worktreeDir", config({}, { worktreeDir: undefined }), "repositories[0].worktreeDir: is required"],
    [
      "an empty worktreeDir",
      config({}, { worktreeDir: "" }),
      `repositories[0].worktreeDir: must be a non-empty string, got ""`,
    ],
    [
      "a non-string bareRepoDir",
      config({}, { bareRepoDir: 1 }),
      "repositories[0].bareRepoDir: must be a string, got 1",
    ],
    [
      "a non-string cronSchedule",
      config({}, { cronSchedule: 5 }),
      "repositories[0].cronSchedule: must be a cron expression string, got 5",
    ],
    [
      "an invalid cron expression",
      config({}, { cronSchedule: "every hour" }),
      "repositories[0].cronSchedule: 'every hour' is not a valid cron expression",
    ],
    [
      "runOnce on a repository",
      config({}, { runOnce: true }),
      "repositories[0].runOnce: cannot be set on a repository; use defaults.runOnce",
    ],
    [
      "syncOnStart on a repository",
      config({}, { syncOnStart: false }),
      "repositories[0].syncOnStart: cannot be set on a repository; use defaults.syncOnStart",
    ],
    ["a non-boolean debug", config({}, { debug: "yes" }), `repositories[0].debug: must be a boolean, got "yes"`],
    ["a non-boolean skipLfs", config({}, { skipLfs: 1 }), "repositories[0].skipLfs: must be a boolean, got 1"],
    [
      "a non-boolean updateExistingWorktrees",
      config({}, { updateExistingWorktrees: "false" }),
      `repositories[0].updateExistingWorktrees: must be a boolean, got "false"`,
    ],
    [
      "a branchInclude that is not a list",
      config({}, { branchInclude: "main" }),
      `repositories[0].branchInclude: must be an array of strings, got "main"`,
    ],
    [
      "a non-string branchExclude pattern",
      config({}, { branchExclude: ["ok", 3] }),
      "repositories[0].branchExclude[1]: must be a string, got 3",
    ],
    [
      "a blank branchInclude pattern",
      config({}, { branchInclude: ["main", " "] }),
      "repositories[0].branchInclude[1]: must not be empty or whitespace-only: such a pattern matches no branch, " +
        "and a branchInclude matching nothing prunes every worktree. Omit the field to sync every branch",
    ],
    [
      "an unparseable branchMaxAge",
      config({}, { branchMaxAge: "two weeks" }),
      `repositories[0].branchMaxAge: must be a duration string like '14d', '12h', or '2w', got "two weeks"`,
    ],
    [
      "a non-integer depth",
      config({}, { mode: "clone", depth: 1.5 }),
      "repositories[0].depth: must be a positive safe integer, got 1.5",
    ],
    [
      "a zero depth",
      config({}, { mode: "clone", depth: 0 }),
      "repositories[0].depth: must be a positive safe integer, got 0",
    ],
    [
      "an unknown mode",
      config({}, { mode: "mirror" }),
      `repositories[0].mode: must be 'clone' or 'worktree', got "mirror"`,
    ],
    [
      "a blank branch",
      config({}, { mode: "clone", branch: " " }),
      `repositories[0].branch: must be a non-empty string, got " "`,
    ],
    [
      "a one-second-short fetchTimeoutMs",
      config({}, { fetchTimeoutMs: 999 }),
      `repositories[0].fetchTimeoutMs: ${TIMEOUT_RULE} 999`,
    ],
    [
      "a fetchTimeoutMs past setTimeout's ceiling",
      config({}, { fetchTimeoutMs: 2_147_483_648 }),
      `repositories[0].fetchTimeoutMs: ${TIMEOUT_RULE} 2147483648`,
    ],
    [
      "a fractional cloneTimeoutMs",
      config({}, { cloneTimeoutMs: 1500.5 }),
      `repositories[0].cloneTimeoutMs: ${TIMEOUT_RULE} 1500.5`,
    ],
    [
      "a NaN cloneTimeoutMs",
      config({}, { cloneTimeoutMs: Number.NaN }),
      `repositories[0].cloneTimeoutMs: ${TIMEOUT_RULE} NaN`,
    ],
  ])("rejects %s", (_label, value, expected) => {
    expect(onlyIssue(value)).toBe(expected);
  });

  it("rejects a duplicate name, pointing at the first use", () => {
    expect(onlyIssue({ repositories: [repo(), repo({ worktreeDir: "/tmp/other" })] })).toBe(
      "repositories[1].name: duplicate repository name 'web' (already used by repositories[0])",
    );
  });

  it("names the formats a repoUrl may take, and redacts the credentials in the one it got", () => {
    const [issue] = issuesOf(config({}, { repoUrl: "ftp://bot:s3cr3t@example.com/repo.git" }));

    expect(issue.field).toBe("repositories[0].repoUrl");
    expect(issue.reason).toMatch(/^is not a repository URL, got "ftp:\/\/\*\*\*@example.com\/repo.git"\. Expected /);
    expect(issue.reason).not.toContain("s3cr3t");
  });

  it("redacts a credential-bearing string shown as the value found, before shortening it", () => {
    const [issue] = issuesOf(config({}, { debug: `https://bot:${"x".repeat(80)}@example.com/repo.git` }));

    expect(issue.reason).toBe(`must be a boolean, got "https://***@example.com/repo.git"`);
  });

  it("shortens a long string shown as the value found", () => {
    const [issue] = issuesOf(config({}, { skipLfs: "y".repeat(100) }));

    expect(issue.reason).toBe(`must be a boolean, got "${"y".repeat(57)}..."`);
  });
});

describe("validateConfigFile: nested blocks", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["a retry that is not an object", { retry: "3" }, `retry: must be an object, got "3"`],
    ["a retry that is an array", { retry: [] }, "retry: must be an object, got an array"],
    [
      "a zero maxAttempts",
      { retry: { maxAttempts: 0 } },
      "retry.maxAttempts: must be 'unlimited' or a positive safe integer, got 0",
    ],
    [
      "a maxAttempts spelled as another word",
      { retry: { maxAttempts: "forever" } },
      `retry.maxAttempts: must be 'unlimited' or a positive safe integer, got "forever"`,
    ],
    [
      "a fractional maxLfsRetries",
      { retry: { maxLfsRetries: 0.5 } },
      "retry.maxLfsRetries: must be a non-negative safe integer, got 0.5",
    ],
    [
      "a negative initialDelayMs",
      { retry: { initialDelayMs: -1 } },
      "retry.initialDelayMs: must be a finite non-negative number, got -1",
    ],
    [
      "an infinite maxDelayMs",
      { retry: { maxDelayMs: Infinity } },
      "retry.maxDelayMs: must be a finite non-negative number, got Infinity",
    ],
    [
      "a backoffMultiplier below 1",
      { retry: { backoffMultiplier: 0.9 } },
      "retry.backoffMultiplier: must be a finite number of at least 1, got 0.9",
    ],
    [
      "a NaN jitterMs",
      { retry: { jitterMs: Number.NaN } },
      "retry.jitterMs: must be a finite non-negative number, got NaN",
    ],
    [
      "an initialDelayMs above maxDelayMs",
      { retry: { initialDelayMs: 5000, maxDelayMs: 4000 } },
      "retry.initialDelayMs: must not exceed maxDelayMs (4000), got 5000",
    ],
    [
      "an initialDelayMs above the default maxDelayMs",
      { retry: { initialDelayMs: 60000 } },
      "retry.initialDelayMs: must not exceed maxDelayMs (30000, the default), got 60000",
    ],
    [
      "a maxDelayMs below the default initialDelayMs",
      { retry: { maxDelayMs: 500 } },
      "retry.maxDelayMs: must be at least initialDelayMs (1000, the default), got 500",
    ],
    ["a parallelism that is not an object", { parallelism: 4 }, "parallelism: must be an object, got 4"],
    [
      "a zero parallelism limit",
      { parallelism: { maxRepositories: 0 } },
      "parallelism.maxRepositories: must be a positive integer, got 0",
    ],
    [
      "an unbounded parallelism limit",
      { parallelism: { maxStatusChecks: Infinity } },
      "parallelism.maxStatusChecks: must be a positive integer, got Infinity",
    ],
  ])("rejects %s", (_label, extra, expected) => {
    expect(onlyIssue(config(extra))).toBe(expected);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a hooks block that is not an object", { hooks: "echo" }, `repositories[0].hooks: must be an object, got "echo"`],
    [
      "an onBranchCreated that is not a list",
      { hooks: { onBranchCreated: "echo" } },
      `repositories[0].hooks.onBranchCreated: must be an array, got "echo"`,
    ],
    [
      "a blank hook command",
      { hooks: { onBranchCreated: ["echo", ""] } },
      `repositories[0].hooks.onBranchCreated[1]: must be a non-empty string, got ""`,
    ],
    [
      "a hook timeout past setTimeout's ceiling",
      { hooks: { timeoutMs: 2 ** 31 } },
      "repositories[0].hooks.timeoutMs: must be a whole number of milliseconds from 0 to 2147483647 " +
        "(0 disables the timeout), got 2147483648",
    ],
    [
      "a filesToCopyOnBranchCreate that is not a list",
      { filesToCopyOnBranchCreate: ".env" },
      `repositories[0].filesToCopyOnBranchCreate: must be an array, got ".env"`,
    ],
    [
      "a blank file to copy",
      { filesToCopyOnBranchCreate: [" "] },
      `repositories[0].filesToCopyOnBranchCreate[0]: must be a non-empty string, got " "`,
    ],
    ["a sparseCheckout with no include", { sparseCheckout: {} }, "repositories[0].sparseCheckout.include: is required"],
    [
      "an empty sparseCheckout include",
      { sparseCheckout: { include: [] } },
      "repositories[0].sparseCheckout.include: must contain at least one pattern",
    ],
    [
      "a blank sparseCheckout exclude",
      { sparseCheckout: { include: ["/*"], exclude: [""], mode: "no-cone" } },
      `repositories[0].sparseCheckout.exclude[0]: must be a non-empty string, got ""`,
    ],
    [
      "an unknown sparseCheckout mode",
      { sparseCheckout: { include: ["src"], mode: "tree" } },
      `repositories[0].sparseCheckout.mode: must be 'cone' or 'no-cone', got "tree"`,
    ],
    [
      "a non-boolean skipUpdateWhenOutsideSparse",
      { sparseCheckout: { include: ["src"], skipUpdateWhenOutsideSparse: "false" } },
      `repositories[0].sparseCheckout.skipUpdateWhenOutsideSparse: must be a boolean, got "false"`,
    ],
    [
      "a maintenance that is not an object",
      { maintenance: true },
      "repositories[0].maintenance: must be an object, got true",
    ],
    [
      "a non-boolean maintenance.enabled",
      { maintenance: { enabled: 1 } },
      "repositories[0].maintenance.enabled: must be a boolean, got 1",
    ],
    [
      "a zero maintenance.interval",
      { maintenance: { interval: "0d" } },
      `repositories[0].maintenance.interval: must be a positive duration string like '7d', '24h', or '2w', got "0d"`,
    ],
    [
      "a non-boolean maintenance.aggressive",
      { maintenance: { aggressive: "yes" } },
      `repositories[0].maintenance.aggressive: must be a boolean, got "yes"`,
    ],
    ["a trash that is not an object", { trash: [] }, "repositories[0].trash: must be an object, got an array"],
    [
      "a non-boolean trash.enabled",
      { trash: { enabled: "no" } },
      `repositories[0].trash.enabled: must be a boolean, got "no"`,
    ],
    [
      "a non-boolean trash.migrateLegacy",
      { trash: { migrateLegacy: 0 } },
      "repositories[0].trash.migrateLegacy: must be a boolean, got 0",
    ],
    [
      "a zero trash.retentionDays",
      { trash: { retentionDays: 0 } },
      "repositories[0].trash.retentionDays: must be a positive number, got 0",
    ],
    [
      "a negative trash.warnSizeBytes",
      { trash: { warnSizeBytes: -1 } },
      "repositories[0].trash.warnSizeBytes: must be a positive number, got -1",
    ],
  ])("rejects %s on a repository entry", (_label, repoExtra, expected) => {
    expect(onlyIssue(config({}, repoExtra))).toBe(expected);
  });

  it("names the entry and the rule for each cone-mode include git would refuse", () => {
    const issues = issuesOf(config({}, { sparseCheckout: { include: ["/apps", "libs/*"] } }));

    expect(issues.map((issue) => issue.field)).toEqual([
      "repositories[0].sparseCheckout.include",
      "repositories[0].sparseCheckout.include",
    ]);
    expect(issues[0].reason).toMatch(/^cone-mode 'include' entry '\/apps' starts with '\/'/);
    expect(issues[1].reason).toMatch(/^cone-mode 'include' entry 'libs\/\*' contains one of/);
  });

  it("does not support '!' in a file to copy, and says how to name such a file", () => {
    const [issue] = issuesOf(config({}, { filesToCopyOnBranchCreate: ["!.env"] }));

    expect(issue.field).toBe("repositories[0].filesToCopyOnBranchCreate[0]");
    expect(issue.reason).toContain(`does not support '!' negation, got "!.env"`);
    expect(issue.reason).toContain("('\\\\!.env' in a JavaScript config file)");
  });
});

describe("validateConfigFile: defaults", () => {
  it.each<[string, unknown, string]>([
    ["a defaults that is not an object", "hourly", `defaults: must be an object, got "hourly"`],
    ["a defaults of false", false, "defaults: must be an object, got false"],
    ["a non-boolean runOnce", { runOnce: "yes" }, `defaults.runOnce: must be a boolean, got "yes"`],
    ["a non-boolean syncOnStart", { syncOnStart: 0 }, "defaults.syncOnStart: must be a boolean, got 0"],
    [
      "an invalid cron expression",
      { cronSchedule: "* *" },
      "defaults.cronSchedule: '* *' is not a valid cron expression",
    ],
    ["an unknown mode", { mode: "bare" }, `defaults.mode: must be 'clone' or 'worktree', got "bare"`],
    ["a non-string worktreeDir", { worktreeDir: 3 }, "defaults.worktreeDir: must be a string, got 3"],
    [
      "a nested block error",
      { retry: { jitterMs: -5 } },
      "defaults.retry.jitterMs: must be a finite non-negative number, got -5",
    ],
  ])("rejects %s", (_label, defaults, expected) => {
    expect(onlyIssue(config({ defaults }))).toBe(expected);
  });

  it("keeps loading `defaults: null` as no defaults", () => {
    expect(issuesOf(config({ defaults: null }))).toEqual([]);
  });
});

describe("validateConfigFile: rules across fields", () => {
  it.each(["branchInclude", "branchExclude", "branchMaxAge", "updateExistingWorktrees", "bareRepoDir", "trash"])(
    "rejects %s on a clone-mode entry, set there or inherited from defaults",
    (field) => {
      const values: Record<string, unknown> = {
        branchInclude: ["main"],
        branchExclude: ["wip"],
        branchMaxAge: "7d",
        updateExistingWorktrees: false,
        bareRepoDir: "/tmp/bare",
        trash: { enabled: true },
      };

      expect(onlyIssue(config({}, { mode: "clone", [field]: values[field] }))).toBe(
        `repositories[0].${field}: not supported when mode is 'clone'`,
      );
      expect(onlyIssue(config({ defaults: { [field]: values[field] } }, { mode: "clone" }))).toBe(
        `repositories[0].${field}: not supported when mode is 'clone' (inherited from defaults.${field})`,
      );
    },
  );

  it.each([
    ["depth", 1],
    ["branch", "main"],
  ])("rejects %s outside clone mode, set there or inherited from defaults", (field, value) => {
    expect(onlyIssue(config({}, { [field]: value }))).toBe(
      `repositories[0].${field}: only supported when mode is 'clone'`,
    );
    expect(onlyIssue(config({ defaults: { [field]: value } }))).toBe(
      `repositories[0].${field}: only supported when mode is 'clone' (inherited from defaults.${field})`,
    );
  });

  it("takes the mode from defaults when the entry does not set one", () => {
    expect(issuesOf(config({ defaults: { mode: "clone", depth: 1, branch: "main" } }))).toEqual([]);
    expect(onlyIssue(config({ defaults: { mode: "clone" } }, { branchInclude: ["x"] }))).toBe(
      "repositories[0].branchInclude: not supported when mode is 'clone'",
    );
  });

  it("weighs the top-level and defaults parallelism blocks each on its own", () => {
    expect(onlyIssue(config({ parallelism: { maxRepositories: 6, maxStatusChecks: 20 } }))).toMatch(
      /^parallelism: peak concurrent git processes \(120\) exceeds safe limit \(100\)\. /,
    );
    expect(onlyIssue(config({ defaults: { parallelism: { maxRepositories: 6 } } }))).toMatch(
      /^defaults\.parallelism: peak concurrent git processes \(120\) exceeds safe limit \(100\)\. /,
    );
  });

  it("weighs repository overrides merged over the levels above them", () => {
    const repositories = [
      repo({ name: "wide", parallelism: { maxStatusChecks: 70 } }),
      repo({ name: "narrow", worktreeDir: "/tmp/narrow" }),
    ];

    expect(onlyIssue({ repositories, parallelism: { maxStatusChecks: 40 } })).toMatch(
      /^parallelism: peak concurrent git processes \(110\) exceeds safe limit \(100\) once global, defaults and per-repository parallelism are merged\./,
    );
  });
});

describe("validateConfigFile: reporting", () => {
  it("reports every field problem at once, each with its path and repository", () => {
    let caught: unknown;
    try {
      validateConfigFile({
        defaults: { debug: "no" },
        repositories: [repo({ cronSchedule: "nope" }), repo({ name: "api", worktreeDir: "/tmp/api", skipLfs: 1 })],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigValidationError);
    const error = caught as ConfigValidationError;
    expect(error.issues).toEqual([
      { field: "repositories[0].cronSchedule", reason: "'nope' is not a valid cron expression", repository: "web" },
      { field: "repositories[1].skipLfs", reason: "must be a boolean, got 1", repository: "api" },
      { field: "defaults.debug", reason: `must be a boolean, got "no"` },
    ]);
    expect(error.field).toBe("repositories[0].cronSchedule");
    expect(error.reason).toBe("'nope' is not a valid cron expression");
    expect(error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(error.message).toBe(
      [
        "Invalid configuration for 'repositories[0].cronSchedule' (repository 'web'): 'nope' is not a valid cron expression",
        "Invalid configuration for 'repositories[1].skipLfs' (repository 'api'): must be a boolean, got 1",
        `Invalid configuration for 'defaults.debug': must be a boolean, got "no"`,
      ].join("\n"),
    );
  });

  it("counts rather than lists the problems past the tenth", () => {
    const repositories = Array.from({ length: 12 }, (_, index) =>
      repo({ name: `r${index}`, worktreeDir: `/tmp/r${index}`, debug: "yes" }),
    );
    let caught: unknown;
    try {
      validateConfigFile({ repositories });
    } catch (error) {
      caught = error;
    }

    const error = caught as ConfigValidationError;
    expect(error.issues).toHaveLength(12);
    const lines = error.message.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("... and 2 more problems");
  });

  it("checks the rules across fields only once every field is valid", () => {
    // The mode conflict is real, but reporting it next to a type error in the
    // same file would reason about a config that is not the one written.
    const issues = issuesOf(config({}, { mode: "clone", branchInclude: ["main"], debug: "yes" }));

    expect(issues.map((issue) => issue.field)).toEqual(["repositories[0].debug"]);
  });

  it("leaves the config as written: unknown keys stay, nothing is filled in", () => {
    const value = config({ extra: 1 }, { updateExistingWorktree: true, retry: { maxAttemptz: 2 } });
    const before = structuredClone(value);

    validateConfigFile(value);

    expect(value).toEqual(before);
  });

  it("treats a known key set to undefined as absent", () => {
    expect(
      issuesOf(config({ retry: undefined }, { debug: undefined, runOnce: undefined, sparseCheckout: undefined })),
    ).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "unlimited attempts and fractional delays",
      { retry: { maxAttempts: "unlimited", initialDelayMs: 1.5, backoffMultiplier: 1.5 } },
    ],
    ["both timeout bounds and zero", { defaults: { fetchTimeoutMs: 0, cloneTimeoutMs: 2_147_483_647 } }],
    ["an extglob file to copy", { defaults: { filesToCopyOnBranchCreate: ["!(dist)/.env"] } }],
    [
      "a no-cone sparse checkout with gitignore patterns",
      { defaults: { sparseCheckout: { include: ["/*"], exclude: ["docs"], mode: "no-cone" } } },
    ],
    ["a hook timeout of zero", { defaults: { hooks: { onBranchCreated: ["npm ci"], timeoutMs: 0 } } }],
    ["empty branch lists", { defaults: { branchInclude: [], branchExclude: [] } }],
    ["the shipped parallelism defaults spelled out", { parallelism: { maxRepositories: 2, maxStatusChecks: 20 } }],
  ])("accepts %s", (_label, extra) => {
    expect(issuesOf(config(extra))).toEqual([]);
  });
});

describe("KNOWN_CONFIG_KEYS", () => {
  it("is read off the schema, level by level", () => {
    expect([...KNOWN_CONFIG_KEYS.topLevel].sort()).toEqual(["defaults", "parallelism", "repositories", "retry"]);
    expect(KNOWN_CONFIG_KEYS.repository).toContain("name");
    expect(KNOWN_CONFIG_KEYS.defaults).not.toContain("name");
    expect(KNOWN_CONFIG_KEYS.nested.retry).toContain("maxAttempts");
  });

  it("gives the top-level blocks the same keys as the nested blocks of the same name", () => {
    const topLevel = configFileSchema.shape;
    for (const block of ["retry", "parallelism"] as const) {
      const keys = Object.keys(topLevel[block].unwrap().shape).sort();
      expect(keys).toEqual([...KNOWN_CONFIG_KEYS.nested[block]].sort());
    }
  });
});
