/**
 * Architectural invariant: ONE parser turns a question into a date window.
 *
 * There were two copies, and both detected month names the same wrong way:
 *
 *     q.includes(name) || q.includes(name.slice(0, 3))
 *
 * An unanchored 3-character substring test against ordinary English silently
 * re-periodises the answer. "Walmart" contains "mar", "the doctor" contains
 * "oct", "marketing" contains "mar", "innovation" contains "nov". Asked in
 * July, "how much did I spend at the doctor?" resolved to October — a window
 * that has not happened — so the reply was "no expenses found" to a user with
 * a drawer full of doctor bills.
 *
 * Why a structural test rather than only unit tests on the parser: the maths
 * was never wrong. Each copy was individually plausible, and the defect was
 * that a second copy existed at all — the same shape as the four divergent tax
 * rate tables (#380–#385) and the four Telegram category strings. Unit tests
 * on the surviving parser cannot fail when someone adds a third copy next to
 * it, and CI is the only place that notices.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// apps/web-next/src/__tests__/architecture -> repo root
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Source with comments removed.
 *
 * Guards that grep for a bug's shape must not match the comment EXPLAINING
 * that shape. This one did: the note above the period stamp quotes the
 * `if (!answer.includes(periodLabel))` it replaced, so the guard failed on the
 * fixed code. The same trap in the other direction cost a false PASS earlier —
 * a mutation check that hit a comment instead of the live line.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PARSER = 'plugins/agentbook-core/backend/src/period-parse.ts';

/** Every surface that answers a "how much did I spend" question. */
const CONSUMERS = [
  'plugins/agentbook-core/backend/src/server.ts',
  'apps/web-next/src/app/api/v1/agentbook-expense/advisor/ask/route.ts',
];

describe('one canonical period parser', () => {
  it('the shared parser exists', () => {
    expect(existsSync(join(ROOT, PARSER))).toBe(true);
  });

  it('no surface matches month names by unanchored substring', () => {
    // The exact shape of the shipped bug. `name.slice(0, 3)` fed to
    // String.includes is never correct for month detection.
    const offenders: string[] = [];
    for (const file of CONSUMERS) {
      const src = read(file);
      if (/includes\(\s*\w*[Nn]ame\w*\.slice\(0,\s*3\)\s*\)/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('every expense-query surface imports the shared parser instead of rolling its own', () => {
    for (const file of CONSUMERS) {
      const src = read(file);
      expect(src, `${file} must use parsePeriodFromQuestion`).toMatch(/parsePeriodFromQuestion/);
    }
  });

  it('no surface keeps its own month-name array for period detection', () => {
    // A month-name array next to a date window is how the second copy started.
    // Formatting a month for DISPLAY is fine — that is why this asserts on the
    // combination of an array and a window variable in the same file.
    for (const file of CONSUMERS) {
      const src = read(file);
      const hasMonthArray = /const monthNames\s*=\s*\[/.test(src);
      const buildsWindow = /mentionedMonths|minMonth|maxMonth/.test(src);
      expect(hasMonthArray && buildsWindow, `${file} builds its own month window`).toBe(false);
    }
  });

  it('"may" is guarded — it is the most common modal verb in English', () => {
    // Without a date-context guard, "what expenses may I deduct?" and the
    // seeded persona "Maya" both resolve to May.
    const src = read(PARSER);
    expect(src).toMatch(/MAY_NEEDS_CONTEXT/);
  });
});

describe('the period is always stated back to the user', () => {
  // A wrong window is only survivable if the user can SEE it. Both of these
  // reply paths compute a total; both must name the period alongside it, or a
  // misparse is indistinguishable from a wrong total.
  const STAMPED = [
    'plugins/agentbook-core/backend/src/server.ts',
    'apps/web-next/src/app/api/v1/agentbook-expense/advisor/ask/route.ts',
  ];

  it('both reply paths stamp the period they used', () => {
    for (const file of STAMPED) {
      expect(read(file), `${file} must stamp _Period: …_`).toMatch(/_Period: \$\{periodLabel\}\._/);
    }
  });

  it('the stamp is UNCONDITIONAL — not skipped when the model names the window itself', () => {
    // It shipped guarded by `if (!answer.includes(periodLabel))`, to avoid
    // restating a period the LLM had already worked into its prose. That turned
    // the guarantee into "the period appears somewhere, phrased however the
    // model chose" — which nothing downstream can assert, and which failed the
    // canonical eval (`required: ['Period:']`) on a turn that was in fact
    // correct. A deterministic stamp that is sometimes redundant is worth more
    // than a tidy one that cannot be verified.
    for (const file of STAMPED) {
      // readCode, not read — the comment above the stamp quotes the very
      // pattern this forbids, and matching it there is a false failure.
      expect(readCode(file), `${file} must not gate the period stamp on answer.includes`).not.toMatch(
        /if\s*\(\s*!\s*answer\.includes\(\s*periodLabel\s*\)\s*\)/,
      );
    }
  });
});
