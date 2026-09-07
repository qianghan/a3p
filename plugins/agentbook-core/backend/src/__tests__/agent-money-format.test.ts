/**
 * Money the agent says back to the user must look like money.
 *
 * `fmtCurrency` rendered $1,240 as "$1240.00" — a format no accounting surface
 * uses. The canonical eval caught it three times over: "paid AWS $1240",
 * "invoice TechCorp $5000" and "got $7500 payment from BigCo" all had replies
 * missing the separated amount. A wrong-LOOKING number invites the user to
 * doubt a correct one, and these strings are the only confirmation they get
 * that we understood the figure before it lands in their books.
 *
 * There are two formatters on purpose — server.ts owns the reply path, and
 * agent-brain.ts cannot import it (that module builds the Express app at import
 * time and the brain must run without it). Two copies of one rule is exactly
 * what rots, so this file asserts BOTH, structurally, in one place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fmtCurrency } from '../server';
import { join } from 'node:path';

const SERVER = readFileSync(join(__dirname, '../server.ts'), 'utf8');
const BRAIN = readFileSync(join(__dirname, '../agent-brain.ts'), 'utf8');

/** The formatting the product should use everywhere money is shown. */
function expectedFormat(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

describe('agent money formatting', () => {
  it('renders four- and seven-figure amounts with separators', () => {
    // The three amounts the eval actually exercises, plus one larger.
    expect(expectedFormat(124_000)).toBe('1,240.00');
    expect(expectedFormat(500_000)).toBe('5,000.00');
    expect(expectedFormat(750_000)).toBe('7,500.00');
    expect(expectedFormat(123_456_789)).toBe('1,234,567.89');
  });

  it('leaves sub-thousand amounts alone', () => {
    expect(expectedFormat(4_200)).toBe('42.00');
    expect(expectedFormat(0)).toBe('0.00');
  });

  it('fmtCurrency separates thousands (server.ts reply path)', () => {
    // Was a source scan for the string 'toLocaleString'. That asserted an
    // implementation, so it failed the moment the same rule was delegated to
    // Intl — while the regression it guards, a bare toFixed with no
    // separator, would have passed if the literal happened to be present.
    // Call it instead.
    expect(fmtCurrency(124_000, 'USD', 'en-US')).toBe('$1,240.00');
    expect(fmtCurrency(123_456_789, 'USD', 'en-US')).toBe('$1,234,567.89');
    expect(fmtCurrency(4_200, 'USD', 'en-US')).toBe('$42.00');
  });

  it('formats the digits for the tenant locale, not for en-US', () => {
    // A fr-CA tenant writes 1 234,56. This read 1,234.56 for every tenant on
    // earth because the locale was hardcoded.
    expect(fmtCurrency(123_456, 'CAD', 'fr-CA')).toMatch(/1\s234,56/);
    expect(fmtCurrency(123_456, 'CNY', 'zh-CN')).toBe('¥1,234.56');
  });

  it('keeps a non-USD amount from reading as a bare dollar sign', () => {
    // Intl renders CAD as "$" for an en-CA reader. A Canadian tenant's
    // savings shown as "$56.50" is the ambiguity deduction-message-format
    // was written to prevent, so the prefix is kept deliberately.
    expect(fmtCurrency(5_650, 'CAD', 'en-CA')).toBe('CA$56.50');
    expect(fmtCurrency(1_250, 'AUD', 'en-AU')).toBe('A$12.50');
    expect(fmtCurrency(123_456, 'USD', 'en-US')).toBe('$1,234.56');
  });

  it('falls back to the currency home market when no locale is known', () => {
    // Call sites that genuinely hold only a per-record currency must not
    // silently get en-US.
    expect(fmtCurrency(5_650, 'CAD')).toBe('CA$56.50');
    expect(fmtCurrency(5_650)).toBe('$56.50');
  });

  it('the confirm-prompt formatter separates thousands (agent-brain.ts)', () => {
    const fn = BRAIN.slice(BRAIN.indexOf('function fmtConfirmMoney'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('toLocaleString');
  });

  it('the record-payment confirm prompt does not hand-roll its own format', () => {
    // This string is what the user approves before money moves.
    const line = BRAIN.split('\n').find((l) => l.includes('Record payment${'));
    expect(line, 'record-payment confirm prompt not found').toBeTruthy();
    expect(line).toContain('fmtConfirmMoney');
    expect(line).not.toContain('toFixed(2)');
  });

  it('create-invoice confirms the client AND the amount', () => {
    // create-invoice had no success branch at all, so the most important write
    // in the product answered without naming either. create-estimate — newer,
    // used far less — always did. Assert the branch exists and echoes both.
    const i = SERVER.indexOf("selectedSkill.name === 'create-invoice' && data");
    expect(i, 'create-invoice has no success reply branch').toBeGreaterThan(-1);
    const branch = SERVER.slice(i, i + 700);
    expect(branch).toContain('fmtCurrency');
    expect(branch).toMatch(/clientName|client\?\.name/);
  });
});
