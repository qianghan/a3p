/**
 * Resolve which candidate a follow-up message like "save the first one" or
 * "save the TD one" refers to, against the candidate list from a prior
 * find-* skill turn. Shared by save-scholarship and save-coop-opportunity
 * so the resolution logic exists in exactly one place.
 *
 * Resolution order:
 *   1. Ordinal ("first"..."fifth", "#2", "2nd") — index into candidates.
 *   2. Fuzzy — score each candidate by how many of its title's (plus any
 *      extraMatchFields', e.g. "employer") words (2+ chars, excluding common
 *      stopwords like "the", "of", "to") appear in the user's message;
 *      highest score wins.
 *
 * Returns null if candidates is empty, or if neither resolution succeeds.
 */
const FUZZY_MATCH_STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'it', 'that', 'this', 'with', 'from', 'by', 'as']);

export function resolveOrdinalOrFuzzyCandidate<T extends { title: string }>(
  candidates: T[],
  text: string,
  extraMatchFields: string[] = [],
): T | null {
  if (candidates.length === 0) return null;
  const lowerText = (text || '').toLowerCase();

  const ordinalWords: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
  let ordinalIndex: number | null = null;
  for (const [word, idx] of Object.entries(ordinalWords)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lowerText)) { ordinalIndex = idx; break; }
  }
  if (ordinalIndex === null) {
    const numMatch = lowerText.match(/#\s*(\d+)|\b(\d+)(?:st|nd|rd|th)\b/);
    if (numMatch) ordinalIndex = parseInt(numMatch[1] || numMatch[2], 10) - 1;
  }
  if (ordinalIndex !== null && candidates[ordinalIndex]) {
    return candidates[ordinalIndex];
  }

  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const fieldValues = [c.title, ...extraMatchFields.map((f) => (c as any)[f])].filter(Boolean).join(' ');
    const words = fieldValues.toLowerCase().split(/\W+/).filter((w: string) => w.length >= 2 && !FUZZY_MATCH_STOPWORDS.has(w));
    const score = words.filter((w: string) => lowerText.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
