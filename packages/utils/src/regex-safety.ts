/**
 * Is this regex, supplied by somebody else, safe to keep and run?
 *
 * The danger is not the compile — that is cheap and always succeeds for any
 * syntactically valid pattern. It is that a stored pattern gets run against
 * every message a user sends, and a pattern like `(a+)+$` takes exponential
 * time on input that ALMOST matches. One registration is then a permanent
 * denial of service on the chat path, triggered by ordinary traffic.
 *
 * This repo has met catastrophic backtracking twice already (#489, #521) and
 * fixed it both times by rewriting the offending pattern. This is the other
 * half: refusing to accept a bad one in the first place.
 *
 * TWO CHECKS, AND THE SECOND IS THE ONE THAT WORKS
 *
 * A static scan for nested quantifiers catches the textbook shapes and misses
 * everything else, because the property is about the automaton, not the
 * source text. So the load-bearing check is empirical: run the pattern
 * against inputs that ALMOST match, at three lengths, and look at how the
 * time grows. Linear growth is fine at any speed. Doubling per character is
 * the signature, and it is unmistakable well before the input gets long
 * enough for the probe itself to hang.
 *
 * The probe strings deliberately END IN A CHARACTER THAT CANNOT MATCH. A
 * succeeding match returns on the first path the engine tries and proves
 * nothing at all; the blow-up only happens when the engine has to exhaust
 * every alternative before it can fail.
 */

export interface RegexSafetyVerdict {
  safe: boolean;
  /** Fixed, user-facing phrase. Present when `safe` is false. */
  reason?: string;
}

/** Longer than any legitimate trigger pattern, short enough to bound a probe. */
export const MAX_PATTERN_LENGTH = 300;

/** Input lengths for the growth probe. Short on purpose — see below. */
const PROBE_LENGTHS = [16, 20, 24];

/**
 * Wall-clock ceiling for one probe. A JS regex cannot be interrupted once
 * started, so this is not a timeout — it is the line past which we call the
 * pattern unsafe when the probe eventually does return. The probe inputs are
 * kept short so the worst case is bounded in the low seconds, not minutes.
 */
const PROBE_BUDGET_MS = 200;

/** Growth factor between successive probe lengths that counts as explosive. */
const EXPLOSIVE_GROWTH = 8;

/**
 * A suffix the pattern is unlikely to accept, so the match must fail. Chosen
 * after the filler, which is picked to be one the pattern probably does
 * accept — together they make the engine explore and then backtrack.
 */
const SENTINEL = ' !';

/** A plausible filler for this pattern: a literal it mentions, else 'a'. */
function fillerFor(source: string): string {
  const literal = source.match(/[A-Za-z0-9]/);
  return literal ? literal[0] : 'a';
}

export function assessUserRegex(source: string): RegexSafetyVerdict {
  if (typeof source !== 'string' || source.length === 0) {
    return { safe: false, reason: 'pattern must be a non-empty string' };
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `pattern is longer than ${MAX_PATTERN_LENGTH} characters` };
  }

  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    return { safe: false, reason: 'pattern is not a valid regular expression' };
  }

  const filler = fillerFor(source);
  const timings: number[] = [];

  for (const length of PROBE_LENGTHS) {
    const probe = filler.repeat(length) + SENTINEL;
    const started = Date.now();
    try {
      // Result discarded: what is being measured is how long failing took.
      re.test(probe);
    } catch {
      return { safe: false, reason: 'pattern failed to run' };
    }
    const elapsed = Date.now() - started;
    timings.push(elapsed);
    if (elapsed > PROBE_BUDGET_MS) {
      return { safe: false, reason: 'pattern backtracks catastrophically on non-matching input' };
    }
  }

  // Growth check. Sub-millisecond timings are noise, so a pattern only fails
  // this when it is already slow AND getting rapidly slower — the shape of
  // exponential blow-up rather than of an unlucky scheduler.
  for (let i = 1; i < timings.length; i++) {
    if (timings[i - 1] >= 2 && timings[i] > timings[i - 1] * EXPLOSIVE_GROWTH) {
      return { safe: false, reason: 'pattern backtracks catastrophically on non-matching input' };
    }
  }

  return { safe: true };
}
