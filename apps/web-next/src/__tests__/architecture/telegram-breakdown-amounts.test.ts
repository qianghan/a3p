import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Telegram "📊 Breakdown" block renders whatever series the skill put in
 * `chartData`. It decides per row whether a value is money — worth running
 * through the tenant's currency formatter — or a plain count to print as-is,
 * and it decided that with a bare `item.value > 100`.
 *
 * That held only because every series that existed was non-negative: expense
 * totals, invoice amounts, counts. `simulate-scenario` is the first to emit a
 * signed series — the twelve-month cash projection, which goes negative
 * exactly in the months the user most needs to read. A negative amount failed
 * the `> 100` test, skipped `fmtAmount`, and printed as raw cents:
 *
 *     • M5: -1200000
 *
 * The reader has no way to know that is −$12,000.00 rather than −1.2 million.
 * A magnitude test, not a sign test, is what the branch always meant.
 *
 * `formatResponse` is route-private (the webhook module opens grammy, Prisma
 * and the agent brain at load), so this is a source-reading guard in the style
 * of the sibling telegram invariants.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const WEBHOOK = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';

/** Comments stripped — a guard must match code, not prose about code. */
const code = readFileSync(join(ROOT, WEBHOOK), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the Telegram breakdown decides "is this money?" by magnitude', () => {
  it('is not vacuous — the breakdown loop is still here', () => {
    expect(code).toContain('fmtAmount(item.value)');
  });

  it('tests the absolute value, so a negative amount is still formatted', () => {
    expect(code).toContain('Math.abs(item.value) > 100');
  });

  it('no longer compares the signed value against the money threshold', () => {
    // `item.value > 100` is the exact expression that sent −$12,000.00 to the
    // user as "-1200000".
    expect(code).not.toMatch(/[^.)]\bitem\.value\s*>\s*100/);
  });

  it('still only formats numbers', () => {
    // A string label ("Q3") must not reach a currency formatter.
    expect(code).toContain("typeof item.value === 'number'");
  });
});
