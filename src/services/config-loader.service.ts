import { createRequire } from "module";
import * as path from "path";
import { pathToFileURL } from "url";

import * as cron from "node-cron";

import { CONFIG_FILE_NAMES, DEFAULT_CONFIG } from "../constants";
import { ConfigFileNotFoundError, ConfigValidationError, SyncWorktreesError } from "../errors";
import { matchesPattern } from "../utils/branch-filter";
import { parseDuration } from "../utils/date-filter";
import { fileExists } from "../utils/file-exists";
import { getDefaultBareRepoDir, redactRepoUrl, redactSecretsInText } from "../utils/git-url";
import { isPathEqualOrInside, isPathStrictlyInside, normalizePathForCompare, pathsEqual } from "../utils/path-compare";
import { SIMPLE_GIT_CLIENT_CONCURRENCY } from "../utils/git-client";
import { REPOSITORY_MODES, isRepositoryMode } from "../utils/repo-mode";
import { sanitizeNameForPath } from "../utils/sanitize-name";

import type { Config, ConfigFile, ParallelismConfig, RepositoryConfig, RepositoryMode } from "../types";

const require = createRequire(import.meta.url);

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
 * Every per-repository parallelism setting: the phase it bounds, and the git
 * processes that phase can really run at once. The phases run one after another
 * — create, then prune, then update — so a repository's peak is the widest
 * single phase, never the sum of all of them. (The update phase runs its
 * read-only probes under its own `maxStatusChecks`-wide limiter and its
 * fast-forwards under `maxWorktreeUpdates`, one after the other, so both are
 * already covered by taking the maximum.)
 *
 * This table is the one place a parallelism setting is declared: it drives the
 * positive-integer validation as well as the peak, so a phase added here cannot
 * reach the arithmetic unvalidated.
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

/** Every parallelism setting that must be a positive integer. */
const PARALLELISM_INT_FIELDS: ReadonlyArray<keyof ParallelismConfig> = [
  "maxRepositories",
  ...PARALLELISM_PHASES.map((phase) => phase.field),
];

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

const CLONE_MODE_CONFLICTING_FIELDS = [
  "branchInclude",
  "branchExclude",
  "branchMaxAge",
  "updateExistingWorktrees",
  "bareRepoDir",
  "trash",
] as const satisfies readonly (keyof RepositoryConfig)[];

