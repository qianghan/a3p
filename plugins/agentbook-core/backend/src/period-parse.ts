/**
 * Turning a question into a date window — the single implementation.
 *
 * There were two copies of this logic (the prod advisor route and this
 * package's Express server) and both used the same shortcut for month
 * detection:
 *
 *     q.includes(name) || q.includes(name.slice(0, 3))
 *
 * An unanchored 3-character substring match against ordinary English is a
 * silent wrong-answer machine. "Walmart" contains "mar", "the doctor"
 * contains "oct", "marketing" contains "mar", "innovation" contains "nov",
 * "separate" contains "sep". So "how much did I spend at the doctor?" was
 * answered for October — which, asked in July, is a window that has not
 * happened yet, so the reply was "no expenses found" to a user holding a
 * stack of doctor bills. Nothing in the answer said which period it used, so
 * there was no way for the user to tell a wrong window from a wrong total.
 *
 * Everything here is therefore built around two rules:
 *   1. match months as WORDS (and require date context for "may", which is
 *      also the most common modal verb in English)
 *   2. always return a human-readable `label`, because the caller is expected
 *      to state the period in the answer
 */

export interface ParsedPeriod {
  startDate: Date;
  endDate: Date;
  /** Human-readable window, e.g. "June 2026" — quoted back to the user. */
  label: string;
  source: 'month' | 'relative' | 'default';
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Word-anchored month patterns. Full name and abbreviation are alternatives
 * inside one \b-delimited group, so "jan" matches "in Jan" but not "January"
 * (the following "u" defeats the trailing \b) and "mar" never matches
 * "Walmart".
 */
const MONTH_PATTERNS: RegExp[] = [
  /\b(?:january|jan)\b/i,
  /\b(?:february|feb)\b/i,
  /\b(?:march|mar)\b/i,
  /\b(?:april|apr)\b/i,
  /\bmay\b/i, // guarded separately — see MAY_NEEDS_CONTEXT
  /\b(?:june|jun)\b/i,
  /\b(?:july|jul)\b/i,
  /\b(?:august|aug)\b/i,
  /\b(?:september|sept|sep)\b/i,
  /\b(?:october|oct)\b/i,
  /\b(?:november|nov)\b/i,
  /\b(?:december|dec)\b/i,
];

/**
 * "may" is a month and also the most common modal verb in the language
 * ("what may I deduct?"), plus a name prefix we ship a test persona for
 * ("Maya"). Only count it as a month when it sits in date position: after a
 * preposition, or before a day/year number.
 */
const MAY_NEEDS_CONTEXT = [
  /\b(?:in|for|during|since|from|of|through|thru|until|till|by|after|before)\s+may\b/i,
  /\bmay\s+(?:\d{1,2}|20\d\d)\b/i,
  /\bmay'?s\b/i,
];

function monthIsMentioned(q: string, monthIndex: number): boolean {
  if (monthIndex === 4) return MAY_NEEDS_CONTEXT.some((re) => re.test(q));
  return MONTH_PATTERNS[monthIndex].test(q);
}

const RELATIVE_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /\blast month\b/i, kind: 'last-month' },
  { re: /\bthis month\b/i, kind: 'this-month' },
  { re: /\blast quarter\b/i, kind: 'last-quarter' },
  { re: /\bthis quarter\b/i, kind: 'this-quarter' },
  { re: /\blast year\b/i, kind: 'last-year' },
  { re: /\bthis year\b/i, kind: 'this-year' },
  { re: /\byear to date\b|\bytd\b/i, kind: 'ytd' },
  { re: /\blast (\d{1,2}) (?:days|weeks|months)\b/i, kind: 'trailing' },
];

function endOfMonth(year: number, monthIndex: number): Date {
  return new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
}

function shortRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
}

/**
 * The literal period phrase the user typed, or null. Used to carry a period
 * from one turn to the next without re-deriving dates — the phrase goes back
 * through this same parser on the next turn.
 */
export function extractPeriodPhrase(question: string): string | null {
  if (!question) return null;
  for (const { re } of RELATIVE_PATTERNS) {
    const m = question.match(re);
    if (m) return m[0];
  }
  for (let i = 0; i < 12; i++) {
    if (monthIsMentioned(question, i)) {
      // Return the canonical month name rather than the user's abbreviation
      // so the appended phrase reads naturally in the rewritten question.
      // Keep an explicit year if the user gave one.
      const yearMatch = question.match(/\b(20\d\d)\b/);
      return yearMatch ? `${MONTH_NAMES[i]} ${yearMatch[1]}` : MONTH_NAMES[i];
    }
  }
  const bareYear = question.match(/\bin (20\d\d)\b/i);
  if (bareYear) return bareYear[0];
  return null;
}

