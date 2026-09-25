import * as cron from "node-cron";
import { z } from "zod";

import { DEFAULT_CONFIG } from "../constants";
import { ConfigValidationError } from "../errors";
import { parseDuration } from "../utils/date-filter";
import { MAX_TIMER_DELAY_MS, MIN_GIT_TIMEOUT_MS, SIMPLE_GIT_CLIENT_CONCURRENCY } from "../utils/git-client";
import { isValidGitUrl, redactSecretsInText } from "../utils/git-url";
import { REPOSITORY_MODES } from "../utils/repo-mode";
import { findConeRuleViolations } from "./sparse-checkout.service";

import type { ConfigValidationIssue } from "../errors";
import type { ConfigFile, ParallelismConfig, RepositoryConfig } from "../types";
import type { KnownConfigKeys } from "../utils/unknown-config-keys";

/**
 * How wide a phase can actually run, in git processes.
 *
 * `asConfigured` is a phase whose units each get their own git client, so it
 * runs at exactly the configured width. `cappedByOneClient` is a phase whose
 * git-command *unit* goes through a single cached simple-git client, whose
 * scheduler caps it at SIMPLE_GIT_CLIENT_CONCURRENCY however high the setting
 * is — measured: 40 concurrent branch fetches through the anchor worktree's
 * client peak at 5 fetches (9 processes counting git's transport helpers), not
 * 40. Creation and removal are capped this way for their `worktree add` and
 * `worktree remove` calls, but each unit also runs a few commands on the new
 * worktree's own client, outside that cap: `maxWorktreeCreation: 40` measured
 * at a peak of 15 processes rather than 5, so the cap bounds the phase's growth
 * rather than pinning it exactly.
 */
const asConfigured = (configured: number): number => configured;
const cappedByOneClient = (configured: number): number => Math.min(configured, SIMPLE_GIT_CLIENT_CONCURRENCY);
/**
 * The branch-by-branch fetch is a fallback that only runs when a bulk fetch
 * failed on LFS errors, and it goes through the anchor worktree's one client,
 * so it can never exceed SIMPLE_GIT_CLIENT_CONCURRENCY however high
 * `maxBranchFetches` is set. It is left out of the peak entirely rather than
 * counted at that ceiling, because counting it -- even at 5 -- would newly
 * reject configs that load today: 21 to 25 repositories with every other limit
 * at 1 sum to 84-100 under the old rule but reach 105-125 at 5 per repository.
 * Leaving it out is what makes "no config that loads today is rejected" hold
 * for every input rather than merely for the ones we swept.
 *
 * This is a deliberate hole, not an impossibility: `maxRepositories` repos can
 * each run 5 concurrent fallback fetches, so a config the peak reports as 42
 * can spawn ~105 fetch processes if every repository hits the LFS fallback at
 * once. The fallback has one call site and is gated on an LFS failure, so that
 * is a narrow path. The setting is still validated as a positive integer.
 */
const notCounted = (): number => 0;

/**
 * Every per-repository parallelism phase: the phase it bounds, and the git
 * processes that phase can really run at once. The phases run one after another
 * — create, then prune, then update — so a repository's peak is the widest
 * single phase, never the sum of all of them. (The update phase runs its
 * read-only probes under its own `maxStatusChecks`-wide limiter and its
 * fast-forwards under `maxWorktreeUpdates`, one after the other, so both are
 * already covered by taking the maximum.)
 *
 * Counts are git processes this tool spawns. Git's own children are outside the
 * model: `git submodule status` runs a `git-submodule`/`git-sh-i18n` helper and
 * a child per submodule, measured on git 2.43 at ~1.5 git processes and ~3
 * processes in total per call on an 8-submodule superproject (7 for a single
 * probe with nothing else running), so a budget spent entirely on superproject
 * probes costs roughly three times its size in processes.
 */
