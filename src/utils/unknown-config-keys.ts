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
} from "../types";

/**
 * Compile-time proof that an inventory below covers its interface exactly.
 *
 * `satisfies readonly (keyof X)[]` on each list rejects a name that is not a
 * real key; `Assert<IsNever<Exclude<keyof X, listed>>>` rejects a real key that
 * nobody listed. Together they pin the list to `keyof X` in both directions, so
 * the inventory cannot be "hand-maintained" in the sense that matters: adding a
 * field to `Config` (or to any nested block) and forgetting this file is a
 * `tsc --noEmit` error on both `tsconfig.json` and `tsconfig.spec.json`, which
 * is `pnpm typecheck` and a required CI step. This is the same shape the public
 * config surface is pinned with in types/__tests__/public-config-types.test.ts.
 *
 * They are also what keeps the scan's depth honest. It stops one level down
 * because the surface stops there: the six nested interfaces hold only scalars
 * and string arrays, so there is no third level to walk. A new nested object
 * one level down forces its owner's list to grow here, which is where whoever
 * adds it meets NESTED_KNOWN_KEYS; a new nested object on `Config` itself grows
 * SHARED_CONFIG_KEYS and nothing forces the NESTED_KNOWN_KEYS entry, so that is
 * the one direction left to remember.
 *
 * Why the loader warns rather than rejects, and how often.
 *
 * `validateConfigFile` inspects only keys it knows, so a repository carrying
 * `updateExistingWorktree` — the plural dropped — validates clean, is discarded
 * by `resolveRepositoryConfig`, and the checkout it was meant to freeze goes on
 * being fast-forwarded with nothing said; the generated config's `@satisfies`
 * header catches that in a TypeScript-aware editor and never at load time.
 *
 * A warning, not a rejection: the file is user-written JavaScript that has
 * always tolerated a stray field. The scan runs last, so a real error still
 * fails first, and once per `loadConfigFile` — once per `list` or `run`, neither
 * of which re-reads the file per tick. A reload (the TUI's `r`, a repeat MCP
 * `load_config`) warns again on purpose: that file was just edited. Nothing is
 * cached between loads, so this shares no state with
 * `configPathsEvaluatedInProcess`.
 *
 * Where the lines land: `ConfigLoaderService`'s logger sinks the loader's
 * warnings and nothing else, and unset it falls through to `console.warn`,
 * where the duplicate-repoUrl and nested-worktreeDir warnings have always gone.
 * Both are stderr, which is not incidental — `RepositoryContext` loads config
 * files inside the MCP stdio server, whose stdout carries the JSON-RPC stream,
 * and passes an explicit stderr logger for that reason.
 *
 * This prose sits on a non-exported declaration on purpose: esbuild strips
 * statement-level comments from both bundles and tsc copies nothing from here
 * into the `.d.ts`, so it costs no shipped bytes. The same text inside
 * `ConfigLoaderService`'s class body was paid for three times over.
 */
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

/**
 * Keys accepted on a repository entry and under `defaults` alike — everything
 * `Config` declares that a user is meant to write.
 */
const SHARED_CONFIG_KEYS = [
  "repoUrl",
  "worktreeDir",
  "cronSchedule",
  "runOnce",
  "bareRepoDir",
  "retry",
  "parallelism",
  "branchMaxAge",
  "branchInclude",
  "branchExclude",
  "skipLfs",
  "updateExistingWorktrees",
  "debug",
  "filesToCopyOnBranchCreate",
  "hooks",
  "sparseCheckout",
  "maintenance",
  "trash",
  "mode",
  "branch",
  "depth",
  "fetchTimeoutMs",
  "cloneTimeoutMs",
] as const satisfies readonly (keyof Config)[];

/**
 * Set by the loader or read only in-process, never written in a config file.
 * Listed rather than omitted so the exhaustiveness check below still covers
 * them: a new `Config` field must be classified as user-facing or internal,
 * it cannot simply go unmentioned. They are accepted in silence — reporting
 * `__configFileDir` as *unknown* would be the wrong word for it.
 */
const INTERNAL_CONFIG_KEYS = [
  "logger",
  "__configFileDir",
  "__configuredRepoDirs",
] as const satisfies readonly (keyof Config)[];

