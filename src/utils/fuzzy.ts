export interface FuzzyMatch {
  score: number;
  positions: number[];
}

const SCORE_MATCH = 16;
const BONUS_CONSECUTIVE = 12;
const BONUS_BOUNDARY = 10;
const BONUS_CAMEL = 6;
const BONUS_FIRST_CHAR = 8;
const BONUS_EXACT_CASE = 1;
const PENALTY_GAP = 1;
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

function matchTerm(text: string, lowerText: string, term: string): FuzzyMatch | null {
  const lowerTerm = term.toLowerCase();
  let best: FuzzyMatch | null = null;
  let start = lowerText.indexOf(lowerTerm[0]);
  while (start !== -1) {
    const candidate = matchFrom(text, lowerText, term, lowerTerm, start);
    if (candidate === null) break;
    if (best === null || candidate.score > best.score) best = candidate;
    start = lowerText.indexOf(lowerTerm[0], start + 1);
  }
  return best;
}

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
