/**
 * Nib Fuzzy Search
 *
 * Zero-dependency fuzzy string matching for command/search.
 * Implements:
 *   - Character-by-character subsequence matching (smart case)
 *   - Result scoring with quality ranking
 *   - Highlight ranges for matched characters
 *   - Prefix boosting and positional scoring
 *
 * Fully offline, pure TypeScript.
 */

// ── Types ──

export interface FuzzyMatch {
  /** The original item that matched */
  item: string;
  /** Quality score (higher = better match, 0-100) */
  score: number;
  /** Indices in the original string that matched */
  indices: number[];
  /** The display string (original) */
  display: string;
}

export interface FuzzyResult<T = string> {
  item: T;
  score: number;
  indices: number[];
}

/**
 * Compute a fuzzy match score between a query and a target string.
 * Returns null if no match, or a FuzzyResult with score 0-100.
 *
 * Algorithm:
 * 1. Greedy character-by-character scan (fast, O(n*m) worst case)
 * 2. Score rewards: adjacency, camelCase boundaries, word boundaries,
 *    prefix matches, and query-to-target length ratio.
 * 3. Case-insensitive matching with case-sensitive bonus.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult<string> | null {
  if (!query) return null;

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Quick reject: all query chars must appear in order in target
  let qi = 0;
  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) {
      qi++;
    }
  }
  if (qi < queryLower.length) return null;

  // Compute match positions (greedy left-to-right)
  const indices: number[] = [];
  qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) {
      indices.push(ti);
      qi++;
    }
  }

  // Score computation
  let score = 0;
  const queryLen = query.length;
  const targetLen = target.length;

  // Base score from length ratio (shorter queries matching longer targets get partial)
  const lengthRatio = queryLen / Math.max(targetLen, 1);
  score += lengthRatio * 30;

  // Bonus for prefix matches
  if (targetLower.startsWith(queryLower)) {
    score += 25;
  }

  // Bonus for each matched character's position quality
  let consecutiveBonus = 0;
  let wordBoundaryBonus = 0;
  let camelCaseBonus = 0;

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];

    // Consecutive match bonus
    if (i > 0 && indices[i - 1] === idx - 1) {
      consecutiveBonus += 5;
    }

    // Word boundary bonus (after space, hyphen, underscore, slash)
    if (idx === 0 || /[\s\-_./\\]/.test(target[idx - 1])) {
      wordBoundaryBonus += 10;
    }

    // CamelCase bonus (uppercase after lowercase)
    if (idx > 0 && /[a-z]/.test(target[idx - 1]) && /[A-Z]/.test(target[idx])) {
      camelCaseBonus += 8;
    }

    // Positional penalty for late matches
    const positionalRatio = 1 - (idx / Math.max(targetLen, 1));
    score += positionalRatio * 2;
  }

  score += consecutiveBonus;
  score += wordBoundaryBonus;
  score += camelCaseBonus;

  // Case sensitivity bonus (exact case match per char)
  let caseMatchBonus = 0;
  for (let i = 0; i < query.length; i++) {
    if (indices[i] !== undefined && target[indices[i]] === query[i]) {
      caseMatchBonus += 2;
    }
  }
  score += caseMatchBonus;

  // Penalty for unmatched characters between matches
  if (indices.length > 1) {
    for (let i = 1; i < indices.length; i++) {
      const gap = indices[i] - indices[i - 1] - 1;
      if (gap > 0) {
        score -= Math.min(gap * 2, 10);
      }
    }
  }

  // Normalize to 0-100
  score = Math.max(0, Math.min(100, score));

  return { item: target, score, indices };
}

/**
 * Fuzzy filter an array of strings against a query.
 * Returns all matches sorted by score (descending).
 */
export function fuzzyFilter(items: string[], query: string): FuzzyMatch[] {
  if (!query.trim()) return [];

  const results: FuzzyMatch[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const match = fuzzyMatch(query, item);
    if (match && !seen.has(item)) {
      seen.add(item);
      results.push({
        item,
        score: match.score,
        indices: match.indices,
        display: item,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Apply ANSI highlighting to a matched string.
 * Wraps matched characters in bold+color escape codes.
 */
export function highlightMatches(
  text: string,
  indices: number[],
  colorEnabled: boolean,
): string {
  if (!colorEnabled || indices.length === 0) return text;

  const chars = text.split("");
  for (let i = indices.length - 1; i >= 0; i--) {
    const idx = indices[i];
    if (idx >= 0 && idx < chars.length) {
      chars[idx] = `\x1b[1m\x1b[38;5;39m${chars[idx]}\x1b[0m`;
    }
  }
  return chars.join("");
}

/**
 * Search history entries by fuzzy matching against a query.
 * Returns top-N results sorted by score.
 */
export function searchHistory(
  history: string[],
  query: string,
  maxResults = 10,
): { entry: string; score: number }[] {
  if (!query.trim() || history.length === 0) return [];

  const results: { entry: string; score: number }[] = [];

  for (const entry of history) {
    // Match against the full history entry
    const match = fuzzyMatch(query, entry);
    if (match && match.score > 20) {
      // Score threshold to filter noise
      results.push({ entry, score: match.score });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}