const PARALLELISM_PHASES = [
  {
    field: "maxWorktreeCreation",
    label: "worktree creation",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION,
    // `git worktree add` on the bare repository's one client.
    concurrentProcesses: cappedByOneClient,
  },
  {
    field: "maxWorktreeUpdates",
    label: "worktree updates",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES,
    // Each fast-forward runs on its own worktree's client, one command at a time.
    concurrentProcesses: asConfigured,
  },
  {
    field: "maxWorktreeRemoval",
    label: "worktree removal",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_REMOVAL,
    // `git worktree remove` on the bare repository's one client.
    concurrentProcesses: cappedByOneClient,
  },
  {
    field: "maxStatusChecks",
    label: "status checks",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS,
    // Enforced exactly by WorktreeStatusService's shared process budget.
    concurrentProcesses: asConfigured,
  },
  {
    field: "maxBranchFetches",
    label: "branch fetches",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_BRANCH_FETCHES,
    concurrentProcesses: notCounted,
  },
] as const satisfies ReadonlyArray<{
  field: keyof ParallelismConfig;
  label: string;
  default: number;
  concurrentProcesses: (configured: number) => number;
}>;

export interface ParallelismPeak {
  /** Git processes the widest phase of a single repository runs at once. */
  perRepository: number;
  /** `maxRepositories` × `perRepository`: the whole run's peak. */
  total: number;
  /** The setting that decides `perRepository`, and how it reads in a message. */
  widestPhase: { field: keyof ParallelismConfig; label: string; value: number };
}

/**
 * Peak concurrent git processes a parallelism config allows. The shipped
 * defaults come to 2 repositories × 20 status checks = 40.
 */
export function computeParallelismPeak(parallelism: ParallelismConfig = {}): ParallelismPeak {
  const phases = PARALLELISM_PHASES.map((phase) => ({
    field: phase.field,
    label: phase.label,
    value: phase.concurrentProcesses(parallelism[phase.field] ?? phase.default),
  }));
  const widestPhase = phases.reduce((widest, phase) => (phase.value > widest.value ? phase : widest));
  const maxRepositories = parallelism.maxRepositories ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;

  return {
    perRepository: widestPhase.value,
    total: maxRepositories * widestPhase.value,
    widestPhase,
  };
}

/**
 * Fields a clone-mode repository rejects, on the entry or inherited from
 * `defaults`. Exported so the shipped example config's clone-mode section can
 * be checked against it: that comment enumerates these names, and it silently
 * fell behind when `trash` was added here.
 */
export const CLONE_MODE_CONFLICTING_FIELDS = [
  "branchInclude",
  "branchExclude",
  "branchMaxAge",
  "updateExistingWorktrees",
  "bareRepoDir",
  "trash",
] as const satisfies readonly (keyof RepositoryConfig)[];

/** Fields only a clone-mode repository accepts, on the entry or inherited from `defaults`. */
const CLONE_MODE_ONLY_FIELDS = ["depth", "branch"] as const satisfies readonly (keyof RepositoryConfig)[];

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MAX_SHOWN_STRING_LENGTH = 60;

/**
 * What a rejected value was, for the end of a message. Strings are redacted
 * before they are shortened — shortening first could cut a URL's userinfo
 * away from the `@` the redaction keys on — and objects are named by kind
 * only, since their contents could be anything.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "string": {
      const redacted = redactSecretsInText(value);
      const shown =
        redacted.length > MAX_SHOWN_STRING_LENGTH ? `${redacted.slice(0, MAX_SHOWN_STRING_LENGTH - 3)}...` : redacted;
      return JSON.stringify(shown);
    }
    case "function":
      return "a function";
    case "symbol":
      return "a symbol";
    default:
      return "an object";
  }
}

/**
 * The error map every rule uses: the rule's reason plus what was found, or
 * "is required" for a required key that is absent. One reason per rule covers
 * both a wrong type and a right type with a wrong value, so each setting has
 * one sentence and not a list of cases.
 */