/** `defaults` is a `Partial<Config>`: everything above, and nothing repository-only. */
export const KNOWN_DEFAULTS_KEYS: readonly string[] = [...SHARED_CONFIG_KEYS, ...INTERNAL_CONFIG_KEYS];

/** A repository entry is a `Config` plus its `name`. */
export const KNOWN_REPOSITORY_KEYS: readonly string[] = ["name", ...KNOWN_DEFAULTS_KEYS];

/** The four blocks the file itself may carry. */
export const KNOWN_TOP_LEVEL_KEYS = [
  "repositories",
  "defaults",
  "retry",
  "parallelism",
] as const satisfies readonly (keyof ConfigFile)[];

const KNOWN_RETRY_KEYS = [
  "maxAttempts",
  "maxLfsRetries",
  "initialDelayMs",
  "maxDelayMs",
  "backoffMultiplier",
  "jitterMs",
] as const satisfies readonly (keyof RetryConfig)[];

const KNOWN_PARALLELISM_KEYS = [
  "maxRepositories",
  "maxWorktreeCreation",
  "maxWorktreeUpdates",
  "maxWorktreeRemoval",
  "maxStatusChecks",
  "maxBranchFetches",
] as const satisfies readonly (keyof ParallelismConfig)[];

const KNOWN_SPARSE_CHECKOUT_KEYS = [
  "include",
  "exclude",
  "mode",
  "skipUpdateWhenOutsideSparse",
] as const satisfies readonly (keyof SparseCheckoutConfig)[];

const KNOWN_TRASH_KEYS = [
  "enabled",
  "retentionDays",
  "warnSizeBytes",
  "migrateLegacy",
] as const satisfies readonly (keyof TrashConfig)[];

const KNOWN_MAINTENANCE_KEYS = [
  "enabled",
  "interval",
  "aggressive",
] as const satisfies readonly (keyof MaintenanceConfig)[];

const KNOWN_HOOKS_KEYS = ["onBranchCreated"] as const satisfies readonly (keyof HooksConfig)[];

type _RepositoryKeysComplete = Assert<
  IsNever<
    Exclude<
      keyof RepositoryConfig,
      "name" | (typeof SHARED_CONFIG_KEYS)[number] | (typeof INTERNAL_CONFIG_KEYS)[number]
    >
  >
>;
type _TopLevelKeysComplete = Assert<IsNever<Exclude<keyof ConfigFile, (typeof KNOWN_TOP_LEVEL_KEYS)[number]>>>;
type _RetryKeysComplete = Assert<IsNever<Exclude<keyof RetryConfig, (typeof KNOWN_RETRY_KEYS)[number]>>>;
type _ParallelismKeysComplete = Assert<
  IsNever<Exclude<keyof ParallelismConfig, (typeof KNOWN_PARALLELISM_KEYS)[number]>>
>;
type _SparseCheckoutKeysComplete = Assert<
  IsNever<Exclude<keyof SparseCheckoutConfig, (typeof KNOWN_SPARSE_CHECKOUT_KEYS)[number]>>
>;
type _TrashKeysComplete = Assert<IsNever<Exclude<keyof TrashConfig, (typeof KNOWN_TRASH_KEYS)[number]>>>;
type _MaintenanceKeysComplete = Assert<
  IsNever<Exclude<keyof MaintenanceConfig, (typeof KNOWN_MAINTENANCE_KEYS)[number]>>
>;
type _HooksKeysComplete = Assert<IsNever<Exclude<keyof HooksConfig, (typeof KNOWN_HOOKS_KEYS)[number]>>>;

/** Every block that is an object, and the keys it accepts. */
export const NESTED_KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  retry: KNOWN_RETRY_KEYS,
  parallelism: KNOWN_PARALLELISM_KEYS,
  sparseCheckout: KNOWN_SPARSE_CHECKOUT_KEYS,
  trash: KNOWN_TRASH_KEYS,
  maintenance: KNOWN_MAINTENANCE_KEYS,
  hooks: KNOWN_HOOKS_KEYS,
};

