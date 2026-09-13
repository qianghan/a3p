import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, shouldAppendBreakdown } from '../agentbook-telegram-markdown';

const PROD = `From January 1, 2026, to September 13, 2026, your total expenses are **42 014,79 CA$** across 173 transactions.

Your top spending categories are:
*   **Uncategorized**: 15 541,71 CA$
*   **Software & Subscriptions**: 12 997,88 CA$
- Travel: 8 953,95 CA$

### Vendors
_Period: year to date (Jan 1 – Sep 13, 2026)._`;

describe('mdToTelegramHtml', () => {
  const html = mdToTelegramHtml(PROD);
  it('bold and escaping', () => { expect(html).toContain('<b>42 014,79 CA$</b>'); expect(html).toContain('Software &amp; Subscriptions'); });
  it('list bullets become •, never a literal asterisk or dash', () => {
    expect(html).toContain('• <b>Uncategorized</b>: 15 541,71 CA$');
    expect(html).toContain('• Travel: 8 953,95 CA$');
    expect(html).not.toMatch(/^\*\s{2,}/m);
  });
  it('_italic_ and ### headings', () => {
    expect(html).toContain('<i>Period: year to date (Jan 1 – Sep 13, 2026).</i>');
    expect(html).toContain('<b>Vendors</b>');
    expect(html).not.toContain('###');
  });
  it('does not italicise snake_case identifiers', () => {
    expect(mdToTelegramHtml('key telegram_pending_x set')).toBe('key telegram_pending_x set');
  });
  it('inline code', () => { expect(mdToTelegramHtml('run `review`')).toBe('run <code>review</code>'); });
});

describe('shouldAppendBreakdown', () => {
  const chart = { type: 'pie', data: [{ name: 'Uncategorized', value: 1554171 }, { name: 'Software & Subscriptions', value: 1299788 }, { name: 'Travel', value: 895395 }, { name: 'Insurance', value: 250000 }] };
  it('skips when the answer already names most of the series', () => { expect(shouldAppendBreakdown(PROD, chart)).toBe(false); });
  it('appends when the answer is a bare total', () => { expect(shouldAppendBreakdown('You spent $42,014.79 this year.', chart)).toBe(true); });
  it('never appends without data', () => { expect(shouldAppendBreakdown('x', null)).toBe(false); expect(shouldAppendBreakdown('x', { data: [] })).toBe(false); });
});