const because =
  (reason: string) =>
  (issue: { input?: unknown }): string =>
    issue.input === undefined ? "is required" : `${reason}, got ${describeValue(issue.input)}`;

const NON_EMPTY_STRING = "must be a non-empty string";

const text = (reason = "must be a string") => z.string({ error: because(reason) });

const nonEmptyText = (reason = NON_EMPTY_STRING) =>
  text(reason).refine((value) => value.trim() !== "", { error: because(reason) });

const flag = () => z.boolean({ error: because("must be a boolean") });

/**
 * A number that `accept` admits. `z.number()` itself already refuses `NaN` and
 * `±Infinity`, which is what keeps the `<`-shaped bounds below honest: `NaN`
 * fails every comparison, so a bound alone would wave it through.
 */
const numberWhere = (reason: string, accept: (value: number) => boolean) =>
  z.number({ error: because(reason) }).refine(accept, { error: because(reason) });

const listOf = <T extends z.ZodType>(item: T, reason = "must be an array") => z.array(item, { error: because(reason) });

const block = <T extends z.core.$ZodLooseShape>(shape: T) => z.object(shape, { error: because("must be an object") });

/** Cross-field rules run only on a block whose own fields all passed, so they never reason about a bad value. */
const whenClean = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

// ---------------------------------------------------------------------------
// Leaf rules
// ---------------------------------------------------------------------------

const cronSchedule = text("must be a cron expression string").refine((value) => cron.validate(value), {
  error: (issue) => `'${String(issue.input)}' is not a valid cron expression`,
});

const DURATION = "must be a duration string like '14d', '12h', or '2w'";
const duration = text(DURATION).refine((value) => parseDuration(value) !== null, { error: because(DURATION) });

// Zero parses fine but would disable throttling entirely (gc every tick).
const POSITIVE_DURATION = "must be a positive duration string like '7d', '24h', or '2w'";
const positiveDuration = text(POSITIVE_DURATION).refine((value) => (parseDuration(value) ?? 0) > 0, {
  error: because(POSITIVE_DURATION),
});

/**
 * `branchInclude` / `branchExclude`, at either level.
 *
 * An empty or whitespace-only pattern matches nothing (git refuses a branch
 * name containing a space) while `filterBranchesByName` applies an include
 * list on `length > 0` alone, so `branchInclude: [""]` keeps no branch and
 * the prune phase then sees every worktree but the default branch's as
 * unmanaged. It arrives as `(process.env.BRANCHES ?? "").split(",")` with
 * the variable unset, which yields `[""]` rather than `[]`.
 */
const BLANK_BRANCH_PATTERN =
  "must not be empty or whitespace-only: such a pattern matches no branch, and a branchInclude matching nothing " +
  "prunes every worktree. Omit the field to sync every branch";
const branchPatterns = listOf(
  text().refine((pattern) => pattern.trim() !== "", { error: BLANK_BRANCH_PATTERN }),
  "must be an array of strings",
);

const positiveSafeInteger = (reason = "must be a positive safe integer") =>
  numberWhere(reason, (value) => Number.isSafeInteger(value) && value >= 1);

/**
 * `fetchTimeoutMs` / `cloneTimeoutMs`, at either level. Zero is admitted
 * deliberately and means "no inactivity kill at all": both services gate the
 * simple-git option on `blockMs > 0`, so a zero never reaches git as a
 * timeout. Anything above setTimeout's 2^31-1 ceiling is rejected rather than
 * passed on, where Node replaces it with 1 ms. The floor of one second catches
 * a window given in seconds (`fetchTimeoutMs: 300`), which would kill nearly
 * every fetch.
 */
const gitTimeoutMs = numberWhere(
  `must be 0 (disables the timeout) or a whole number of milliseconds from ${MIN_GIT_TIMEOUT_MS} to ${MAX_TIMER_DELAY_MS}`,
  (value) => Number.isInteger(value) && (value === 0 || (value >= MIN_GIT_TIMEOUT_MS && value <= MAX_TIMER_DELAY_MS)),
);

