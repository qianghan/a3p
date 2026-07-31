/**
 * Cleaning a client name pulled out of free text.
 *
 * The chat extractors capture "whatever sits between the verb and the amount":
 *
 *     text.match(/invoice\s+(.+?)\s+\$/i)
 *
 * which on the most natural phrasings keeps the grammar as part of the name:
 *
 *     "invoice Acme for $5000"      -> "Acme for"
 *     "invoice to Acme for $5000"   -> "to Acme for"
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
 */

/**
 * Prepositions the capture group swallows on the way in. Only stripped from
 * the FRONT, where no company name legitimately begins.
 */
const LEADING_GRAMMAR = /^(?:to|for|from)\s+/i;

/**
 * Connectors that sit between the client and the rest of the sentence, and
 * time words that trail a payment. Only stripped from the END, one at a time,
 * so "invoice Acme for on $500" degrades gracefully.
 */
const TRAILING_GRAMMAR = [
  /\s+(?:for|on|re|regarding|about|covering|due|dated|per|of|with|at)$/i,
  /\s+(?:yesterday|today|tomorrow|tonight)$/i,
  /\s+(?:last|this|next)\s+(?:week|month|quarter|year)$/i,
  /\s+(?:invoice|payment|estimate|quote|proposal)$/i,
];

/** Longest name we will accept; anything past this is a run-on sentence. */
const MAX_NAME_LENGTH = 60;

/**
 * A capture that is nothing BUT grammar. The leading/trailing strippers need a
 * neighbouring word to bite ("to Acme"), so a bare "to" survives them and would
 * otherwise be stored as a client.
 */
const GRAMMAR_ONLY = new Set([
  'to', 'for', 'from', 'on', 'at', 'of', 'with', 're', 'the', 'a', 'an', 'and',
  'invoice', 'payment', 'estimate', 'quote', 'proposal', 'client', 'customer',
]);

/**
 * Returns a cleaned client name, or null when nothing usable is left.
 *
 * Callers MUST treat null as "no client name found" rather than falling back to
 * the raw capture — a junk name is worse than no name, because it silently
 * creates a duplicate client instead of asking the user who they meant.
 */
export function cleanClientName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw.replace(/\s+/g, ' ').trim();

  name = name.replace(LEADING_GRAMMAR, '').trim();

  // Repeat: "Acme for last week" needs two passes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of TRAILING_GRAMMAR) {
      const next = name.replace(re, '').trim();
      if (next !== name) {
        name = next;
        changed = true;
      }
    }
  }

  // Trailing punctuation the sentence left behind.
  name = name.replace(/[,;:.!?]+$/, '').trim();

  if (!name || name.length > MAX_NAME_LENGTH) return null;
  // A name with no letter at all is never a client.
  if (!/[a-z]/i.test(name)) return null;
  // Every remaining word is grammar — there was no name in the capture.
  if (name.split(' ').every((w) => GRAMMAR_ONLY.has(w.toLowerCase()))) return null;
  return name;
}
