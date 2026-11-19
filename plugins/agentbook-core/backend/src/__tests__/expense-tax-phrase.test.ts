/**
 * PR 2b.8 — chat record-expense understands "$110 incl GST" / "$100 + GST" /
 * "$113 with HST" / "incl. QST" and says the tax split in the reply.
 */
import { describe, it, expect } from 'vitest';
import { parseTaxPhrase, applyTaxPhrase, taxSplitLine } from '../expense-tax-phrase';
import { replyT } from '../reply-locale';

describe('parseTaxPhrase', () => {
  it.each([
    ['spent $110 incl GST at Officeworks', { taxCode: 'GST', taxInclusive: true }],
    ['paid $110 including GST for paper', { taxCode: 'GST', taxInclusive: true }],
    ['$110 inc. GST printer ink', { taxCode: 'GST', taxInclusive: true }],
    ['bought a chair $100 + GST', { taxCode: 'GST', taxInclusive: false }],
    ['$100 plus GST software', { taxCode: 'GST', taxInclusive: false }],
    ['$100 ex GST', { taxCode: 'GST', taxInclusive: false }],
    ['$100 excl. HST', { taxCode: 'HST', taxInclusive: false }],
    ['spent $113 with HST on a desk', { taxCode: 'HST', taxInclusive: true }],
    ['paid $114.98 incl. QST lunch', { taxCode: 'GST_QST', taxInclusive: true }],
    ['$114.98 incl GST and QST', { taxCode: 'GST_QST', taxInclusive: true }],
    ['$112 incl GST+PST', { taxCode: 'GST_PST', taxInclusive: true }],
  ])('%s', (text, want) => {
    expect(parseTaxPhrase(text)).toEqual(want);
  });

  it.each(['spent $40 on lunch', 'paid $50 to the GSTR accountant', 'bought hosting $20'])(
    'no tax phrase in %s',
    (text) => expect(parseTaxPhrase(text)).toBeNull(),
  );
});

describe('applyTaxPhrase', () => {
  it('adds taxCode + taxInclusive to the extracted params, keeping the gross amount', () => {
    const p: Record<string, unknown> = { amountCents: 11000, vendor: 'Officeworks' };
    applyTaxPhrase(p, 'spent $110 incl GST at Officeworks');
    expect(p).toEqual({ amountCents: 11000, vendor: 'Officeworks', taxCode: 'GST', taxInclusive: true, taxCodeIsHint: true });
  });
  it('never overrides a code the extractor already set, and is a no-op without a phrase', () => {
    const p: Record<string, unknown> = { amountCents: 11000, taxCode: 'CAP' };
    applyTaxPhrase(p, '$110 incl GST');
    expect(p.taxCode).toBe('CAP');
    const q: Record<string, unknown> = { amountCents: 4000 };
    applyTaxPhrase(q, 'spent $40 on lunch');
    expect(q).toEqual({ amountCents: 4000 });
  });
});

describe('taxSplitLine — localized reply', () => {
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  it('states the claimable split in each locale', () => {
    const data = { taxCode: 'GST', recoverableTaxCents: 1000, amountCents: 11000 };
    expect(taxSplitLine(data, replyT({ locale: 'en-US' }), fmt)).toBe('GST $10.00 claimable');
    expect(taxSplitLine(data, replyT({ locale: 'fr-CA' }), fmt)).toBe('GST $10.00 récupérable');
    expect(taxSplitLine(data, replyT({ locale: 'zh-CN' }), fmt)).toBe('GST $10.00 可抵扣');
  });
  it('labels combined codes with a slash', () => {
    expect(taxSplitLine({ taxCode: 'GST_QST', recoverableTaxCents: 1498 }, replyT({ locale: 'en-US' }), fmt)).toBe('GST/QST $14.98 claimable');
  });
  it('says nothing when there is no recoverable tax', () => {
    expect(taxSplitLine({ taxCode: 'FRE', recoverableTaxCents: 0 }, replyT({ locale: 'en-US' }), fmt)).toBe('');
    expect(taxSplitLine({ amountCents: 4000 }, replyT({ locale: 'en-US' }), fmt)).toBe('');
  });
});