const repositoryMode = z.enum([REPOSITORY_MODES.CLONE, REPOSITORY_MODES.WORKTREE], {
  error: because("must be 'clone' or 'worktree'"),
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * A `retry` block, at any level.
 *
 * Measured against `retry()`: a NaN or Infinity `maxAttempts` throws before the
 * first attempt (Infinity is not a spelling of unlimited — the string is); a
 * NaN delay or multiplier, or an Infinity `jitterMs`, makes the computed delay
 * non-finite and `setTimeout` floors it to 1ms, hundreds of attempts a second;
 * `maxDelayMs: Infinity` removes the cap, so the doubling runs away into days
 * between attempts; a non-finite `maxLfsRetries` never trips the LFS limit.
 * Fractions stay legal for the delays and the multiplier, which are
 * continuous: only the two counts must be whole.
 */
const MAX_ATTEMPTS = "must be 'unlimited' or a positive safe integer";
const NON_NEGATIVE_DELAY = "must be a finite non-negative number";
const retrySchema = block({
  maxAttempts: z
    .union([z.literal("unlimited"), positiveSafeInteger(MAX_ATTEMPTS)], { error: because(MAX_ATTEMPTS) })
    .optional(),
  maxLfsRetries: numberWhere(
    "must be a non-negative safe integer",
    (v) => Number.isSafeInteger(v) && v >= 0,
  ).optional(),
  initialDelayMs: numberWhere(NON_NEGATIVE_DELAY, (v) => v >= 0).optional(),
  maxDelayMs: numberWhere(NON_NEGATIVE_DELAY, (v) => v >= 0).optional(),
  backoffMultiplier: numberWhere("must be a finite number of at least 1", (v) => v >= 1).optional(),
  jitterMs: numberWhere(NON_NEGATIVE_DELAY, (v) => v >= 0).optional(),
}).superRefine((retry, ctx) => {
  const initialDelay = retry.initialDelayMs ?? DEFAULT_CONFIG.RETRY.INITIAL_DELAY_MS;
  const maxDelay = retry.maxDelayMs ?? DEFAULT_CONFIG.RETRY.MAX_DELAY_MS;
  if (initialDelay <= maxDelay) return;
  // Reported on whichever of the two the block actually set.
  if (retry.initialDelayMs === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["maxDelayMs"],
      message: `must be at least initialDelayMs (${initialDelay}, the default), got ${maxDelay}`,
    });
    return;
  }
  const defaulted = retry.maxDelayMs === undefined ? ", the default" : "";
  ctx.addIssue({
    code: "custom",
    path: ["initialDelayMs"],
    message: `must not exceed maxDelayMs (${maxDelay}${defaulted}), got ${initialDelay}`,
  });
}, whenClean);

/**
 * One `parallelism` block's fields. Every one of these numbers reaches
 * `pLimit()` at the start of a sync phase, and p-limit throws mid-sync for 0,
 * a negative, a fraction, a NaN or a string — after the fetch, on every run,
 * and not retryable. `Infinity`, which p-limit allows as "unbounded", is kept
 * out on purpose: an unbounded phase has no peak to weigh against
 * MAX_SAFE_TOTAL_CONCURRENT_OPS, and bounding git processes is the point.
 */
const parallelismLimit = positiveSafeInteger("must be a positive integer").optional();
const parallelismSchema = block({
  maxRepositories: parallelismLimit,
  maxWorktreeCreation: parallelismLimit,
  maxWorktreeUpdates: parallelismLimit,
  maxWorktreeRemoval: parallelismLimit,
  maxStatusChecks: parallelismLimit,
  maxBranchFetches: parallelismLimit,
});

/**
 * The top-level and `defaults` blocks, each checked on its own against the
 * built-in defaults for whatever it leaves out. A repository's block is only
 * half a configuration (it still inherits `maxRepositories` from above), so it
 * is weighed merged instead, in checkMergedParallelismPeak.
 */
