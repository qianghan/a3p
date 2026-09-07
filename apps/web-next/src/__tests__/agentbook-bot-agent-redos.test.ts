// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// The module graph pulls in `server-only`, whose browser build throws on
// import. Stub it rather than reconfiguring the shared vitest environment.
vi.mock('server-only', () => ({}));

import { classifyIntentWithRegex, type BotContext } from '@/lib/agentbook-bot-agent';

/**
 * `classifyIntentWithRegex` runs ~90 regexes over untrusted chat text on the
 * unauthenticated bot path. Several lead with `\s+`, or pair a `[\w\s]` class
 * with a following `\s+`. Both shapes are quadratic on a run of whitespace:
 * the match can start at every position in the run and consume the rest from
 * each. Three were hot enough to matter (the per-diem shape at line ~700, its
 * date-tail strip, and the amount scan), together ~5s of CPU on a 30k-space
 * message and ~23s on 60k.
 *
 * The fix collapses whitespace runs once, before any pattern sees the text.
 * These inputs deliberately FAIL to match the date/cue patterns -- a matching
 * input returns early and stays fast even on the vulnerable code.
 */

const ctx: BotContext = { tenantId: 't1', active: null, categories: [] };

describe('regex classifier — ReDoS', () => {
  // The fixed classifier runs these in ~1ms; the vulnerable one took hundreds
  // of ms to tens of seconds. A 250ms bound cannot be met by the quadratic
  // path at these sizes, and leaves ample headroom for a loaded CI runner.
  const BUDGET_MS = 250;

  // Whitespace runs are the hostile shape: a flood of word characters is
  // linear, so every case here interleaves a real token with a long run.
  const hostile = (n: number): [string, string][] => [
    // Per-diem: the run must be INTERIOR, since the strict pattern trims the
    // captured city hint and leading spaces never reach the cleanup regexes.
    // Trailing 'x' is a word char that neither the month nor the relative-cue
    // pattern can match, so every start position is tried and rejected.
    ['per-diem', `per-diem NYC${' '.repeat(n)}x`],
    ['mileage', `drove 40 miles to NYC${' '.repeat(n)}x`],
    ['expense', `coffee${' '.repeat(n)}x`],
    ['mixed whitespace', `per-diem NYC${' \t\n'.repeat(Math.floor(n / 3))}x`],
  ];

  for (const n of [10_000, 30_000, 60_000]) {
    for (const [label, text] of hostile(n)) {
      it(`classifies a ${label} message with a ${n}-char whitespace run in under ${BUDGET_MS}ms`, () => {
        const started = Date.now();
        classifyIntentWithRegex(text, ctx);
        expect(Date.now() - started).toBeLessThan(BUDGET_MS);
      });
    }
  }

  it('normalising whitespace does not change how real messages classify', () => {
    const cases: [string, string][] = [
      ['per-diem 3 days NYC May 5-7', 'NYC'],
      ['per-diem NYC Mar 5', 'NYC'],
      ['per-diem San Francisco this week', 'San Francisco'],
      ['per-diem 2 days Denver next month', 'Denver'],
      // Multiple spaces before the month. An earlier candidate fix bounded
      // the leading `\s+` to `\s{1,4}` and silently stopped stripping here.
      ['per-diem Boston     Mar 5', 'Boston'],
    ];
    for (const [text, city] of cases) {
      const out = classifyIntentWithRegex(text, ctx);
      expect(out.intent, text).toBe('record_per_diem');
      expect(out.slots.cityHint, text).toBe(city);
    }
  });

  it('keeps line breaks in multi-line messages', () => {
    const out = classifyIntentWithRegex('per-diem NYC\n\n\nMay 5', ctx);
    expect(out.intent).toBe('record_per_diem');
    expect(out.slots.cityHint).toBe('NYC');
  });
});