export class ConfigLoaderService {
  async findConfigUpward(startDir: string): Promise<string | null> {
    let current = path.resolve(startDir);
    const root = path.parse(current).root;

    while (true) {
      for (const name of CONFIG_FILE_NAMES) {
        const candidate = path.join(current, name);
        if (await fileExists(candidate)) {
          return candidate;
        }
      }
      if (current === root) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  async loadConfigFile(configPath: string): Promise<ConfigFile> {
    const absolutePath = path.resolve(configPath);

    if (!(await fileExists(absolutePath))) {
      throw new ConfigFileNotFoundError(absolutePath);
    }

    try {
      let config: unknown;
      if (absolutePath.endsWith(".cjs")) {
        this.clearRequireCacheSubtree(absolutePath);
        const configModule = require(absolutePath) as { default?: unknown };
        config = configModule.default ?? configModule;
      } else {
        const fileUrl = pathToFileURL(absolutePath);
        fileUrl.searchParams.set("t", Date.now().toString());
        const configModule = (await import(fileUrl.href)) as { default?: unknown };
        config = configModule.default;
      }

      if (!config) {
        throw new Error("Config file must use 'export default' syntax");
      }

      this.validateConfigFile(config);

      return config;
    } catch (error) {
      if (error instanceof SyncWorktreesError) {
        throw error;
      }
      throw new Error(`Failed to load config file: ${(error as Error).message}`);
    }
  }

  private validateConfigFile(config: unknown): asserts config is ConfigFile {
    if (!config || typeof config !== "object") {
      throw new Error("Config file must export an object");
    }

    const configObj = config as Record<string, unknown>;

    if (!Array.isArray(configObj.repositories)) {
      throw new Error("Config file must have a 'repositories' array");
    }

    if (configObj.repositories.length === 0) {
      throw new Error("Config file must have at least one repository");
    }

    const seenNames = new Set<string>();

    configObj.repositories.forEach((repo: unknown, index: number) => {
      if (!repo || typeof repo !== "object") {
        throw new Error(`Repository at index ${index} must be an object`);
      }

      const repoObj = repo as Record<string, unknown>;

      if (!repoObj.name || typeof repoObj.name !== "string") {
        throw new Error(`Repository at index ${index} must have a 'name' property`);
      }

      if (seenNames.has(repoObj.name)) {
        throw new Error(`Duplicate repository name: ${repoObj.name}`);
      }
      seenNames.add(repoObj.name);

      if (!repoObj.repoUrl || typeof repoObj.repoUrl !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'repoUrl' property`);
      }

      if (!this.isValidGitUrl(repoObj.repoUrl)) {
        throw new Error(
          `Repository '${repoObj.name}' has invalid 'repoUrl': '${redactSecretsInText(repoObj.repoUrl)}'. ` +
            `Expected an HTTP(S), SSH, Git protocol URL, or a local/file path (file://, absolute filesystem path)`,
        );
      }

      if (!repoObj.worktreeDir || typeof repoObj.worktreeDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'worktreeDir' property`);
      }

      if (repoObj.bareRepoDir !== undefined && typeof repoObj.bareRepoDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'bareRepoDir' property`);
      }

      if (repoObj.cronSchedule !== undefined && typeof repoObj.cronSchedule !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'cronSchedule' property`);
      }

      if (typeof repoObj.cronSchedule === "string" && !cron.validate(repoObj.cronSchedule)) {
        throw new Error(`Repository '${repoObj.name}' has invalid cron expression: '${repoObj.cronSchedule}'`);
      }

      if (repoObj.runOnce !== undefined) {
        throw new ConfigValidationError(`Repository '${repoObj.name}' runOnce`, "cannot be set; use defaults.runOnce");
      }

      if (repoObj.debug !== undefined && typeof repoObj.debug !== "boolean") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'debug' property`);
      }

      this.validateBranchPatternList(repoObj.branchInclude, `Repository '${repoObj.name}' branchInclude`);
      this.validateBranchPatternList(repoObj.branchExclude, `Repository '${repoObj.name}' branchExclude`);
      this.validateBranchMaxAge(repoObj.branchMaxAge, `Repository '${repoObj.name}' branchMaxAge`);
      this.validateBoolean(repoObj.skipLfs, `Repository '${repoObj.name}' skipLfs`);
      this.validateBoolean(repoObj.updateExistingWorktrees, `Repository '${repoObj.name}' updateExistingWorktrees`);

      if (repoObj.retry !== undefined) {
        this.validateRetryConfig(repoObj.retry, `Repository '${repoObj.name}' retry config`);
      }

      if (repoObj.filesToCopyOnBranchCreate !== undefined) {
        this.validateFilesToCopyConfig(repoObj.filesToCopyOnBranchCreate, `Repository '${repoObj.name}'`);
      }

      if (repoObj.hooks !== undefined) {
        this.validateHooksConfig(repoObj.hooks, `Repository '${repoObj.name}'`);
      }

      if (repoObj.sparseCheckout !== undefined) {
        this.validateSparseCheckoutConfig(repoObj.sparseCheckout, `Repository '${repoObj.name}'`);
      }

      if (repoObj.maintenance !== undefined) {
        this.validateMaintenanceConfig(repoObj.maintenance, `Repository '${repoObj.name}'`);
      }

      if (repoObj.trash !== undefined) {
        this.validateTrashConfig(repoObj.trash, `Repository '${repoObj.name}'`);
      }

      this.validateDepth(repoObj.depth, `Repository '${repoObj.name}' depth`);
      this.validateRepositoryMode(repoObj, configObj.defaults as Record<string, unknown> | undefined);
    });

    this.warnOnDuplicateRepoUrls(configObj.repositories as Array<Record<string, unknown>>);

    if (configObj.defaults) {
      if (typeof configObj.defaults !== "object") {
        throw new Error("'defaults' must be an object");
      }

      const defaults = configObj.defaults as Record<string, unknown>;

      if (defaults.cronSchedule !== undefined && typeof defaults.cronSchedule !== "string") {
        throw new Error("Invalid 'cronSchedule' in defaults");
      }
      if (typeof defaults.cronSchedule === "string" && !cron.validate(defaults.cronSchedule)) {
        throw new Error(`Invalid cron expression in defaults: '${defaults.cronSchedule}'`);
      }
      if (defaults.runOnce !== undefined && typeof defaults.runOnce !== "boolean") {
        throw new Error("Invalid 'runOnce' in defaults");
      }
      if (defaults.debug !== undefined && typeof defaults.debug !== "boolean") {
        throw new Error("Invalid 'debug' in defaults");
      }
      this.validateBranchPatternList(defaults.branchInclude, "defaults.branchInclude");
      this.validateBranchPatternList(defaults.branchExclude, "defaults.branchExclude");
      this.validateBranchMaxAge(defaults.branchMaxAge, "defaults.branchMaxAge");
      this.validateBoolean(defaults.skipLfs, "defaults.skipLfs");
      this.validateBoolean(defaults.updateExistingWorktrees, "defaults.updateExistingWorktrees");
      if (defaults.retry !== undefined && typeof defaults.retry !== "object") {
        throw new Error("Invalid 'retry' in defaults");
      }
      if (defaults.retry !== undefined) {
        this.validateRetryConfig(defaults.retry, "defaults retry config");
      }
      if (defaults.filesToCopyOnBranchCreate !== undefined) {
        this.validateFilesToCopyConfig(defaults.filesToCopyOnBranchCreate, "defaults");
      }

      if (defaults.hooks !== undefined) {
        this.validateHooksConfig(defaults.hooks, "defaults");
      }

      if (defaults.sparseCheckout !== undefined) {
        this.validateSparseCheckoutConfig(defaults.sparseCheckout, "defaults");
      }

      if (defaults.maintenance !== undefined) {
        this.validateMaintenanceConfig(defaults.maintenance, "defaults");
      }

      if (defaults.trash !== undefined) {
        this.validateTrashConfig(defaults.trash, "defaults");
      }

      this.validateDepth(defaults.depth, "defaults.depth");

      if (defaults.mode !== undefined && !isRepositoryMode(defaults.mode)) {
        throw new ConfigValidationError("defaults.mode", "must be 'clone' or 'worktree'");
      }

      if (defaults.branch !== undefined && (typeof defaults.branch !== "string" || defaults.branch.trim() === "")) {
        throw new ConfigValidationError("defaults.branch", "must be a non-empty string");
      }
    }

    if (configObj.retry !== undefined) {
      this.validateRetryConfig(configObj.retry, "retry config");
    }

    if (configObj.parallelism !== undefined) {
      this.validateParallelismConfig(configObj.parallelism, "global");
    }

    if (configObj.defaults && typeof configObj.defaults === "object") {
      const defaults = configObj.defaults as Record<string, unknown>;
      if (defaults.parallelism !== undefined) {
        this.validateParallelismConfig(defaults.parallelism, "defaults");
      }
    }
  }

