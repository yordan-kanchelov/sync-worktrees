import * as cron from "node-cron";
import { z } from "zod";

import { DEFAULT_CONFIG } from "../constants";
import { ConfigValidationError } from "../errors";
import { parseDuration } from "../utils/date-filter";
import { MAX_TIMER_DELAY_MS, MIN_GIT_TIMEOUT_MS, SIMPLE_GIT_CLIENT_CONCURRENCY } from "../utils/git-client";
import { isValidGitUrl, redactSecretsInText } from "../utils/git-url";
import { REPOSITORY_MODES } from "../utils/repo-mode";
import { sanitizeNameForPath } from "../utils/sanitize-name";
import { findConeRuleViolations } from "./sparse-checkout.service";

import type { ConfigValidationIssue } from "../errors";
import type { ConfigFile, ParallelismConfig, RepositoryConfig } from "../types";
import type { KnownConfigKeys } from "../utils/unknown-config-keys";

const asConfigured = (configured: number): number => configured;
const cappedByOneClient = (configured: number): number => Math.min(configured, SIMPLE_GIT_CLIENT_CONCURRENCY);
const PARALLELISM_PHASES = [
  {
    field: "maxWorktreeCreation",
    label: "worktree creation",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION,
    concurrentProcesses: cappedByOneClient,
  },
  {
    field: "maxWorktreeUpdates",
    label: "worktree updates",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES,
    concurrentProcesses: asConfigured,
  },
  {
    field: "maxWorktreeRemoval",
    label: "worktree removal",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_REMOVAL,
    concurrentProcesses: cappedByOneClient,
  },
  {
    field: "maxStatusChecks",
    label: "status checks",
    default: DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS,
    concurrentProcesses: asConfigured,
  },
] as const satisfies ReadonlyArray<{
  field: keyof ParallelismConfig;
  label: string;
  default: number;
  concurrentProcesses: (configured: number) => number;
}>;

export interface ParallelismPeak {
  perRepository: number;
  total: number;
  widestPhase: { field: keyof ParallelismConfig; label: string; value: number };
}

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

export const CLONE_MODE_CONFLICTING_FIELDS = [
  "branchInclude",
  "branchExclude",
  "branchMaxAge",
  "updateExistingWorktrees",
  "bareRepoDir",
  "trash",
] as const satisfies readonly (keyof RepositoryConfig)[];

const CLONE_MODE_ONLY_FIELDS = ["depth", "branch"] as const satisfies readonly (keyof RepositoryConfig)[];

const MAX_SHOWN_STRING_LENGTH = 60;

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

const because =
  (reason: string) =>
  (issue: { input?: unknown }): string =>
    issue.input === undefined ? "is required" : `${reason}, got ${describeValue(issue.input)}`;

const NON_EMPTY_STRING = "must be a non-empty string";

const text = (reason = "must be a string") => z.string({ error: because(reason) });

const nonEmptyText = (reason = NON_EMPTY_STRING) =>
  text(reason).refine((value) => value.trim() !== "", { error: because(reason) });

const flag = () => z.boolean({ error: because("must be a boolean") });

const numberWhere = (reason: string, accept: (value: number) => boolean) =>
  z.number({ error: because(reason) }).refine(accept, { error: because(reason) });

const listOf = <T extends z.ZodType>(item: T, reason = "must be an array") => z.array(item, { error: because(reason) });

const block = <T extends z.core.$ZodLooseShape>(shape: T) => z.object(shape, { error: because("must be an object") });

const whenClean = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

const cronSchedule = text("must be a cron expression string").refine((value) => cron.validate(value), {
  error: (issue) => `'${String(issue.input)}' is not a valid cron expression`,
});

const POSITIVE_DURATION = "must be a positive duration string like '7d', '24h', or '2w'";
const positiveDuration = text(POSITIVE_DURATION).refine((value) => (parseDuration(value) ?? 0) > 0, {
  error: because(POSITIVE_DURATION),
});

const MAX_AGE = "must be a duration string like '14d', '12h', or '2w', greater than zero and under 200000y";
const MAX_AGE_LIMIT_MS = parseDuration("200000y")!;
const branchMaxAge = text(MAX_AGE).refine(
  (value) => {
    const ms = parseDuration(value) ?? 0;
    return ms > 0 && ms < MAX_AGE_LIMIT_MS;
  },
  { error: because(MAX_AGE) },
);

const BLANK_BRANCH_PATTERN =
  "must not be empty or whitespace-only: such a pattern matches no branch, and a branchInclude matching nothing " +
  "prunes every worktree. Omit the field to sync every branch";
