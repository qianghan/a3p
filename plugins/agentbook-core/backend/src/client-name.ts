/**
 * Cleaning a client name pulled out of free text.
 *
 * The chat extractors capture "whatever sits between the verb and the amount":
 *
 *     text.match(/invoice\s+(.+?)\s+\$/i)
 *
 * which on the most natural phrasings keeps the grammar as part of the name:
 *
 *     "invoice Acme for $5000"        -> "Acme for"
 *     "invoice to Acme for $5000"     -> "to Acme for"
 *     "got $5000 from Acme yesterday" -> "Acme yesterday"
 *
 * Each of those creates a NEW client record, so one real client ends up split
 * across several rows. That is not cosmetic in a bookkeeping product: "who owes
 * me money?" and the aging report both group by client, so a split client
 * understates what any one of them owes. Production had "to Acme for" sitting
 * next to "Acme Corp".
 *
 * Deliberately conservative — it strips grammar, never words that could be part
 * of a company name. Leading articles ("The Home Depot") are left alone.
 *
 * IMPLEMENTATION NOTE — this works on TOKENS, not anchored regexes.
 * The first version used `/\s+(?:for|on|…)$/` in a loop and `/[,;:.!?]+$/`,
 * both of which are quadratic on a long run of the repeated character, and both
 * of which CodeQL flagged (js/polynomial-redos) on attacker-controlled chat
 * text. The second one was the very pattern fixed hours earlier in
 * period-parse.ts and written again here from muscle memory. Popping words off
 * an array is linear and cannot regress that way.
 */

/**
 * Prepositions the capture group swallows on the way in. Only stripped from
 * the FRONT, where no company name legitimately begins.
 */
const LEADING_GRAMMAR = new Set(['to', 'for', 'from']);

/**
 * Connectors that sit between the client and the rest of the sentence, plus
 * time words that trail a payment. Only stripped from the END.
 */
const TRAILING_GRAMMAR = new Set([
  'for', 'on', 're', 'regarding', 'about', 'covering', 'due', 'dated', 'per',
  'of', 'with', 'at',
  'yesterday', 'today', 'tomorrow', 'tonight',
  'invoice', 'payment', 'estimate', 'quote', 'proposal',
]);

/** "…last week" / "…this month" — a two-token trailing period. */
const PERIOD_HEADS = new Set(['last', 'this', 'next']);
const PERIOD_UNITS = new Set(['week', 'month', 'quarter', 'year']);

/** Longest name we will accept; anything past this is a run-on sentence. */
const MAX_NAME_LENGTH = 60;

/**
 * Hard ceiling on the input we will even look at. A capture this long is never
 * a client name, and refusing it up front bounds every operation below —
 * belt-and-braces alongside the token approach, since the input is chat text.
 */
const MAX_INPUT_LENGTH = 500;

const TRAILING_PUNCTUATION = new Set([',', ';', ':', '.', '!', '?']);

/**
 * A capture that is nothing BUT grammar. The leading/trailing strippers need a
 * neighbouring word to bite ("to Acme"), so a bare "to" survives them and would
 * otherwise be stored as a client.
 */
const GRAMMAR_ONLY = new Set([
  'to', 'for', 'from', 'on', 'at', 'of', 'with', 're', 'the', 'a', 'an', 'and',
  'invoice', 'payment', 'estimate', 'quote', 'proposal', 'client', 'customer',
]);

/** Strip trailing punctuation with a scan — `/[,;:.!?]+$/` is quadratic. */
function trimTrailingPunctuation(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(s[end - 1])) end--;
  return s.slice(0, end);
}

/**
 * Returns a cleaned client name, or null when nothing usable is left.
 *
 * Callers MUST treat null as "no client name found" rather than falling back to
 * the raw capture — a junk name is worse than no name, because it silently
 * creates a duplicate client instead of asking the user who they meant.
 */
export function cleanClientName(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_INPUT_LENGTH) return null;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  // Front: one preposition at most — "to Acme", never "to to Acme".
  if (LEADING_GRAMMAR.has(words[0].toLowerCase())) words.shift();

  // Back: keep popping while the tail is grammar. "Acme for last week" needs
  // three pops, and the two-token period ("last week") is checked first so
  // "last" is not mistaken for a name.
  let popped = true;
  while (popped && words.length > 0) {
    popped = false;
    const last = words[words.length - 1].toLowerCase();
    const secondLast = words.length > 1 ? words[words.length - 2].toLowerCase() : '';
    if (PERIOD_UNITS.has(last) && PERIOD_HEADS.has(secondLast)) {
      words.length -= 2;
      popped = true;
    } else if (TRAILING_GRAMMAR.has(trimTrailingPunctuation(last))) {
      words.pop();
      popped = true;
    }
  }

  let name = trimTrailingPunctuation(words.join(' ')).trim();

  if (!name || name.length > MAX_NAME_LENGTH) return null;
  // A name with no letter at all is never a client.
  if (!/[a-z]/i.test(name)) return null;
  // Every remaining word is grammar — there was no name in the capture.
  if (name.split(' ').every((w) => GRAMMAR_ONLY.has(w.toLowerCase()))) return null;
  return name;
}
