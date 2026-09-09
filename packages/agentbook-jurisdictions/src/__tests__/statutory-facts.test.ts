import { describe, expect, it } from 'vitest';
import { statutoryFactLines } from '../statutory-facts.js';

/**
 * The consultation reviewer rejects any rate not present in the grounding
 * facts, telling the model "Rates must come from the pack, never from the
 * model." Nothing ever put a pack rate into the grounding facts, so the set
 * of known numbers held the tenant's own money and no statutory figure at
 * all — and every percentage the model produced was flagged and deleted,
 * including the correct ones.
 *
 * These prove the pack actually yields the rates, and — the part that matters
 * — that they are READ from the pack rather than retyped here.
 */

const text = (j: string, r?: string) => {
  const f = statutoryFactLines(j, r, 2025);
  return [...f.lines, ...f.amountLines].join('\n');
};

describe('the packs yield their own rates', () => {
  it.each(['us', 'ca', 'au', 'uk'])('%s produces fact lines', (j) => {
    expect(statutoryFactLines(j, null, 2025).lines.length).toBeGreaterThan(0);
  });

  it('gives Australia its 10% GST', () => {
    expect(text('au')).toMatch(/10%/);
  });

  it('gives Ontario its 13% HST and Quebec its GST/QST split', () => {
    expect(text('ca', 'ON')).toMatch(/13%/);
    // "ON HST rate in ON" — the pack's own name already carries the region.
    expect(text('ca', 'ON')).not.toMatch(/in ON/);
    const qc = text('ca', 'QC');
    expect(qc).toMatch(/5%/);
    expect(qc).toMatch(/9\.975%/);
  });

  it('names the Quebec contribution plans, not the federal ones', () => {
    // Reads through the calculator, so this also proves the region reaches it.
    expect(text('ca', 'QC')).toMatch(/QPP/);
    expect(text('ca', 'QC')).toMatch(/QPIP/);
    expect(text('ca', 'ON')).toMatch(/CPP/);
    expect(text('ca', 'ON')).not.toMatch(/QPIP/);
  });

  it('carries the AU mileage cap, so the model can state it', () => {
    const au = text('au');
    expect(au).toMatch(/cents per km/);
    expect(au).toMatch(/5,000 km/);
  });

  it('carries the A$75,000 GST threshold as a money amount, not a rate', () => {
    const f = statutoryFactLines('au', null, 2025);
    expect(f.amountLines.join('\n')).toMatch(/A\$75,000/);
    expect(f.lines.join('\n')).not.toMatch(/75,000/);
  });
});

describe('the lines read as something a person could be told', () => {
  // These go into the model's context and come back out in a user-facing
  // answer, so a wrong word here is a wrong word said to the user.
  it('does not call UK income tax "federal"', () => {
    expect(text('uk')).not.toMatch(/federal/i);
    expect(text('us')).toMatch(/federal/i);
  });

  it('quotes the UK mileage rate in pence, not cents', () => {
    // The pack's own tierDescription says "45p/mile"; a line reading
    // "45 cents per mile (First 10000 miles at 45p/mile)" contradicts itself
    // inside one sentence.
    expect(text('uk')).toMatch(/45 pence per mile/);
    expect(text('uk')).not.toMatch(/cents/);
  });

  it('names contributions the way a person would, not by their code key', () => {
    expect(text('au')).toMatch(/Medicare Levy/);
    expect(text('au')).not.toMatch(/medicare_levy/);
    expect(text('uk')).toMatch(/Class 2 National Insurance/);
    expect(text('uk')).not.toMatch(/class_[24]/);
  });
});

describe('what is deliberately NOT included', () => {
  it('omits bracket boundaries, which are money about the user', () => {
    // Admitting a large round threshold to the money-grounded set would let a
    // draft assert "$190,000" about someone's income and pass review.
    const us = statutoryFactLines('us', null, 2025);
    const joined = [...us.lines, ...us.amountLines].join('\n');
    expect(joined).toMatch(/marginal rates/);
    // Any money-shaped figure at all in the bracket line, not just a
    // comma-grouped one — the first attempt at this assertion only matched
    // `$11,925`-style spans, so a mutation emitting `$NaN` slipped past it
    // and the guard was never actually exercised.
    const bracketLine = us.lines.find((l) => /marginal rates/.test(l))!;
    expect(bracketLine).not.toMatch(/[$£€]/);
    expect(joined).not.toMatch(/\$\s?\d{2,3},\d{3}/);
  });

  it('returns nothing for an unknown jurisdiction rather than guessing', () => {
    expect(statutoryFactLines('zz', null, 2025).lines).toEqual([]);
  });

  it('never throws, whatever it is handed', () => {
    for (const j of [null, undefined, '', 'us', '  AU  ']) {
      expect(() => statutoryFactLines(j, null, 2025)).not.toThrow();
    }
    expect(() => statutoryFactLines('us', null, 1900)).not.toThrow();
  });
});

describe('the rates are read from the packs, not restated here', () => {
  it('matches what the sales-tax engine itself returns', async () => {
    // A second copy of a rate is how this product previously shipped a figure
    // that had silently gone stale. If someone changes the AU GST rate in the
    // pack, this line has to follow it without anyone editing this module.
    const { auPack } = await import('../au/index.js');
    const packRate = auPack.salesTax.getRates('standard')[0].rate;
    expect(text('au')).toContain(`${+(packRate * 100).toFixed(4)}%`);
  });

  it('matches the mileage rate the expense route would apply', async () => {
    const { auMileageRate } = await import('../au/mileage-rate.js');
    const m = auMileageRate.getRate(2025, 0);
    expect(text('au')).toContain(`${Math.round(m.rate * 100)} cents per km`);
  });
});