const levelParallelismSchema = parallelismSchema.superRefine((parallelism, ctx) => {
  const maxRepos = parallelism.maxRepositories ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;
  const peak = computeParallelismPeak(parallelism);
  const limit = DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS;
  if (peak.total <= limit) return;

  const { field, label, value } = peak.widestPhase;
  // Both ways out, each solving for the other side: how many repositories fit
  // at this phase width, and how wide the phase may be at this repository
  // count. Either can come out below 1, and that half of the advice is dropped.
  const safeMaxRepos = Math.floor(limit / peak.perRepository);
  const safePhaseValue = Math.floor(limit / maxRepos);
  const headroom =
    safeMaxRepos >= 1
      ? `With ${field} at ${value}, maximum safe maxRepositories is ${safeMaxRepos}.`
      : `Even one repository exceeds the limit at ${field}: ${value}.`;
  const phaseAdvice =
    safePhaseValue >= 1 ? ` With maxRepositories at ${maxRepos}, ${field} must be ${safePhaseValue} or less.` : "";
  ctx.addIssue({
    code: "custom",
    message:
      `peak concurrent git processes (${peak.total}) exceeds safe limit (${limit}). ` +
      `Sync phases run one after another, so the peak is ${maxRepos} ` +
      `${maxRepos === 1 ? "repository" : "repositories"} × the widest phase ` +
      `(${label}, ${field}: ${value}) = ${peak.total} git processes. ` +
      `${headroom}${phaseAdvice} Consider reducing maxRepositories or lowering ${field}.`,
  });
}, whenClean);

const nonEmptyStrings = listOf(nonEmptyText());

/**
 * The copy expands with negation turned off, so a leading `!` is a filename
 * character here -- while the neighbouring `sparseCheckout` option does give it
 * the gitignore meaning. Carrying that idiom across otherwise buys silence: the
 * pass reports zero matches without saying why. An extglob (`!(dist)/x`) is
 * left alone: glob reads it as one.
 */
const fileToCopy = nonEmptyText().refine((pattern) => !pattern.startsWith("!") || pattern.startsWith("!("), {
  error: (issue) => {
    const pattern = String(issue.input);
    return (
      `does not support '!' negation, got ${describeValue(pattern)}. Every entry names files to copy; there is ` +
      `nothing to subtract from. Unlike 'sparseCheckout.exclude', a leading '!' here is part of the filename -- ` +
      `to name a file whose name starts with it, escape the '!' ('\\\\!${pattern.slice(1)}' in a JavaScript config file)`
    );
  },
});

/**
 * The upper bound is setTimeout's, not an arbitrary one: a delay above 2^31-1
 * does not fit the 32-bit field, so Node warns and substitutes 1, and a
 * year-long timeout would SIGTERM the hook milliseconds after it started.
 * Anyone who meant "no timeout" has 0 for it.
 */
