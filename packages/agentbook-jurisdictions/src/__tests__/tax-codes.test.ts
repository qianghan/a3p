import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeLineTax,
  listTaxCodes,
  defaultTaxCode,
  TaxCodeError,
  type LineTaxInput,
} from '../tax-codes.js';

const REG = { gstRegistered: true, qstRegistered: true };
const UNREG = { gstRegistered: false, qstRegistered: false };

function t(input: Partial<LineTaxInput> & Pick<LineTaxInput, 'jurisdiction' | 'taxCode' | 'amountCents'>) {
  return computeLineTax({ inclusive: true, registration: REG, ...input });
}

describe('AU tax codes', () => {
  it('GST inclusive $110.00 -> $10.00 tax, $100.00 net, fully recoverable', () => {
    const r = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 11000 });
    expect(r).toMatchObject({ grossCents: 11000, netCents: 10000, taxCents: 1000, recoverableTaxCents: 1000, nonRecoverableTaxCents: 0 });
    expect(r.components).toEqual([{ type: 'GST', rate: 0.1, cents: 1000, recoverableCents: 1000 }]);
  });
  it('GST inclusive $0.99 -> $0.09', () => {
    const r = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 99 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([90, 9, 9]);
  });
  it('GST inclusive back-out is round(gross/11) on the tax, not net-first: $0.16 -> $0.01', () => {
    const r = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 16 });
    expect([r.netCents, r.taxCents]).toEqual([15, 1]);
  });
  it('GST exclusive 10%: $100.00 net -> $10.00 tax, $110.00 gross', () => {
    const r = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 10000, inclusive: false });
    expect([r.grossCents, r.netCents, r.taxCents]).toEqual([11000, 10000, 1000]);
    const odd = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 995, inclusive: false });
    expect([odd.grossCents, odd.taxCents]).toEqual([1095, 100]); // 99.5 rounds half away
  });
  it('CAP recovers like GST (capital purchase)', () => {
    const r = t({ jurisdiction: 'au', taxCode: 'CAP', amountCents: 220000 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([200000, 20000, 20000]);
  });
  it.each(['FRE', 'INP', 'NTR'])('%s carries zero tax and zero credit', (code) => {
    const r = t({ jurisdiction: 'au', taxCode: code, amountCents: 11000 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([11000, 0, 0]);
  });
  it('unregistered (false) and unknown (null) -> recoverable 0, tax still split out', () => {
    for (const gstRegistered of [false, null]) {
      const r = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 11000, registration: { gstRegistered } });
      expect([r.taxCents, r.recoverableTaxCents, r.nonRecoverableTaxCents]).toEqual([1000, 0, 1000]);
    }
  });
  it('refund symmetry: -$110.00 -> -$10.00, -$0.99 -> -$0.09', () => {
    const r = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: -11000 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([-10000, -1000, -1000]);
    const s = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: -99 });
    expect([s.netCents, s.taxCents]).toEqual([-90, -9]);
    const e = t({ jurisdiction: 'au', taxCode: 'GST', amountCents: -995, inclusive: false });
    expect([e.grossCents, e.taxCents]).toEqual([-1095, -100]);
  });
  it('lists codes, defaults to GST, rejects unknown code', () => {
    expect(listTaxCodes('au').map((c) => c.code)).toEqual(['GST', 'CAP', 'FRE', 'INP', 'NTR']);
    expect(defaultTaxCode('au')).toBe('GST');
    expect(() => t({ jurisdiction: 'au', taxCode: 'HST', amountCents: 100 })).toThrow(TaxCodeError);
  });
});

