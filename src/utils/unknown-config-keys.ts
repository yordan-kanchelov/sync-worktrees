/**
 * Why the loader warns about unknown keys rather than rejecting them, and how often.
 *
 * The config schema (services/config-schema.ts) validates the keys it knows
 * and lets any other key through, so a repository carrying
 * `updateExistingWorktree` — the plural dropped — validates clean, is discarded
 * by `resolveRepositoryConfig`, and the checkout it was meant to freeze goes on
 * being fast-forwarded with nothing said; the generated config's `@satisfies`
 * header catches that in a TypeScript-aware editor and never at load time.
 *
 * A warning, not a rejection: the file is user-written JavaScript that has
 * always tolerated a stray field. The scan runs after validation, so a real
 * error still fails first, and once per `loadConfigFile` — once per `list` or
 * `run`, neither of which re-reads the file per tick. A reload (the TUI's `r`,
 * a repeat MCP `load_config`) warns again on purpose: that file was just
 * edited. Nothing is cached between loads.
 *
 * The inventory of known keys is not written down here: `KNOWN_CONFIG_KEYS` in
 * config-schema.ts reads it off the schema's own shapes, so a key the schema
 * validates is by construction a key this scan accepts.
 *
 * Where the lines land: `ConfigLoaderService`'s logger sinks the loader's
 * warnings and nothing else, and unset it falls through to `console.warn`,
 * where the duplicate-repoUrl and nested-worktreeDir warnings have always gone.
 * Both are stderr, which is not incidental — `RepositoryContext` loads config
 * files inside the MCP stdio server, whose stdout carries the JSON-RPC stream,
 * and passes an explicit stderr logger for that reason.
 */

/** The keys each level of a config file accepts. */
export interface KnownConfigKeys {
  topLevel: readonly string[];
  defaults: readonly string[];
  repository: readonly string[];
  /** Every block that is an object, and the keys it accepts; the same at every level. */
  nested: Readonly<Record<string, readonly string[]>>;
}

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
function collectFrom(
  target: Record<string, unknown>,
  known: readonly string[],
  nested: KnownConfigKeys["nested"],
  location: string,
): UnknownConfigKey[] {
  const found: UnknownConfigKey[] = [];

  for (const key of Object.keys(target)) {
    if (!known.includes(key)) {
      found.push({ location, keyPath: key, suggestion: suggestConfigKey(key, known) });
      continue;
    }
    const nestedKnown = Object.hasOwn(nested, key) ? nested[key] : undefined;
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
 * Every key of a validated config file that nothing reads. Called after
 * validation, so each repository already has a string `name`.
 */
export function collectUnknownConfigKeys(config: Record<string, unknown>, known: KnownConfigKeys): UnknownConfigKey[] {
  const found = collectFrom(config, known.topLevel, known.nested, "at the top level");

  if (isPlainObject(config.defaults)) {
    found.push(...collectFrom(config.defaults, known.defaults, known.nested, "in defaults"));
  }

  const repositories = Array.isArray(config.repositories) ? config.repositories : [];
  repositories.forEach((repo: unknown, index: number) => {
    if (!isPlainObject(repo)) return;
    const location = typeof repo.name === "string" ? `in repository '${repo.name}'` : `in repository at index ${index}`;
    found.push(...collectFrom(repo, known.repository, known.nested, location));
  });

  return found;
}

/** The one-line form the loader warns with. */
export function formatUnknownConfigKey(finding: UnknownConfigKey): string {
  const suggestion = finding.suggestion ? ` (did you mean '${finding.suggestion}'?)` : "";
  return `[sync-worktrees] Unknown config key '${finding.keyPath}' ${finding.location} is ignored${suggestion}`;
}