const hooksSchema = block({
  onBranchCreated: nonEmptyStrings.optional(),
  timeoutMs: numberWhere(
    `must be a whole number of milliseconds from 0 to ${MAX_TIMER_DELAY_MS} (0 disables the timeout)`,
    (value) => Number.isInteger(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS,
  ).optional(),
});

const sparseCheckoutSchema = block({
  include: nonEmptyStrings.min(1, { error: "must contain at least one pattern" }),
  exclude: nonEmptyStrings.optional(),
  mode: z.enum(["cone", "no-cone"], { error: because("must be 'cone' or 'no-cone'") }).optional(),
  // The update phase reads this as `!== false`, which is true for every
  // non-boolean: the string "false" would enable the skipping it was written
  // to disable.
  skipUpdateWhenOutsideSparse: flag().optional(),
}).superRefine((sparse, ctx) => {
  // Cone mode is the default, and it refuses the gitignore syntax the field
  // invites: `git sparse-checkout set --cone` dies on a leading slash or a glob
  // character. Unvalidated, every worktree was added and rolled back with an
  // error naming neither the entry nor the rule, on every tick forever.
  for (const violation of findConeRuleViolations(sparse)) {
    ctx.addIssue({ code: "custom", path: ["include"], message: violation });
  }
}, whenClean);

const maintenanceSchema = block({
  enabled: flag().optional(),
  interval: positiveDuration.optional(),
  aggressive: flag().optional(),
});

const POSITIVE_NUMBER = "must be a positive number";
const trashSchema = block({
  enabled: flag().optional(),
  retentionDays: numberWhere(POSITIVE_NUMBER, (value) => value > 0).optional(),
  warnSizeBytes: numberWhere(POSITIVE_NUMBER, (value) => value > 0).optional(),
  migrateLegacy: flag().optional(),
});

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** Settings a repository entry and `defaults` share; a repository's own value wins. */
const sharedFields = {
  cronSchedule: cronSchedule.optional(),
  bareRepoDir: text().optional(),
  retry: retrySchema.optional(),
  branchMaxAge: duration.optional(),
  branchInclude: branchPatterns.optional(),
  branchExclude: branchPatterns.optional(),
  skipLfs: flag().optional(),
  updateExistingWorktrees: flag().optional(),
  debug: flag().optional(),
  filesToCopyOnBranchCreate: listOf(fileToCopy).optional(),
  hooks: hooksSchema.optional(),
  sparseCheckout: sparseCheckoutSchema.optional(),
  maintenance: maintenanceSchema.optional(),
  trash: trashSchema.optional(),
  mode: repositoryMode.optional(),
  branch: nonEmptyText().optional(),
  depth: positiveSafeInteger().optional(),
  fetchTimeoutMs: gitTimeoutMs.optional(),
  cloneTimeoutMs: gitTimeoutMs.optional(),
};

/**
 * Set by the loader or read only in-process, never written in a config file.
 * Declared so that they are known keys — reporting `__configFileDir` as
 * *unknown* would be the wrong word for it — and deliberately unvalidated:
 * `resolveRepositoryConfig` computes the internal ones itself and reads none of
 * these from the file.
 */
const internalFields = {
  logger: z.unknown().optional(),
  __configFileDir: z.unknown().optional(),
  __configuredRepoDirs: z.unknown().optional(),
};

/** `runOnce` and `syncOnStart` describe the process, and one process runs every repository in the file. */
const wholeFileSetting = (key: "runOnce" | "syncOnStart") =>
  z.undefined({ error: `cannot be set on a repository; use defaults.${key}` }).optional();

const REPO_URL_FORMATS =
  "Expected an HTTP(S), SSH, Git protocol or file:// URL, an scp-style 'user@host:path/repo.git', or an absolute " +
  "filesystem path. All but HTTP(S) must name the repository's own path segment; an HTTP(S) URL may stop at the " +
  "host, but then the entry needs an explicit 'bareRepoDir'";

export const repositorySchema = block({
  name: nonEmptyText(),
  repoUrl: text().refine((url) => isValidGitUrl(url), {
    error: (issue) => `is not a repository URL, got ${describeValue(issue.input)}. ${REPO_URL_FORMATS}`,
  }),
  worktreeDir: nonEmptyText(),
  ...sharedFields,
  parallelism: parallelismSchema.optional(),
  runOnce: wholeFileSetting("runOnce"),
  syncOnStart: wholeFileSetting("syncOnStart"),
  ...internalFields,
});

export const defaultsSchema = block({
  // Known so they are not reported as unknown, but a repository's own entry is
  // the only place either is read.
  repoUrl: text().optional(),
  worktreeDir: text().optional(),
  ...sharedFields,
  parallelism: levelParallelismSchema.optional(),
  runOnce: flag().optional(),
  syncOnStart: flag().optional(),
  ...internalFields,
});

type ValidatedConfigFile = z.output<typeof configFileBaseSchema>;

const configFileBaseSchema = z.object(
  {
    repositories: listOf(repositorySchema, "must be an array of repository entries").min(1, {
      error: "must contain at least one repository",
    }),
    // `null` has always loaded as "no defaults", and is kept loading.
    defaults: defaultsSchema.nullable().optional(),
    retry: retrySchema.optional(),
    parallelism: levelParallelismSchema.optional(),
  },
  { error: because("must be an object with a 'repositories' array") },
);

// ---------------------------------------------------------------------------
// Rules across levels
// ---------------------------------------------------------------------------

function checkDuplicateNames(config: ValidatedConfigFile, ctx: z.RefinementCtx): void {
  const firstIndex = new Map<string, number>();
  config.repositories.forEach((repo, index) => {
    const first = firstIndex.get(repo.name);
    if (first === undefined) {
      firstIndex.set(repo.name, index);
      return;
    }
    ctx.addIssue({
      code: "custom",
      path: ["repositories", index, "name"],
      message: `duplicate repository name '${repo.name}' (already used by repositories[${first}])`,
    });
  });
}

/**
 * Each mode rejects the other's settings, whether written on the entry or
 * inherited from `defaults`: clone mode has no bare repository and no branch
 * set to filter, and only clone mode checks out one fixed `branch` at a `depth`.
 */
function checkModeSpecificFields(config: ValidatedConfigFile, ctx: z.RefinementCtx): void {
  const defaults = config.defaults ?? undefined;
  config.repositories.forEach((repo, index) => {
    const mode = repo.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;
    const [fields, reason] =
      mode === REPOSITORY_MODES.CLONE
        ? [CLONE_MODE_CONFLICTING_FIELDS, "not supported when mode is 'clone'"]
        : [CLONE_MODE_ONLY_FIELDS, "only supported when mode is 'clone'"];
    for (const field of fields) {
      const inherited = repo[field] === undefined && defaults?.[field] !== undefined;
      if (repo[field] === undefined && !inherited) continue;
      ctx.addIssue({
        code: "custom",
        path: ["repositories", index, field],
        message: inherited ? `${reason} (inherited from defaults.${field})` : reason,
      });
    }
  });
}

/**
 * The parallelism ceiling applied to what each repository will actually run,
 * once the top-level, `defaults` and per-repository blocks are merged the way
 * resolveRepositoryConfig merges them.
 *
 * Only `maxRepositories` repositories sync at once and each runs its own
 * widest phase, so the peak is the sum of the widest phases of the
 * `maxRepositories` widest repositories — not `maxRepositories` × the single
 * widest one, which would reject a wide entry that only ever syncs beside
 * narrow ones (3 repositories peaking at 40/20/20 run 60 processes across two
 * slots, not 120). With no per-repository overrides this collapses to the
 * per-level check, which has already passed by the time this runs.
 *
 * `maxRepositories` is read global-first, the way runMultipleRepositories
 * reads it. A repository-level `maxRepositories` is still validated as a
 * positive integer, but it bounds nothing: nothing consumes it there.
 */
function checkMergedParallelismPeak(config: ValidatedConfigFile, ctx: z.RefinementCtx): void {
  const global = config.parallelism ?? {};
  const defaults = config.defaults?.parallelism ?? {};
  const maxRepos = global.maxRepositories ?? defaults.maxRepositories ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;

  const peaks = config.repositories
    .map((repo) => ({
      name: repo.name,
      peak: computeParallelismPeak({ ...global, ...defaults, ...repo.parallelism }),
    }))
    .sort((a, b) => b.peak.perRepository - a.peak.perRepository);

  const concurrent = peaks.slice(0, maxRepos);
  const total = concurrent.reduce((sum, repo) => sum + repo.peak.perRepository, 0);
  const limit = DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS;
  if (total <= limit) return;

  // Enough of the sum to see where it comes from, without pasting fifty
  // repositories into one message.
  const listed = 3;
  const shown = concurrent
    .slice(0, listed)
    .map(
      ({ name, peak }) => `'${name}' (${peak.widestPhase.label}, ${peak.widestPhase.field}: ${peak.widestPhase.value})`,
    );
  const rest = concurrent.length - shown.length;
  const breakdown = rest > 0 ? `${shown.join(" + ")} + ${rest} more` : shown.join(" + ");
  const widestField = concurrent[0].peak.widestPhase.field;

  ctx.addIssue({
    code: "custom",
    path: ["parallelism"],
    message:
      `peak concurrent git processes (${total}) exceeds safe limit (${limit}) once global, defaults and ` +
      `per-repository parallelism are merged. Sync phases run one after another, so the peak is the widest ` +
      `phase of each of the ${concurrent.length} ${concurrent.length === 1 ? "repository" : "repositories"} ` +
      `that can sync at once (maxRepositories: ${maxRepos}): ${breakdown} = ${total} git processes. ` +
      `Consider reducing maxRepositories or lowering ${widestField}.`,
  });
}

/**
 * The whole config file. Unknown keys pass through untouched: they are
 * reported as warnings, with a suggestion, by the loader's unknown-key scan,
 * which reads its inventory off this schema (KNOWN_CONFIG_KEYS).
 */
export const configFileSchema = configFileBaseSchema.superRefine((config, ctx) => {
  checkDuplicateNames(config, ctx);
  checkModeSpecificFields(config, ctx);
  checkMergedParallelismPeak(config, ctx);
}, whenClean);

// ---------------------------------------------------------------------------
// Known keys, read off the schema
// ---------------------------------------------------------------------------

function objectShapeOf(schema: unknown): Record<string, unknown> | undefined {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap();
  }
  return current instanceof z.ZodObject ? current.shape : undefined;
}

