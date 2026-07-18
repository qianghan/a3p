import { describe, it, expect } from 'vitest';
import { evaluateFormula } from '../tax-forms.js';

// NOTE on calling convention: `PROVINCIAL_TAX(income_field, province_field)`
// resolves BOTH arguments as field-name lookups into the `fields` object
// (see tax-forms.ts: `fields[provMatch[2].trim()] || 'ON'`) — it does NOT
// accept a literal province code as its second argument. The real T1 form
// formula is `PROVINCIAL_TAX(taxable_income_26000, province_territory)`,
// where `province_territory` is itself a field whose resolved value (e.g.
// 'QC') is looked up from `fields['province_territory']`. So these tests
// pass `{ income, province: <code> }` and reference the `province` field
// name in the formula string, mirroring real usage. (An earlier draft of
// this test embedded the literal code directly as the formula's second
// token, e.g. `PROVINCIAL_TAX(income, QC)` with no `QC` key in `fields` —
// that construction always silently resolves `fields['QC']` to `undefined`
// and falls back to 'ON', so it can never distinguish provinces at all;
// confirmed by running it against the pre-fix file, where 'QC', 'ON', and
// even 'ZZ' all produced the identical ON figure.)
describe('PROVINCIAL_TAX formula — provincial bracket completeness (CA-GATE remediation)', () => {
  const provincialTax = (income: number, province: string) =>
    evaluateFormula('PROVINCIAL_TAX(income, province)', { income, province });

  it('produces a distinct, real (non-Ontario-fallback) tax figure for every previously-uncovered province/territory at $80,000 taxable income', () => {
    // Before this fix, all 10 of these provinces/territories fell through
    // `PROVINCIAL_BRACKETS[province] || PROVINCIAL_BRACKETS['ON']`, silently
    // computing Ontario's tax. $80,000 = 8,000,000 cents.
    const onResult = provincialTax(8_000_000, 'ON');

    const expected: Record<string, number> = {
      // Computed by hand against calcProgressiveTax's algorithm (cumulative
      // marginal, `if (incomeCents <= prev) break`) and each province's real
      // 2025 brackets at $80,000 (8,000,000 cents), then independently
      // cross-checked by running the exact same algorithm in a standalone
      // script:
      // QC: 5325500*0.14 + (8000000-5325500)*0.19 = 745570 + 508155 = 1253725
      QC: 1253725,
      // MB: 4700000*0.108 + (8000000-4700000)*0.1275 = 507600 + 420750 = 928350
      MB: 928350,
      // SK: 5346300*0.105 + (8000000-5346300)*0.125 = 561361.5 + 331712.5 = 893074
      SK: 893074,
      // NB: 5130600*0.094 + (8000000-5130600)*0.14 = 482276.4 + 401716 = 883992.4 -> round 883992
      NB: 883992,
      // NS: 3099500*0.0879 + (6199100-3099500)*0.1495 + (8000000-6199100)*0.1667
      //   = 272446.05 + 463390.2 + 300210.03 = 1036046.28 -> round 1036046
      NS: 1036046,
      // PE: 3332800*0.095 + (6465600-3332800)*0.1347 + (8000000-6465600)*0.166
      //   = 316616 + 421988.16 + 254710.4 = 993314.56 -> round 993315
      PE: 993315,
      // NL: 4419200*0.087 + (8000000-4419200)*0.145 = 384470.4 + 519216 = 903686.4 -> round 903686
      NL: 903686,
      // YT: 5737500*0.064 + (8000000-5737500)*0.09 = 367200 + 203625 = 570825
      YT: 570825,
      // NT: 5196400*0.059 + (8000000-5196400)*0.086 = 306587.6 + 241109.6 = 547697.2 -> round 547697
      NT: 547697,
      // NU: 5470700*0.04 + (8000000-5470700)*0.07 = 218828 + 177051 = 395879
      NU: 395879,
    };

    for (const [province, expectedCents] of Object.entries(expected)) {
      const result = provincialTax(8_000_000, province);
      expect(result).toBe(expectedCents);
      expect(result).not.toBe(onResult); // must differ from the old silent-ON-fallback behavior
    }
  });

  it('ON, BC, AB (already-covered provinces) are unaffected by this change', () => {
    const onBefore = provincialTax(8_000_000, 'ON');
    const bcBefore = provincialTax(8_000_000, 'BC');
    const abBefore = provincialTax(8_000_000, 'AB');
    // These 3 should be untouched by this PR — pin their current (existing,
    // unchanged) bracket values so any accidental edit to ON/BC/AB is
    // caught. Computed by hand against the CURRENT (pre-this-PR) tables:
    // ON: 5114200*0.0505 + (8000000-5114200)*0.0915 = 258267.1 + 264050.7 = 522317.8 -> 522318
    // BC: 4707400*0.0506 + (8000000-4707400)*0.077 = 238194.44 + 253530.2 = 491724.64 -> 491725
    // AB: 8000000*0.10 = 800000 (all of $80,000 falls in AB's first bracket, which extends to $142,122)
    expect(onBefore).toBe(522318);
    expect(bcBefore).toBe(491725);
    expect(abBefore).toBe(800000);
  });

  it('an unrecognized province code still falls back to ON (documented, intentional fallback for genuinely invalid input)', () => {
    const result = provincialTax(8_000_000, 'ZZ');
    const onResult = provincialTax(8_000_000, 'ON');
    expect(result).toBe(onResult);
  });

  it('an entirely missing province field also falls back to ON (same defensive default)', () => {
    const result = evaluateFormula('PROVINCIAL_TAX(income, province)', { income: 8_000_000 });
    const onResult = provincialTax(8_000_000, 'ON');
    expect(result).toBe(onResult);
  });
});

describe('PROGRESSIVE_TAX formula — federal and provincial bracket keys', () => {
  // Unlike PROVINCIAL_TAX, PROGRESSIVE_TAX's second argument is used
  // directly as a PROVINCIAL_BRACKETS key (or the literal 'ca_federal'
  // sentinel) — it is not resolved through `fields`. See tax-forms.ts:
  // `ptMatch[2] === 'ca_federal' ? CA_FEDERAL_BRACKETS : PROVINCIAL_BRACKETS[ptMatch[2]] || CA_FEDERAL_BRACKETS`.
  it('computes federal tax via the ca_federal bracket key', () => {
    // CA federal 2025: 5590700*0.15 + (8000000-5590700)*0.205
    //   = 838605 + 493906.5 = 1332511.5 -> round 1332512
    const result = evaluateFormula('PROGRESSIVE_TAX(income, ca_federal)', { income: 8_000_000 });
    expect(result).toBe(1_332_512);
  });

  it('computes a newly-added province directly via its bracket key (no ON/federal fallback needed once the table entry exists)', () => {
    // QC via PROGRESSIVE_TAX should match the same figure as via PROVINCIAL_TAX,
    // since both ultimately read PROVINCIAL_BRACKETS['QC'] into the same
    // calcProgressiveTax function.
    const result = evaluateFormula('PROGRESSIVE_TAX(income, QC)', { income: 8_000_000 });
    expect(result).toBe(1_253_725);
  });

  it('an unrecognized bracket key falls back to CA_FEDERAL_BRACKETS (different fallback than PROVINCIAL_TAX, by design)', () => {
    const federalResult = evaluateFormula('PROGRESSIVE_TAX(income, ca_federal)', { income: 8_000_000 });
    const unknownResult = evaluateFormula('PROGRESSIVE_TAX(income, ZZ)', { income: 8_000_000 });
    expect(unknownResult).toBe(federalResult);
  });
});