describe('CA tax codes', () => {
  it('HST ON inclusive $113.00 -> $13.00 HST, recoverable when registered', () => {
    const r = t({ jurisdiction: 'ca', region: 'ON', taxCode: 'HST', amountCents: 11300 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([10000, 1300, 1300]);
  });
  it('GST AB exclusive $100.00 -> $5.00', () => {
    const r = t({ jurisdiction: 'ca', region: 'AB', taxCode: 'GST', amountCents: 10000, inclusive: false });
    expect([r.grossCents, r.taxCents, r.recoverableTaxCents]).toEqual([10500, 500, 500]);
  });
  it('GST_PST BC inclusive $112.00: GST 500 recoverable, PST 700 never', () => {
    const r = t({ jurisdiction: 'ca', region: 'BC', taxCode: 'GST_PST', amountCents: 11200 });
    expect(r.components).toEqual([
      { type: 'GST', rate: 0.05, cents: 500, recoverableCents: 500 },
      { type: 'PST', rate: 0.07, cents: 700, recoverableCents: 0 },
    ]);
    expect([r.netCents, r.taxCents, r.recoverableTaxCents, r.nonRecoverableTaxCents]).toEqual([10000, 1200, 500, 700]);
  });
  it('per-component rounding: BC exclusive $0.99 -> GST 5 + PST 7 (not round(0.99*0.12)=12 split)', () => {
    const r = t({ jurisdiction: 'ca', region: 'BC', taxCode: 'GST_PST', amountCents: 99, inclusive: false });
    expect(r.components.map((c) => c.cents)).toEqual([5, 7]);
    const s = t({ jurisdiction: 'ca', region: 'BC', taxCode: 'GST_PST', amountCents: 10, inclusive: false });
    expect(s.components.map((c) => c.cents)).toEqual([1, 1]); // 0.5 and 0.7, each rounded
    expect(s.taxCents).toBe(2);
  });
  it('GST_QST QC exclusive $100.00: GST 500 + QST 998; QST credited only when qstRegistered', () => {
    const on = t({ jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents: 10000, inclusive: false });
    expect(on.components).toEqual([
      { type: 'GST', rate: 0.05, cents: 500, recoverableCents: 500 },
      { type: 'QST', rate: 0.09975, cents: 998, recoverableCents: 998 },
    ]);
    expect([on.grossCents, on.recoverableTaxCents]).toEqual([11498, 1498]);
    for (const qstRegistered of [false, null, undefined]) {
      const off = t({ jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents: 10000, inclusive: false, registration: { gstRegistered: true, qstRegistered } });
      expect([off.taxCents, off.recoverableTaxCents]).toEqual([1498, 500]);
    }
  });
  it('GST_QST QC inclusive $114.98 -> net $100.00', () => {
    const r = t({ jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents: 11498 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([10000, 1498, 1498]);
  });
  it('meals fraction 0.5: ON $113.00 meal -> recoverable $6.50', () => {
    const r = t({ jurisdiction: 'ca', region: 'ON', taxCode: 'HST', amountCents: 11300, isMeal: true });
    expect([r.taxCents, r.recoverableTaxCents, r.nonRecoverableTaxCents]).toEqual([1300, 650, 650]);
    const q = t({ jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents: 10000, inclusive: false, isMeal: true });
    expect(q.components.map((c) => c.recoverableCents)).toEqual([250, 499]); // 998*0.5
  });
  it('unregistered -> recoverable 0 even with qstRegistered', () => {
    const r = t({ jurisdiction: 'ca', region: 'ON', taxCode: 'HST', amountCents: 11300, registration: UNREG });
    expect([r.taxCents, r.recoverableTaxCents]).toEqual([1300, 0]);
    const q = t({ jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents: 11498, registration: { gstRegistered: false, qstRegistered: true } });
    expect(q.recoverableTaxCents).toBe(998); // QST registration is a separate flag
  });
  it.each(['ZERO', 'EXEMPT', 'OUT_OF_SCOPE'])('%s is zero tax', (code) => {
    const r = t({ jurisdiction: 'ca', region: 'ON', taxCode: code, amountCents: 11300 });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([11300, 0, 0]);
  });
  it('refund symmetry ON -$113.00 meal', () => {
    const r = t({ jurisdiction: 'ca', region: 'ON', taxCode: 'HST', amountCents: -11300, isMeal: true });
    expect([r.netCents, r.taxCents, r.recoverableTaxCents]).toEqual([-10000, -1300, -650]);
    const b = t({ jurisdiction: 'ca', region: 'BC', taxCode: 'GST_PST', amountCents: -10, inclusive: false });
    expect(b.components.map((c) => c.cents)).toEqual([-1, -1]);
  });
  it('code/province mismatch is rejected (HST in AB, GST_QST in ON)', () => {
    expect(() => t({ jurisdiction: 'ca', region: 'AB', taxCode: 'HST', amountCents: 100 })).toThrow(TaxCodeError);
    expect(() => t({ jurisdiction: 'ca', region: 'ON', taxCode: 'GST_QST', amountCents: 100 })).toThrow(TaxCodeError);
  });
  it('defaults by province and lists all codes', () => {
    expect(defaultTaxCode('ca', 'ON')).toBe('HST');
    expect(defaultTaxCode('ca', 'BC')).toBe('GST_PST');
    expect(defaultTaxCode('ca', 'QC')).toBe('GST_QST');
    expect(defaultTaxCode('ca', 'AB')).toBe('GST');
    expect(defaultTaxCode('ca')).toBe('GST');
    expect(listTaxCodes('ca').map((c) => c.code)).toEqual(['GST', 'HST', 'GST_PST', 'GST_QST', 'ZERO', 'EXEMPT', 'OUT_OF_SCOPE']);
    expect(listTaxCodes('ca', 'ON').map((c) => c.code)).toEqual(['HST', 'ZERO', 'EXEMPT', 'OUT_OF_SCOPE']);
  });
});

describe('US tax codes', () => {
  it('SALES_TAX is never recoverable, even when "registered"', () => {
    const r = t({ jurisdiction: 'us', region: 'CA', taxCode: 'SALES_TAX', amountCents: 10000, inclusive: false });
    expect([r.grossCents, r.taxCents, r.recoverableTaxCents, r.nonRecoverableTaxCents]).toEqual([10725, 725, 0, 725]);
    const i = t({ jurisdiction: 'us', region: 'CA', taxCode: 'SALES_TAX', amountCents: 10725 });
    expect([i.netCents, i.taxCents, i.recoverableTaxCents]).toEqual([10000, 725, 0]);
    const n = t({ jurisdiction: 'us', region: 'CA', taxCode: 'SALES_TAX', amountCents: -10725 });
    expect([n.netCents, n.taxCents]).toEqual([-10000, -725]);
  });
  it('NONE and no-tax states carry zero; default NONE', () => {
    expect(t({ jurisdiction: 'us', region: 'CA', taxCode: 'NONE', amountCents: 10000 }).taxCents).toBe(0);
    expect(t({ jurisdiction: 'us', region: 'OR', taxCode: 'SALES_TAX', amountCents: 10000 }).taxCents).toBe(0);
    expect(defaultTaxCode('us', 'CA')).toBe('NONE');
    expect(listTaxCodes('us').map((c) => c.code)).toEqual(['SALES_TAX', 'NONE']);
  });
});

describe('invariants', () => {
  it('net + tax === gross and recoverable + nonRecoverable === tax', () => {
    for (const amountCents of [1, 7, 99, 1234, 99999, -1, -99, -1234]) {
      for (const inclusive of [true, false]) {
        const r = t({ jurisdiction: 'ca', region: 'QC', taxCode: 'GST_QST', amountCents, inclusive, isMeal: true });
        expect(r.netCents + r.taxCents).toBe(r.grossCents);
        expect(r.recoverableTaxCents + r.nonRecoverableTaxCents).toBe(r.taxCents);
        expect(r.components.reduce((s, c) => s + c.cents, 0)).toBe(r.taxCents);
        expect(Number.isInteger(r.netCents) && Number.isInteger(r.recoverableTaxCents)).toBe(true);
      }
    }
  });
  it('rejects non-integer cents and unsupported jurisdiction', () => {
    expect(() => t({ jurisdiction: 'au', taxCode: 'GST', amountCents: 10.5 })).toThrow(TaxCodeError);
    expect(() => t({ jurisdiction: 'uk' as never, taxCode: 'GST', amountCents: 100 })).toThrow(TaxCodeError);
  });
});

describe('no duplicated rate literals', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = ['../tax-codes.ts', '../tax-codes-core.ts', '../au/tax-codes.ts', '../ca/tax-codes.ts', '../us/tax-codes.ts'];
  it.each(files)('%s has no sales-tax rate literals (rates come from sales-tax.ts providers)', (f) => {
    const src = readFileSync(join(here, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/\b0?\.(1|10|05|07|06|13|15|09975|0725)\b/);
    expect(src).not.toMatch(/\/\s*11\b|\b1\.1\b/);
  });
});