  private clearRequireCacheSubtree(configPath: string): void {
    let resolved: string;
    try {
      resolved = require.resolve(configPath);
    } catch {
      resolved = configPath;
    }

    const seen = new Set<string>();
    const visit = (modulePath: string): void => {
      if (seen.has(modulePath)) return;
      seen.add(modulePath);

      const cached = require.cache[modulePath];
      if (!cached) return;

      for (const child of cached.children) {
        visit(child.id);
      }
      delete require.cache[modulePath];
    };

    visit(resolved);
  }

  private validateDepth(value: unknown, field: string): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigValidationError(field, "must be a positive safe integer");
    }
  }

  private validateBoolean(value: unknown, field: string): void {
    if (value !== undefined && typeof value !== "boolean") {
      throw new ConfigValidationError(field, "must be a boolean");
    }
  }

  private validateBranchPatternList(value: unknown, field: string): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string")) {
      throw new ConfigValidationError(field, "must be an array of strings");
    }
  }

  private validateBranchMaxAge(value: unknown, field: string): void {
    if (value === undefined) return;
    if (typeof value !== "string" || parseDuration(value) === null) {
      throw new ConfigValidationError(field, "must be a duration string like '14d', '12h', or '2w'");
    }
  }

  private validateMaintenanceConfig(value: unknown, context: string): void {
    if (value === undefined) return;
    if (typeof value !== "object" || value === null) {
      throw new Error(`'maintenance' in ${context} must be an object`);
    }
    const maintenance = value as Record<string, unknown>;
    if (maintenance.enabled !== undefined && typeof maintenance.enabled !== "boolean") {
      throw new Error(`'maintenance.enabled' in ${context} must be a boolean`);
    }
    if (maintenance.aggressive !== undefined && typeof maintenance.aggressive !== "boolean") {
      throw new Error(`'maintenance.aggressive' in ${context} must be a boolean`);
    }
    if (maintenance.interval !== undefined) {
      const parsed = typeof maintenance.interval === "string" ? parseDuration(maintenance.interval) : null;
      // Zero parses fine but would disable throttling entirely (gc every tick).
      if (parsed === null || parsed <= 0) {
        throw new Error(
          `'maintenance.interval' in ${context} must be a positive duration string like '7d', '24h', or '2w'`,
        );
      }
    }
  }

  private validateTrashConfig(value: unknown, context: string): void {
    if (value === undefined) return;
    if (typeof value !== "object" || value === null) {
      throw new Error(`'trash' in ${context} must be an object`);
    }
    const trash = value as Record<string, unknown>;
    if (trash.enabled !== undefined && typeof trash.enabled !== "boolean") {
      throw new Error(`'trash.enabled' in ${context} must be a boolean`);
    }
    if (trash.migrateLegacy !== undefined && typeof trash.migrateLegacy !== "boolean") {
      throw new Error(`'trash.migrateLegacy' in ${context} must be a boolean`);
    }
    if (
      trash.retentionDays !== undefined &&
      (typeof trash.retentionDays !== "number" || !Number.isFinite(trash.retentionDays) || trash.retentionDays <= 0)
    ) {
      throw new Error(`'trash.retentionDays' in ${context} must be a positive number`);
    }
    if (
      trash.warnSizeBytes !== undefined &&
      (typeof trash.warnSizeBytes !== "number" || !Number.isFinite(trash.warnSizeBytes) || trash.warnSizeBytes <= 0)
    ) {
      throw new Error(`'trash.warnSizeBytes' in ${context} must be a positive number`);
    }
  }

  private validateRetryConfig(value: unknown, context: string): void {
    if (typeof value !== "object" || value === null) {
      throw new Error(context === "retry config" ? "'retry' must be an object" : `Invalid 'retry' in ${context}`);
    }

    const retry = value as Record<string, unknown>;

    if (retry.maxAttempts !== undefined) {
      if (retry.maxAttempts !== "unlimited" && (typeof retry.maxAttempts !== "number" || retry.maxAttempts < 1)) {
        throw new Error("Invalid 'maxAttempts' in retry config. Must be 'unlimited' or a positive number");
      }
    }

    if (retry.maxLfsRetries !== undefined) {
      if (typeof retry.maxLfsRetries !== "number" || retry.maxLfsRetries < 0) {
        throw new Error("Invalid 'maxLfsRetries' in retry config. Must be a non-negative number");
      }
    }

    if (retry.initialDelayMs !== undefined && (typeof retry.initialDelayMs !== "number" || retry.initialDelayMs < 0)) {
      throw new Error("Invalid 'initialDelayMs' in retry config");
    }

    if (retry.maxDelayMs !== undefined && (typeof retry.maxDelayMs !== "number" || retry.maxDelayMs < 0)) {
      throw new Error("Invalid 'maxDelayMs' in retry config");
    }

    if (
      retry.backoffMultiplier !== undefined &&
      (typeof retry.backoffMultiplier !== "number" || retry.backoffMultiplier < 1)
    ) {
      throw new Error("Invalid 'backoffMultiplier' in retry config");
    }

    if (retry.jitterMs !== undefined && (typeof retry.jitterMs !== "number" || retry.jitterMs < 0)) {
      throw new Error("Invalid 'jitterMs' in retry config");
    }

    const initialDelay = (retry.initialDelayMs as number) ?? DEFAULT_CONFIG.RETRY.INITIAL_DELAY_MS;
    const maxDelay = (retry.maxDelayMs as number) ?? DEFAULT_CONFIG.RETRY.MAX_DELAY_MS;
    if (initialDelay > maxDelay) {
      throw new Error(
        `Invalid retry config: 'initialDelayMs' (${initialDelay}) must not exceed 'maxDelayMs' (${maxDelay})`,
      );
    }
  }

  private validateParallelismConfig(parallelism: unknown, context: string): void {
    if (typeof parallelism !== "object" || parallelism === null) {
      throw new Error(`'parallelism' in ${context} must be an object`);
    }

    const config = parallelism as Record<string, unknown>;

    // Validating into a typed object keeps the peak arithmetic from ever seeing
    // a value this loop did not check: both read the same field list.
    const validated: ParallelismConfig = {};
    for (const field of PARALLELISM_INT_FIELDS) {
      const value = config[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new ConfigValidationError(`${context} parallelism.${field}`, "must be a positive integer");
      }
      validated[field] = value;
    }

    const maxRepos = validated.maxRepositories ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;
    const peak = computeParallelismPeak(validated);
    const limit = DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS;

    if (peak.total > limit) {
      const { field, label, value } = peak.widestPhase;
      // Both ways out of the failure, each solving for the other side: how many
      // repositories fit at this phase width, and how wide the phase may be at
      // this repository count. Either can come out below 1, in which case that
      // half of the advice would be nonsense and is left out.
      const safeMaxRepos = Math.floor(limit / peak.perRepository);
      const safePhaseValue = Math.floor(limit / maxRepos);
      const headroom =
        safeMaxRepos >= 1
          ? `With ${field} at ${value}, maximum safe maxRepositories is ${safeMaxRepos}.`
          : `Even one repository exceeds the limit at ${field}: ${value}.`;
      const phaseAdvice =
        safePhaseValue >= 1 ? ` With maxRepositories at ${maxRepos}, ${field} must be ${safePhaseValue} or less.` : "";
      throw new Error(
        `Peak concurrent git processes (${peak.total}) exceeds safe limit (${limit}). ` +
          `Sync phases run one after another, so the peak is ${maxRepos} ` +
          `${maxRepos === 1 ? "repository" : "repositories"} × the widest phase ` +
          `(${label}, ${field}: ${value}) = ${peak.total} git processes. ` +
          `${headroom}${phaseAdvice} Consider reducing maxRepositories or lowering ${field}.`,
      );
    }
  }

  private validateFilesToCopyConfig(filesToCopy: unknown, context: string): void {
    if (!Array.isArray(filesToCopy)) {
      throw new Error(`'filesToCopyOnBranchCreate' in ${context} must be an array`);
    }

    for (let i = 0; i < filesToCopy.length; i++) {
      const pattern: unknown = filesToCopy[i];
      if (typeof pattern !== "string" || pattern.trim() === "") {
        throw new Error(
          `'filesToCopyOnBranchCreate' in ${context} must contain only non-empty strings (invalid at index ${i})`,
        );
      }
    }
  }

  private validateSparseCheckoutConfig(value: unknown, context: string): void {
    if (typeof value !== "object" || value === null) {
      throw new Error(`'sparseCheckout' in ${context} must be an object`);
    }

    const cfg = value as Record<string, unknown>;

    if (!Array.isArray(cfg.include)) {
      throw new Error(`'sparseCheckout.include' in ${context} must be an array`);
    }
    if (cfg.include.length === 0) {
      throw new Error(`'sparseCheckout.include' in ${context} must contain at least one pattern`);
    }
    for (let i = 0; i < cfg.include.length; i++) {
      const p: unknown = cfg.include[i];
      if (typeof p !== "string" || p.trim() === "") {
        throw new Error(
          `'sparseCheckout.include' in ${context} must contain only non-empty strings (invalid at index ${i})`,
        );
      }
    }

    if (cfg.exclude !== undefined) {
      if (!Array.isArray(cfg.exclude)) {
        throw new Error(`'sparseCheckout.exclude' in ${context} must be an array`);
      }
      for (let i = 0; i < cfg.exclude.length; i++) {
        const p: unknown = cfg.exclude[i];
        if (typeof p !== "string" || p.trim() === "") {
          throw new Error(
            `'sparseCheckout.exclude' in ${context} must contain only non-empty strings (invalid at index ${i})`,
          );
        }
      }
    }

    if (cfg.mode !== undefined && cfg.mode !== "cone" && cfg.mode !== "no-cone") {
      throw new Error(`'sparseCheckout.mode' in ${context} must be 'cone' or 'no-cone'`);
    }
  }

  private warnOnDuplicateRepoUrls(repositories: Array<Record<string, unknown>>): void {
    const seen = new Map<string, string[]>();
    for (const repo of repositories) {
      const url = typeof repo.repoUrl === "string" ? repo.repoUrl : null;
      const name = typeof repo.name === "string" ? repo.name : null;
      if (!url || !name) continue;
      const list = seen.get(url) ?? [];
      list.push(name);
      seen.set(url, list);
    }
    for (const [url, names] of seen) {
      if (names.length > 1) {
        console.warn(
          `[sync-worktrees] repoUrl '${redactRepoUrl(url)}' appears in multiple entries (${names.join(", ")}). ` +
            `Pin 'bareRepoDir' on duplicate entries to make config reorder-proof.`,
        );
      }
    }
  }

  private validateRepositoryMode(
    repoObj: Record<string, unknown>,
    defaults: Record<string, unknown> | undefined,
  ): void {
    const repoName = repoObj.name as string;
    const repoMode = repoObj.mode;

    if (repoMode !== undefined && !isRepositoryMode(repoMode)) {
      throw new ConfigValidationError(`Repository '${repoName}' mode`, "must be 'clone' or 'worktree'");
    }

    if (repoObj.branch !== undefined && (typeof repoObj.branch !== "string" || repoObj.branch.trim() === "")) {
      throw new ConfigValidationError(`Repository '${repoName}' branch`, "must be a non-empty string");
    }

    const effectiveMode = repoMode ?? (defaults?.mode as RepositoryMode | undefined);
    if (effectiveMode !== REPOSITORY_MODES.CLONE) {
      const depthFromRepo = repoObj.depth;
      const depthFromDefaults = defaults?.depth;
      if (depthFromRepo !== undefined || depthFromDefaults !== undefined) {
        const source = depthFromRepo !== undefined ? "repository" : "defaults";
        throw new ConfigValidationError(
          `Repository '${repoName}' depth`,
          `only supported when mode is 'clone' (set on ${source})`,
        );
      }

      const branchFromRepo = repoObj.branch;
      const branchFromDefaults = defaults?.branch;
      if (branchFromRepo !== undefined || branchFromDefaults !== undefined) {
        const source = branchFromRepo !== undefined ? "repository" : "defaults";
        throw new ConfigValidationError(
          `Repository '${repoName}' branch`,
          `only supported when mode is 'clone' (set on ${source})`,
        );
      }

      return;
    }

    for (const field of CLONE_MODE_CONFLICTING_FIELDS) {
      const fromRepo = repoObj[field];
      const fromDefaults = defaults?.[field];
      const present = fromRepo !== undefined || fromDefaults !== undefined;
      if (present) {
        const source = fromRepo !== undefined ? "repository" : "defaults";
        throw new ConfigValidationError(
          `Repository '${repoName}' ${field}`,
          `not supported when mode is 'clone' (set on ${source})`,
        );
      }
    }
  }

  private validateHooksConfig(hooks: unknown, context: string): void {
    if (typeof hooks !== "object" || hooks === null) {
      throw new Error(`'hooks' in ${context} must be an object`);
    }

    const hooksObj = hooks as Record<string, unknown>;

    if (hooksObj.onBranchCreated !== undefined) {
      if (!Array.isArray(hooksObj.onBranchCreated)) {
        throw new Error(`'hooks.onBranchCreated' in ${context} must be an array`);
      }

      for (let i = 0; i < hooksObj.onBranchCreated.length; i++) {
        const command: unknown = hooksObj.onBranchCreated[i];
        if (typeof command !== "string" || command.trim() === "") {
          throw new Error(
            `'hooks.onBranchCreated' in ${context} must contain only non-empty strings (invalid at index ${i})`,
          );
        }
      }
    }
  }

  resolveRepositoryConfig(
    repo: RepositoryConfig,
    defaults?: Partial<Config>,
    configDir?: string,
    globalRetry?: Config["retry"],
    allRepositories?: RepositoryConfig[],
    globalParallelism?: Config["parallelism"],
  ): RepositoryConfig {
    const mode: RepositoryMode = repo.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;

    const resolved: RepositoryConfig = {
      name: repo.name,
      repoUrl: repo.repoUrl,
      worktreeDir: this.resolvePath(repo.worktreeDir, configDir),
      cronSchedule: repo.cronSchedule ?? defaults?.cronSchedule ?? DEFAULT_CONFIG.CRON_SCHEDULE,
      runOnce: defaults?.runOnce ?? false,
      debug: repo.debug ?? defaults?.debug,
      mode,
    };

    if (configDir) {
      resolved.__configFileDir = configDir;
    }

    if (mode === REPOSITORY_MODES.CLONE) {
      if (repo.branch ?? defaults?.branch) {
        resolved.branch = repo.branch ?? defaults?.branch;
      }
      if (repo.depth !== undefined || defaults?.depth !== undefined) {
        resolved.depth = repo.depth ?? defaults?.depth;
      }
    } else {
      if (repo.bareRepoDir) {
        resolved.bareRepoDir = this.resolvePath(repo.bareRepoDir, configDir);
      } else if (allRepositories && this.isDuplicateRepoUrl(repo, allRepositories, defaults)) {
        const sanitized = sanitizeNameForPath(repo.name, `Repository '${repo.name}' name`);
        resolved.bareRepoDir = this.resolvePath(`.bare/${sanitized}`, configDir);
      } else {
        resolved.bareRepoDir = this.resolvePath(getDefaultBareRepoDir(repo.repoUrl), configDir);
      }

      if (repo.branchMaxAge || defaults?.branchMaxAge) {
        resolved.branchMaxAge = repo.branchMaxAge ?? defaults?.branchMaxAge;
      }

      if (repo.branchInclude || defaults?.branchInclude) {
        resolved.branchInclude = repo.branchInclude ?? defaults?.branchInclude;
      }

      if (repo.branchExclude || defaults?.branchExclude) {
        resolved.branchExclude = repo.branchExclude ?? defaults?.branchExclude;
      }

      if (repo.updateExistingWorktrees !== undefined || defaults?.updateExistingWorktrees !== undefined) {
        resolved.updateExistingWorktrees = repo.updateExistingWorktrees ?? defaults?.updateExistingWorktrees ?? true;
      }
    }

    if (repo.skipLfs !== undefined || defaults?.skipLfs !== undefined) {
      resolved.skipLfs = repo.skipLfs ?? defaults?.skipLfs ?? false;
    }

    if (repo.retry || defaults?.retry || globalRetry) {
      resolved.retry = {
        ...(globalRetry || {}),
        ...(defaults?.retry || {}),
        ...(repo.retry || {}),
      };
    }

    // Top level, then defaults, then the repository — the same precedence as
    // retry above. Without the top-level layer a `parallelism` block written
    // where the example config shows it (and where `retry` works) reached no
    // repository at all, so per-repo limits silently stayed at their defaults.
    if (repo.parallelism || defaults?.parallelism || globalParallelism) {
      resolved.parallelism = {
        ...(globalParallelism || {}),
        ...(defaults?.parallelism || {}),
        ...(repo.parallelism || {}),
      };
    }

    if (repo.filesToCopyOnBranchCreate || defaults?.filesToCopyOnBranchCreate) {
      resolved.filesToCopyOnBranchCreate = [
        ...(repo.filesToCopyOnBranchCreate ?? defaults?.filesToCopyOnBranchCreate ?? []),
      ];
    }

    if (repo.hooks || defaults?.hooks) {
      resolved.hooks = {
        ...(defaults?.hooks || {}),
        ...(repo.hooks || {}),
      };
    }

    const sparse = repo.sparseCheckout ?? defaults?.sparseCheckout;
    if (sparse) {
      resolved.sparseCheckout = sparse;
    }

    if (repo.maintenance || defaults?.maintenance) {
      resolved.maintenance = {
        ...(defaults?.maintenance || {}),
        ...(repo.maintenance || {}),
      };
    }

    if (repo.trash || defaults?.trash) {
      resolved.trash = {
        ...(defaults?.trash || {}),
        ...(repo.trash || {}),
      };
    }

    this.validateWorktreeBareRepoSeparation(resolved);

    return resolved;
  }

  private validateWorktreeBareRepoSeparation(repo: RepositoryConfig): void {
    if (repo.mode === REPOSITORY_MODES.CLONE || !repo.bareRepoDir) return;

    const worktreeDir = normalizePathForCompare(repo.worktreeDir);
    const bareRepoDir = normalizePathForCompare(repo.bareRepoDir);
    const worktreeContainsBare = bareRepoDir === worktreeDir || bareRepoDir.startsWith(worktreeDir + path.sep);
    const bareContainsWorktree = worktreeDir.startsWith(bareRepoDir + path.sep);

    if (worktreeContainsBare || bareContainsWorktree) {
      throw new ConfigValidationError(
        `Repository '${repo.name}' bareRepoDir/worktreeDir`,
        `must not overlap (bareRepoDir: ${repo.bareRepoDir}, worktreeDir: ${repo.worktreeDir})`,
      );
    }
  }

  private isDuplicateRepoUrl(repo: RepositoryConfig, all: RepositoryConfig[], defaults?: Partial<Config>): boolean {
    const firstIndex = all.findIndex((r) => {
      const mode = r.mode ?? defaults?.mode ?? REPOSITORY_MODES.WORKTREE;
      return r.repoUrl === repo.repoUrl && mode === REPOSITORY_MODES.WORKTREE;
    });
    const myIndex = all.indexOf(repo);
    return firstIndex !== -1 && myIndex !== -1 && myIndex !== firstIndex;
  }

  /**
   * Rejects entries whose directories collide across the config: two entries
   * sharing a worktreeDir (either mode) or a bareRepoDir, or one entry's
   * worktreeDir overlapping another entry's bareRepoDir. Each entry's own
   * worktreeDir/bareRepoDir separation is checked in resolveRepositoryConfig;
   * this is the cross-entry check. A worktreeDir nested inside another
   * entry's worktreeDir is allowed but warned about.
   */
  detectPathCollisions(repositories: RepositoryConfig[]): void {
    for (let i = 0; i < repositories.length; i++) {
      for (let j = i + 1; j < repositories.length; j++) {
        this.detectPathCollisionBetween(repositories[i], repositories[j]);
      }
    }
  }

  private detectPathCollisionBetween(a: RepositoryConfig, b: RepositoryConfig): void {
    if (pathsEqual(a.worktreeDir, b.worktreeDir)) {
      throw new ConfigValidationError(
        `Repositories '${a.name}' and '${b.name}' worktreeDir`,
        `resolve to the same worktreeDir '${path.resolve(a.worktreeDir)}'. ` +
          `Each repository needs its own worktreeDir; sharing one lets each sync move the other's checkouts to trash.`,
      );
    }

    if (a.bareRepoDir && b.bareRepoDir && pathsEqual(a.bareRepoDir, b.bareRepoDir)) {
      throw new ConfigValidationError(
        `Repositories '${a.name}' and '${b.name}' bareRepoDir`,
        `resolve to the same bareRepoDir '${path.resolve(a.bareRepoDir)}'. ` +
          `Set distinct 'bareRepoDir' values for duplicate repoUrl entries.`,
      );
    }

    this.rejectWorktreeBareOverlap(a, b);
    this.rejectWorktreeBareOverlap(b, a);

    if (isPathStrictlyInside(a.worktreeDir, b.worktreeDir)) {
      this.warnOnNestedWorktreeDirs(a, b);
    } else if (isPathStrictlyInside(b.worktreeDir, a.worktreeDir)) {
      this.warnOnNestedWorktreeDirs(b, a);
    }
  }

  // `worktreeOwner`'s worktreeDir must not sit at or under `bareOwner`'s bare
  // repo (worktrees would land inside git's object store), and `bareOwner`'s
  // bare repo must not sit at or under `worktreeOwner`'s worktreeDir (the
  // sync would treat it as a stale checkout directory).
  private rejectWorktreeBareOverlap(worktreeOwner: RepositoryConfig, bareOwner: RepositoryConfig): void {
    if (!bareOwner.bareRepoDir) return;
    if (
      isPathEqualOrInside(worktreeOwner.worktreeDir, bareOwner.bareRepoDir) ||
      isPathEqualOrInside(bareOwner.bareRepoDir, worktreeOwner.worktreeDir)
    ) {
      throw new ConfigValidationError(
        `Repositories '${worktreeOwner.name}' and '${bareOwner.name}' worktreeDir/bareRepoDir`,
        `must not overlap ('${worktreeOwner.name}' worktreeDir: ${path.resolve(worktreeOwner.worktreeDir)}, ` +
          `'${bareOwner.name}' bareRepoDir: ${path.resolve(bareOwner.bareRepoDir)})`,
      );
    }
  }

  private warnOnNestedWorktreeDirs(inner: RepositoryConfig, outer: RepositoryConfig): void {
    console.warn(
      `[sync-worktrees] worktreeDir '${path.resolve(inner.worktreeDir)}' of repository '${inner.name}' is inside ` +
        `worktreeDir '${path.resolve(outer.worktreeDir)}' of repository '${outer.name}'. ` +
        `A remote branch of '${outer.name}' whose directory name matches would move '${inner.name}' to trash. ` +
        `Give each repository its own worktreeDir.`,
    );
  }

  private isValidGitUrl(url: string): boolean {
    // HTTP(S) URLs
    if (/^https?:\/\/.+/.test(url)) return true;
    // SSH URLs (git@host:path or ssh://...)
    if (/^(ssh:\/\/|git@).+/.test(url)) return true;
    // Git protocol
    if (/^git:\/\/.+/.test(url)) return true;
    // Local file paths (absolute)
    if (/^(file:\/\/|\/|[A-Za-z]:\\)/.test(url)) return true;
    return false;
  }

  private resolvePath(inputPath: string, baseDir?: string): string {
    if (path.isAbsolute(inputPath)) {
      return inputPath;
    }

    return path.resolve(baseDir || process.cwd(), inputPath);
  }

  filterRepositories(repositories: RepositoryConfig[], filter?: string): RepositoryConfig[] {
    if (!filter) {
      return repositories;
    }

    const patterns = filter.split(",").map((p) => p.trim());

    return repositories.filter((repo) => {
      return patterns.some((pattern) => matchesPattern(repo.name, pattern));
    });
  }

  async buildRepositories(
    configPath: string,
    overrides?: { filter?: string },
  ): Promise<{ repositories: RepositoryConfig[]; configFile: ConfigFile; configDir: string }> {
    const configFile = await this.loadConfigFile(configPath);
    const configDir = path.dirname(path.resolve(configPath));

    let repositories = configFile.repositories.map((repo) =>
      this.resolveRepositoryConfig(
        repo,
        configFile.defaults,
        configDir,
        configFile.retry,
        configFile.repositories,
        configFile.parallelism,
      ),
    );

    this.detectPathCollisions(repositories);

    if (overrides?.filter) {
      repositories = this.filterRepositories(repositories, overrides.filter);
    }

    return { repositories, configFile, configDir };
  }
}