const branchPatterns = listOf(
  text().refine((pattern) => pattern.trim() !== "", { error: BLANK_BRANCH_PATTERN }),
  "must be an array of strings",
);

const positiveSafeInteger = (reason = "must be a positive safe integer") =>
  numberWhere(reason, (value) => Number.isSafeInteger(value) && value >= 1);

const gitTimeoutMs = numberWhere(
  `must be 0 (disables the timeout) or a whole number of milliseconds from ${MIN_GIT_TIMEOUT_MS} to ${MAX_TIMER_DELAY_MS}`,
  (value) => Number.isInteger(value) && (value === 0 || (value >= MIN_GIT_TIMEOUT_MS && value <= MAX_TIMER_DELAY_MS)),
);

const repositoryMode = z.enum([REPOSITORY_MODES.CLONE, REPOSITORY_MODES.WORKTREE], {
  error: because("must be 'clone' or 'worktree'"),
});

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

const parallelismLimit = positiveSafeInteger("must be a positive integer").optional();
const parallelismSchema = block({
  maxRepositories: parallelismLimit,
  maxWorktreeCreation: parallelismLimit,
  maxWorktreeUpdates: parallelismLimit,
  maxWorktreeRemoval: parallelismLimit,
  maxStatusChecks: parallelismLimit,
  maxBranchFetches: parallelismLimit,
});

function checkLevelParallelismPeak(
  parallelism: ParallelismConfig | null | undefined,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): boolean {
  if (!parallelism) return false;
  const maxRepos = parallelism.maxRepositories ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;
  const peak = computeParallelismPeak(parallelism);
  const limit = DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS;
  if (peak.total <= limit) return false;

  const { field, label, value } = peak.widestPhase;
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
    path,
    message:
      `peak concurrent git processes (${peak.total}) exceeds safe limit (${limit}). ` +
      `Sync phases run one after another, so the peak is ${maxRepos} ` +
      `${maxRepos === 1 ? "repository" : "repositories"} × the widest phase ` +
      `(${label}, ${field}: ${value}) = ${peak.total} git processes. ` +
      `${headroom}${phaseAdvice} Consider reducing maxRepositories or lowering ${field}.`,
  });
  return true;
}

