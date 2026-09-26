/**
 * A small subsequence matcher for the TUI's switcher. Every character of the
 * query has to appear in the text, in order, ignoring case; the score rewards
 * runs of consecutive characters and matches that start a word, and charges a
 * little for every character skipped, so `swm` ranks `sync-worktrees › main`
 * above a label where those letters happen to be scattered. No dependency: the
 * lists are a few hundred short labels, and this is linear in their length for
 * every place the query's first character occurs.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the text (UTF-16 code units) of every matched character, ascending. */
  positions: number[];
}

const SCORE_MATCH = 16;
const BONUS_CONSECUTIVE = 12;
const BONUS_BOUNDARY = 10;
const BONUS_CAMEL = 6;
const BONUS_FIRST_CHAR = 8;
const BONUS_EXACT_CASE = 1;
const PENALTY_GAP = 1;
// A gap before the first match counts, but less: `main` should still find
// `repo › main`, and a long repository name must not bury its own branches.
const PENALTY_LEADING_GAP = 0.25;

const SEPARATORS = new Set(["/", "-", "_", ".", " ", "›", ":", "@"]);

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return SEPARATORS.has(text[index - 1]);
}

function isCamelHump(text: string, index: number): boolean {
  if (index === 0) return false;
  const prev = text[index - 1];
  const ch = text[index];
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && ch !== ch.toLowerCase();
}

/** Score one path through `text` that starts matching `query` at `start`. */
function matchFrom(
  text: string,
  lowerText: string,
  query: string,
  lowerQuery: string,
  start: number,
): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let textIndex = start;
  for (let q = 0; q < lowerQuery.length; q++) {
    const found = lowerText.indexOf(lowerQuery[q], textIndex);
    if (found === -1) return null;
    const prev = positions.length > 0 ? positions[positions.length - 1] : -1;
    score += SCORE_MATCH;
    if (prev !== -1 && found === prev + 1) {
      score += BONUS_CONSECUTIVE;
    } else if (prev !== -1) {
      score -= PENALTY_GAP * (found - prev - 1);
    }
    if (isBoundary(text, found)) score += BONUS_BOUNDARY;
    else if (isCamelHump(text, found)) score += BONUS_CAMEL;
    if (text[found] === query[q]) score += BONUS_EXACT_CASE;
    positions.push(found);
    textIndex = found + 1;
  }
  if (positions[0] === 0) score += BONUS_FIRST_CHAR;
  score -= PENALTY_LEADING_GAP * positions[0];
  return { score, positions };
}

/**
 * Match one term (no whitespace) against `text`. Tries every occurrence of the
 * term's first character as a starting point and keeps the best, which is what
 * lets `main` prefer the word `main` over the `m` of `my-repo`.
 */
function matchTerm(text: string, lowerText: string, term: string): FuzzyMatch | null {
  const lowerTerm = term.toLowerCase();
  let best: FuzzyMatch | null = null;
  let start = lowerText.indexOf(lowerTerm[0]);
  while (start !== -1) {
    const candidate = matchFrom(text, lowerText, term, lowerTerm, start);
    // No later start can match if this one could not: it has strictly less
    // text left to find the rest of the term in.
    if (candidate === null) break;
    if (best === null || candidate.score > best.score) best = candidate;
    start = lowerText.indexOf(lowerTerm[0], start + 1);
  }
  return best;
}

/**
 * Match `query` against `text`. Whitespace splits the query into terms that
 * must all match, each on its own, the way fzf reads `api feat`. An empty or
 * all-blank query matches everything with a score of 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const terms = query.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return { score: 0, positions: [] };
  const lowerText = text.toLowerCase();
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const match = matchTerm(text, lowerText, term);
    if (match === null) return null;
    score += match.score;
    for (const position of match.positions) positions.add(position);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export interface FuzzyResult<T> {
  item: T;
  match: FuzzyMatch;
}

/**
 * The items `query` matches, best first. Ties keep the shorter text first and
 * then the order the items came in, so an empty query returns the list as it
 * was given.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): FuzzyResult<T>[] {
  const results: Array<FuzzyResult<T> & { index: number; length: number }> = [];
  items.forEach((item, index) => {
    const text = getText(item);
    const match = fuzzyMatch(query, text);
    if (match !== null) results.push({ item, match, index, length: text.length });
  });
  if (query.trim().length === 0) return results.map(({ item, match }) => ({ item, match }));
  results.sort((a, b) => b.match.score - a.match.score || a.length - b.length || a.index - b.index);
  return results.map(({ item, match }) => ({ item, match }));
}
