import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mealDeductionNote } from '@/lib/agentbook-deduction-copy';

/**
 * Found by probing production, 2026-07-31. Maya is a Canadian consultant
 * (jurisdiction ca, currency CAD). Her deduction suggestions read:
 *
 *   "Looks like a client meeting — these are typically deductible (50% in the US)."
 *
 * The rule hardcoded the US authority. The percentage happens to be 50 in both
 * countries, which is exactly why nobody caught it: the number was right and
 * the authority was wrong. A user who notices that has no reason to trust
 * anything else the advisor says about their taxes.
 *
 * The file's own header claims the engine is jurisdiction-aware "without the
 * rule code branching" — true for tax CATEGORIES, which come from the tenant's
 * AbAccount.taxCategory, but the human-readable prose was never covered by it.
 */
describe('the meal-deduction note names the tenant own tax authority', () => {
  it('cites the CRA for a Canadian tenant', () => {
    const note = mealDeductionNote('ca');
    expect(note).toContain('CRA');
    expect(note).not.toContain('IRS');
    expect(note).not.toMatch(/\bin the US\b/);
  });

  it('cites the IRS for a US tenant', () => {
    const note = mealDeductionNote('us');
    expect(note).toContain('IRS');
    expect(note).not.toContain('CRA');
  });

  it('states the same 50% limit for both — the rate was never the bug', () => {
    expect(mealDeductionNote('us')).toContain('50%');
    expect(mealDeductionNote('ca')).toContain('50%');
  });
});

describe('no rule hardcodes a jurisdiction in its user-facing prose', () => {
  // A unit test on the helper cannot fail when the next rule inlines
  // "in the US" in its own message string, and this engine writes straight to
  // the daily digest and the Telegram dd_explain callback.
  const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
  const src = readFileSync(join(ROOT, 'apps/web-next/src/lib/agentbook-deduction-rules.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('no message template mentions a single country or authority inline', () => {
    // Only mealDeductionNote may name an authority, and it branches.
    const messageLines = code
      .split('\n')
      .filter((l) => /message:|`.*deductible.*`|`.*claim.*`/i.test(l));
    for (const line of messageLines) {
      expect(line, `hardcoded jurisdiction in: ${line.trim()}`).not.toMatch(
        /\b(in the US|IRS|CRA|ATO|HMRC|Schedule C|T2125)\b/,
      );
    }
  });
});
