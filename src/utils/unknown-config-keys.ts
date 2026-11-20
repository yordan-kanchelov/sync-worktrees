export interface KnownConfigKeys {
  topLevel: readonly string[];
  defaults: readonly string[];
  repository: readonly string[];
  nested: Readonly<Record<string, readonly string[]>>;
}

export interface UnknownConfigKey {
  location: string;
  keyPath: string;
  suggestion?: string;
}

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

function allowedEdits(a: string, b: string): number {
  return Math.min(a.length, b.length) <= 4 ? 1 : 2;
}

export function suggestConfigKey(unknownKey: string, candidates: readonly string[]): string | undefined {
  const lowered = unknownKey.toLowerCase();
  const caseOnly = candidates.find((candidate) => candidate.toLowerCase() === lowered);
  if (caseOnly) return caseOnly;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const allowed = allowedEdits(unknownKey, candidate);
    const distance = editDistance(unknownKey, candidate);
    if (distance > allowed) continue;
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

export function formatUnknownConfigKey(finding: UnknownConfigKey): string {
  const suggestion = finding.suggestion ? ` (did you mean '${finding.suggestion}'?)` : "";
  return `[sync-worktrees] Unknown config key '${finding.keyPath}' ${finding.location} is ignored${suggestion}`;
}
