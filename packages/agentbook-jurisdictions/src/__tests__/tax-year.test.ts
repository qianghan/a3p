import { describe, it, expect } from 'vitest';
import { MODELED_TAX_YEAR, taxYearDisclosure } from '../tax-year.js';

describe('taxYearDisclosure', () => {
  it('reports no note when the requested year matches the modeled tables', () => {
    const d = taxYearDisclosure(MODELED_TAX_YEAR);
    expect(d.tablesYear).toBe(MODELED_TAX_YEAR);
    expect(d.usesRequestedYearTables).toBe(true);
    expect(d.note).toBeNull();
  });

  it('discloses the mismatch (honestly) when the requested year differs', () => {
    const d = taxYearDisclosure(MODELED_TAX_YEAR + 1);
    expect(d.tablesYear).toBe(MODELED_TAX_YEAR);
    expect(d.usesRequestedYearTables).toBe(false);
    expect(d.note).toMatch(new RegExp(`${MODELED_TAX_YEAR} tax tables`));
    expect(d.note).toMatch(new RegExp(`${MODELED_TAX_YEAR + 1}`));
    expect(d.note).toMatch(/verify against current-year rates/i);
  });
});