const nonEmptyStrings = listOf(nonEmptyText());

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
  skipUpdateWhenOutsideSparse: flag().optional(),
}).superRefine((sparse, ctx) => {
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

const sharedFields = {
  cronSchedule: cronSchedule.optional(),
  retry: retrySchema.optional(),
  branchMaxAge: branchMaxAge.optional(),
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

const internalFields = {
  logger: z.unknown().optional(),
  __configFileDir: z.unknown().optional(),
  __configuredRepoDirs: z.unknown().optional(),
};

const wholeFileSetting = (key: "runOnce" | "syncOnStart") =>
  z.undefined({ error: `cannot be set on a repository; use defaults.${key}` }).optional();

const REPO_URL_FORMATS =
  "Expected an HTTP(S), SSH, Git protocol or file:// URL, an scp-style 'user@host:path/repo.git', or an absolute " +
  "filesystem path. All but HTTP(S) must name the repository's own path segment; an HTTP(S) URL may stop at the " +
  "host, but then the entry needs an explicit 'bareRepoDir'";

export const repositorySchema = block({
  name: nonEmptyText().superRefine((name, ctx) => {
    if (name.trim() === "") return;
    try {
      sanitizeNameForPath(name);
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error;
      ctx.addIssue({ code: "custom", message: error.reason });
    }
  }),
  repoUrl: text().refine((url) => isValidGitUrl(url), {
    error: (issue) => `is not a repository URL, got ${describeValue(issue.input)}. ${REPO_URL_FORMATS}`,
  }),
  worktreeDir: nonEmptyText(),
  bareRepoDir: text().optional(),
  ...sharedFields,
  parallelism: parallelismSchema.optional(),
  runOnce: wholeFileSetting("runOnce"),
  syncOnStart: wholeFileSetting("syncOnStart"),
  ...internalFields,
});

export const defaultsSchema = block({
  ...sharedFields,
  parallelism: parallelismSchema.optional(),
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
    defaults: defaultsSchema.nullable().optional(),
    retry: retrySchema.optional(),
    parallelism: parallelismSchema.optional(),
  },
  { error: because("must be an object with a 'repositories' array") },
);

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

function checkModeSpecificFields(config: ValidatedConfigFile, ctx: z.RefinementCtx): void {
  const defaults = config.defaults ?? undefined;
  config.repositories.forEach((repo, index) => {
    const mode = repo.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;
    const [fields, reason] =
      mode === REPOSITORY_MODES.CLONE
        ? [CLONE_MODE_CONFLICTING_FIELDS, "not supported when mode is 'clone'"]
        : [CLONE_MODE_ONLY_FIELDS, "only supported when mode is 'clone'"];
    for (const field of fields) {
      const fromDefaults = field === "bareRepoDir" ? undefined : defaults?.[field];
      const inherited = repo[field] === undefined && fromDefaults !== undefined;
      if (repo[field] === undefined && !inherited) continue;
      ctx.addIssue({
        code: "custom",
        path: ["repositories", index, field],
        message: inherited ? `${reason} (inherited from defaults.${field})` : reason,
      });
    }
  });
}

type MaxRepositoriesLevel = { maxRepositories?: number } | null;
type MaxRepositoriesSource = {
  parallelism?: MaxRepositoriesLevel;
  defaults?: { parallelism?: MaxRepositoriesLevel } | null;
};

export function resolveMaxRepositories(config: MaxRepositoriesSource): number {
  return (
    config.defaults?.parallelism?.maxRepositories ??
    config.parallelism?.maxRepositories ??
    DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES
  );
}

export function definedOnly<T extends object>(block: T | undefined): Partial<T> {
  if (!block) return {};
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function isCloneMode(config: ValidatedConfigFile, repo: ValidatedConfigFile["repositories"][number]): boolean {
  return (repo.mode ?? config.defaults?.mode ?? REPOSITORY_MODES.WORKTREE) === REPOSITORY_MODES.CLONE;
}

const CLONE_MODE_PEAK: ParallelismPeak = {
  perRepository: SIMPLE_GIT_CLIENT_CONCURRENCY,
  total: SIMPLE_GIT_CLIENT_CONCURRENCY,
  widestPhase: { field: "maxRepositories", label: "clone sync", value: SIMPLE_GIT_CLIENT_CONCURRENCY },
};

function checkMergedParallelismPeak(config: ValidatedConfigFile, ctx: z.RefinementCtx): void {
  const global = definedOnly(config.parallelism);
  const defaults = definedOnly(config.defaults?.parallelism);
  const maxRepos = resolveMaxRepositories(config);

  const peaks = config.repositories
    .map((repo) => ({
      name: repo.name,
      peak: isCloneMode(config, repo)
        ? CLONE_MODE_PEAK
        : computeParallelismPeak({ ...global, ...defaults, ...definedOnly(repo.parallelism) }),
    }))
    .sort((a, b) => b.peak.perRepository - a.peak.perRepository);

  const concurrent = peaks.slice(0, maxRepos);
  const total = concurrent.reduce((sum, repo) => sum + repo.peak.perRepository, 0);
  const limit = DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS;
  if (total <= limit) return;

  const listed = 3;
  const shown = concurrent
    .slice(0, listed)
    .map(({ name, peak }) =>
      peak === CLONE_MODE_PEAK
        ? `'${name}' (clone mode, ${peak.perRepository})`
        : `'${name}' (${peak.widestPhase.label}, ${peak.widestPhase.field}: ${peak.widestPhase.value})`,
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

export const configFileSchema = configFileBaseSchema.superRefine((config, ctx) => {
  if (!config.repositories.every((repo) => isCloneMode(config, repo))) {
    const top = checkLevelParallelismPeak(config.parallelism, ["parallelism"], ctx);
    const fromDefaults = checkLevelParallelismPeak(config.defaults?.parallelism, ["defaults", "parallelism"], ctx);
    if (top || fromDefaults) return;
  }
  checkDuplicateNames(config, ctx);
  checkModeSpecificFields(config, ctx);
  checkMergedParallelismPeak(config, ctx);
}, whenClean);

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

export const KNOWN_CONFIG_KEYS: KnownConfigKeys = {
  topLevel: Object.keys(configFileBaseSchema.shape),
  defaults: Object.keys(defaultsSchema.shape),
  repository: Object.keys(repositorySchema.shape),
  nested: { ...nestedKeysOf(repositorySchema.shape), ...nestedKeysOf(defaultsSchema.shape) },
};

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "default export";
  return path.reduce<string>((out, segment) => {
    if (typeof segment === "number") return `${out}[${segment}]`;
    return out === "" ? String(segment) : `${out}.${String(segment)}`;
  }, "");
}

function repositoryNameAt(config: unknown, path: readonly PropertyKey[]): string | undefined {
  if (path[0] !== "repositories" || typeof path[1] !== "number") return undefined;
  const repositories = (config as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) return undefined;
  const entry: unknown = repositories[path[1]];
  const name = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

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