export interface UnknownConfigKey {
  /** Reads inside the message: "in repository 'web'", "in defaults", "at the top level". */
  location: string;
  /** `updateExistingWorktree`, or `retry.maxAttemptz` for a nested one. */
  keyPath: string;
  /** Nearest known key, when one is near enough to be worth naming. */
  suggestion?: string;
}

/** Levenshtein distance. The candidate lists are a couple of dozen short strings. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * How far apart two key names may be and still be the same word typed wrong:
 * one edit for a short name and two from five characters up, measured on the
 * shorter of the pair. The length gate earns its place on four-letter keys,
 * where two edits reach a different word: `nope` is two substitutions from
 * `mode`, and without the gate a stray `nope` would be told to write `mode`. It
 * costs the transposition cases in exchange — `anme` is two edits from `name`
 * and gets no suggestion either. `name` and `mode` are three edits apart, so
 * that pair is held apart by the distance and not by this gate.
 * Keys that are the wrong word rather than a misspelling — `retries`
 * for `retry`, `maxAge` for `branchMaxAge` — fall outside it and are reported
 * with no suggestion, which is the honest answer; the warning is the part that
 * matters.
 */
function allowedEdits(a: string, b: string): number {
  return Math.min(a.length, b.length) <= 4 ? 1 : 2;
}

/** Nearest known key, or undefined when nothing is close enough to name. */
export function suggestConfigKey(unknownKey: string, candidates: readonly string[]): string | undefined {
  const lowered = unknownKey.toLowerCase();
  // A case-only difference (`sparseCheckOut`) always wins: same word, typed wrong.
  const caseOnly = candidates.find((candidate) => candidate.toLowerCase() === lowered);
  if (caseOnly) return caseOnly;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const allowed = allowedEdits(unknownKey, candidate);
    const distance = editDistance(unknownKey, candidate);
    if (distance > allowed) continue;
    // Ties broken alphabetically so the message is stable across runs.
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unknown keys on one object, plus the unknown keys of any nested block it
 * carries. Membership is decided on the key name alone and never on the value,
 * so a known key that is present with the value `undefined` — the shape
 * `{ maxStatusChecks: Number(process.env.X) || undefined }` produces — is a
 * known key here, exactly as it is for `resolveRepositoryConfig`.
 */
function collectFrom(target: Record<string, unknown>, known: readonly string[], location: string): UnknownConfigKey[] {
  const found: UnknownConfigKey[] = [];

  for (const key of Object.keys(target)) {
    if (!known.includes(key)) {
      found.push({ location, keyPath: key, suggestion: suggestConfigKey(key, known) });
      continue;
    }
    const nestedKnown = NESTED_KNOWN_KEYS[key];
    const value = target[key];
    if (!nestedKnown || !isPlainObject(value)) continue;
    for (const nestedKey of Object.keys(value)) {
      if (nestedKnown.includes(nestedKey)) continue;
      found.push({
        location,
        keyPath: `${key}.${nestedKey}`,
        suggestion: suggestConfigKey(nestedKey, nestedKnown),
      });
    }
  }

  return found;
}

/**
 * Every key of a validated config file that nothing reads. Called after the
 * known-key validation, so each repository already has a string `name`.
 */
export function collectUnknownConfigKeys(config: Record<string, unknown>): UnknownConfigKey[] {
  const found = collectFrom(config, KNOWN_TOP_LEVEL_KEYS, "at the top level");

  if (isPlainObject(config.defaults)) {
    found.push(...collectFrom(config.defaults, KNOWN_DEFAULTS_KEYS, "in defaults"));
  }

  const repositories = Array.isArray(config.repositories) ? config.repositories : [];
  repositories.forEach((repo: unknown, index: number) => {
    if (!isPlainObject(repo)) return;
    const location = typeof repo.name === "string" ? `in repository '${repo.name}'` : `in repository at index ${index}`;
    found.push(...collectFrom(repo, KNOWN_REPOSITORY_KEYS, location));
  });

  return found;
}

/** The one-line form the loader warns with. */
export function formatUnknownConfigKey(finding: UnknownConfigKey): string {
  const suggestion = finding.suggestion ? ` (did you mean '${finding.suggestion}'?)` : "";
  return `[sync-worktrees] Unknown config key '${finding.keyPath}' ${finding.location} is ignored${suggestion}`;
}