function nestedKeysOf(shape: Record<string, unknown>): Record<string, readonly string[]> {
  const nested: Record<string, readonly string[]> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const inner = objectShapeOf(schema);
    if (inner) nested[key] = Object.keys(inner);
  }
  return nested;
}

/**
 * Every key the schema declares, level by level: the inventory the unknown-key
 * scan checks a file against. `defaults` is left out of the top level's nested
 * blocks because the scan walks it as a level of its own.
 */
export const KNOWN_CONFIG_KEYS: KnownConfigKeys = {
  topLevel: Object.keys(configFileBaseSchema.shape),
  defaults: Object.keys(defaultsSchema.shape),
  repository: Object.keys(repositorySchema.shape),
  nested: { ...nestedKeysOf(repositorySchema.shape), ...nestedKeysOf(defaultsSchema.shape) },
};

// ---------------------------------------------------------------------------
// Validation entry point
// ---------------------------------------------------------------------------

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "default export";
  return path.reduce<string>((out, segment) => {
    if (typeof segment === "number") return `${out}[${segment}]`;
    return out === "" ? String(segment) : `${out}.${String(segment)}`;
  }, "");
}

/** The `name` of the repository entry an issue sits in, when the entry has a usable one. */
function repositoryNameAt(config: unknown, path: readonly PropertyKey[]): string | undefined {
  if (path[0] !== "repositories" || typeof path[1] !== "number") return undefined;
  const repositories = (config as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) return undefined;
  const entry: unknown = repositories[path[1]];
  const name = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

/**
 * Validates an evaluated config file, reporting every problem at once as one
 * ConfigValidationError whose fields are paths into the file
 * (`repositories[1].cronSchedule`). The config itself is not rewritten: what
 * the file exported is what the loader goes on to resolve.
 */
export function validateConfigFile(config: unknown): asserts config is ConfigFile {
  const result = configFileSchema.safeParse(config);
  if (result.success) return;

  const issues = result.error.issues.map((issue): ConfigValidationIssue => {
    const repository = repositoryNameAt(config, issue.path);
    return {
      field: formatPath(issue.path),
      reason: issue.message,
      ...(repository === undefined ? {} : { repository }),
    };
  });
  throw new ConfigValidationError(issues as [ConfigValidationIssue, ...ConfigValidationIssue[]]);
}