export function parsePeriodFromQuestion(question: string, now: Date = new Date()): ParsedPeriod {
  const q = (question ?? '').toLowerCase();
  const thisYear = now.getFullYear();

  const explicitYear = q.match(/\b(20\d\d)\b/);
  const saysLastYear = /\blast year\b/i.test(q);

  const mentioned: number[] = [];
  for (let i = 0; i < 12; i++) if (monthIsMentioned(q, i)) mentioned.push(i);

  if (mentioned.length > 0) {
    const minMonth = Math.min(...mentioned);
    const maxMonth = Math.max(...mentioned);
    let year = explicitYear ? Number(explicitYear[1]) : thisYear;
    if (!explicitYear && saysLastYear) year = thisYear - 1;
    // A single month still ahead of us cannot be what an expense question
    // means. Without this, "what did I spend in December?" asked in July
    // returns an empty future window and the answer is a confident $0.
    if (!explicitYear && !saysLastYear && minMonth === maxMonth && minMonth > now.getMonth()) {
      year = thisYear - 1;
    }
    const startDate = new Date(year, minMonth, 1);
    const endDate = endOfMonth(year, maxMonth);
    const label =
      minMonth === maxMonth
        ? `${MONTH_NAMES[minMonth]} ${year}`
        : `${MONTH_NAMES[minMonth].slice(0, 3)}–${MONTH_NAMES[maxMonth].slice(0, 3)} ${year}`;
    return { startDate, endDate, label, source: 'month' };
  }

  for (const { re, kind } of RELATIVE_PATTERNS) {
    const m = q.match(re);
    if (!m) continue;
    switch (kind) {
      case 'last-month': {
        const start = new Date(thisYear, now.getMonth() - 1, 1);
        const end = endOfMonth(start.getFullYear(), start.getMonth());
        return {
          startDate: start,
          endDate: end,
          label: `last month (${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()})`,
          source: 'relative',
        };
      }
      case 'this-month': {
        const start = new Date(thisYear, now.getMonth(), 1);
        return {
          startDate: start,
          endDate: now,
          label: `this month (${MONTH_NAMES[now.getMonth()]} ${thisYear}, to date)`,
          source: 'relative',
        };
      }
      case 'last-quarter':
      case 'this-quarter': {
        const start = new Date(now);
        start.setMonth(start.getMonth() - 3);
        return {
          startDate: start,
          endDate: now,
          label: `the last 3 months (${shortRange(start, now)})`,
          source: 'relative',
        };
      }
      case 'last-year': {
        return {
          startDate: new Date(thisYear - 1, 0, 1),
          endDate: new Date(thisYear - 1, 11, 31, 23, 59, 59, 999),
          label: `last year (${thisYear - 1})`,
          source: 'relative',
        };
      }
      case 'this-year':
      case 'ytd': {
        return {
          startDate: new Date(thisYear, 0, 1),
          endDate: now,
          label: `year to date (${shortRange(new Date(thisYear, 0, 1), now)})`,
          source: 'relative',
        };
      }
      case 'trailing': {
        const n = Number(m[1]);
        const unit = /weeks/i.test(m[0]) ? 7 : /months/i.test(m[0]) ? 30 : 1;
        const start = new Date(now);
        start.setDate(start.getDate() - n * unit);
        return {
          startDate: start,
          endDate: now,
          label: `${m[0]} (${shortRange(start, now)})`,
          source: 'relative',
        };
      }
    }
  }

  if (explicitYear) {
    const year = Number(explicitYear[1]);
    if (year < thisYear) {
      return {
        startDate: new Date(year, 0, 1),
        endDate: new Date(year, 11, 31, 23, 59, 59, 999),
        label: String(year),
        source: 'relative',
      };
    }
  }

  const start = new Date(thisYear, 0, 1);
  return {
    startDate: start,
    endDate: now,
    label: `year to date (${shortRange(start, now)})`,
    source: 'default',
  };
}

/** Follow-ups that mean "same question, different subject". */
const CONTINUATION = /^(?:and|also|what about|how about|and what about)\b/i;
const MAX_CONTINUATION_WORDS = 6;

/**
 * Give a bare follow-up the period of the question it follows.
 *
 * "how much did I spend on travel last month?" → "and meals?" was answered
 * year-to-date, so the two numbers the user was comparing covered different
 * windows, and neither reply said which. Rewriting the text (rather than
 * passing a period parameter) keeps this working for every channel and every
 * downstream consumer, since classification and parameter extraction both
 * read the same string.
 *
 * `conversation` is newest-first — see pairTurns in agent-brain.ts.
 */
export function carryForwardPeriod(
  text: string,
  conversation: Array<{ question?: string | null }>,
): string {
  if (!text || conversation.length === 0) return text;
  const trimmed = text.trim();
  if (!CONTINUATION.test(trimmed)) return text;
  if (trimmed.split(/\s+/).length > MAX_CONTINUATION_WORDS) return text;
  // Never override a period the follow-up states for itself.
  if (extractPeriodPhrase(trimmed)) return text;

  for (const turn of conversation) {
    const phrase = extractPeriodPhrase(turn.question ?? '');
    if (!phrase) continue;
    const trailing = trimmed.match(/[?.!]+$/)?.[0] ?? '';
    const base = trailing ? trimmed.slice(0, -trailing.length).trim() : trimmed;
    // A bare month name needs a preposition to read as English — the rewritten
    // text is also what the LLM classifier and the advisor prompt see.
    const isMonthName = MONTH_NAMES.some((n) => phrase.startsWith(n));
    return `${base} ${isMonthName ? 'in ' : ''}${phrase}${trailing}`;
  }
  return text;
}
