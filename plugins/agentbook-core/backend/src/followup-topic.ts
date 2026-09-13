/**
 * Carry the previous question's topic into a bare elaboration request.
 *
 * Observed in production:
 *
 *     "What is my cash balance?"  -> query-finance, answered with the balance
 *     "Give me more details"      -> query-finance, replied "More details about what?"
 *
 * The LLM classifier DOES see recent conversation, so it routes the follow-up
 * to the right skill. The skill layer does not: query-finance's HTTP route
 * builds its own LLM answer from `question` alone, and "Give me more details"
 * carries no topic. On another run the classifier picks general-question,
 * which gets the thread and answers well — so the user's experience depended
 * on classifier variance.
 *
 * The fix mirrors carryForwardPeriod in period-parse.ts: rewrite the TEXT
 * before classification, so the topic rides along in the one string every
 * downstream consumer reads (classification, parameter extraction, the
 * advisor prompt) on every channel.
 *
 * `conversation` is newest-first — see pairTurns in agent-brain.ts.
 */

/**
 * A message that asks for elaboration and nothing else — it names no subject
 * of its own, so it is only answerable in the context of the turn before it.
 *
 * Anchored at both ends and flat (no nested quantifiers): there is exactly one
 * start position, so a long non-matching input fails in linear time.
 */
const BARE_ELABORATION = new RegExp(
  '^(?:' +
    'more(?: details| info(?:rmation)?)?' +
    '|(?:give|tell|show) me (?:some |a bit )?more(?: details| info(?:rmation)?)?(?: about (?:that|this|it))?' +
    '|(?:more )?details?(?: please)?' +
    '|elaborate' +
    '|explain(?: that| this| more)?' +
    '|go on' +
    '|why' +
    '|how so' +
    '|how come' +
    '|break (?:that|it) down' +
    '|what about (?:that|this|it)' +
    '|can you (?:elaborate|explain)' +
  ')[.!?]*$',
  'i',
);

const MAX_ELABORATION_WORDS = 6;
/** A prior turn this short ("ok", "why?") cannot be the topic either. */
const MIN_TOPIC_WORDS = 3;

/**
 * Strip trailing `?`, `.` and `!` with a scan.
 *
 * Not `/[?.!]+$/`: an unanchored repeated character class matched against
 * end-of-string is quadratic, and chat text is uncontrolled input (CodeQL
 * flags it as js/polynomial-redos). This is linear.
 */
function stripTrailingPunctuation(s: string): string {
  let cut = s.length;
  while (cut > 0 && (s[cut - 1] === '?' || s[cut - 1] === '.' || s[cut - 1] === '!')) {
    cut--;
  }
  return s.slice(0, cut).trimEnd();
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function carryForwardTopic(
  text: string,
  conversation: Array<{ question?: string | null }>,
): string {
  if (!text || conversation.length === 0) return text;
  const trimmed = text.trim();
  if (wordCount(trimmed) > MAX_ELABORATION_WORDS) return text;
  if (!BARE_ELABORATION.test(trimmed)) return text;

  for (const turn of conversation) {
    const prev = (turn.question ?? '').trim();
    if (!prev) continue;
    // The turn before may itself have been a bare "more details" — that one
    // has no topic to lend, so keep walking back to the real question.
    if (wordCount(prev) < MIN_TOPIC_WORDS) continue;
    if (BARE_ELABORATION.test(prev)) continue;
    return `${stripTrailingPunctuation(trimmed)} — regarding: "${prev}"`;
  }
  return text;
}
