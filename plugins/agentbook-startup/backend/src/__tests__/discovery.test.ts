import { describe, it, expect, beforeAll } from 'vitest';
import { loadBuiltInPacks } from '@agentbook/jurisdictions';
import { computeRecommendations, type CatalogEntry } from '../discovery.js';

beforeAll(() => {
  loadBuiltInPacks();
});

const CATALOG: CatalogEntry[] = [
  { programCode: 'us_rd_credit_41', name: 'Federal R&D Tax Credit (IRC §41)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765' },
  { programCode: 'us_qsbs_tracking', name: 'QSBS Eligibility Tracking (IRC §1202)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf' },
  { programCode: 'us_de_franchise_optimization', name: 'Delaware Franchise Tax Optimization', authority: 'Delaware Division of Corporations', sourceUrl: 'https://corp.delaware.gov/frtaxcalc/' },
];

describe('computeRecommendations', () => {
  it('marks the R&D credit as qualified with a dollar range for meaningful R&D spend, using catalog display fields', () => {
    const result = computeRecommendations('us', { annualRdSpendCents: 40_000_000 }, CATALOG);
    const rd = result.programs.find((p) => p.programCode === 'us_rd_credit_41');
    expect(rd?.status).toBe('qualified');
    expect(rd?.name).toBe('Federal R&D Tax Credit (IRC §41)');
    expect(rd?.sourceUrl).toBe('https://www.irs.gov/forms-pubs/about-form-6765');
    expect(rd?.estValueLowCents).toBe(4_000_000);
    expect(rd?.estValueHighCents).toBe(8_000_000);
  });

  it('does not list Delaware franchise optimization for a non-C-corp', () => {
    const result = computeRecommendations('us', { companyType: 'llc' }, CATALOG);
    expect(result.programs.map((p) => p.programCode)).not.toContain('us_de_franchise_optimization');
  });

  it('lists all 3 catalog programs for a fully-qualifying Delaware C-corp with R&D spend', () => {
    const result = computeRecommendations('us', { companyType: 'c_corp', annualRdSpendCents: 40_000_000, incorporatedAt: new Date('2026-01-01') }, CATALOG);
    expect(result.programs.map((p) => p.programCode).sort()).toEqual([
      'us_de_franchise_optimization', 'us_qsbs_tracking', 'us_rd_credit_41',
    ]);
  });

  it('returns an empty list with an explanatory message for a jurisdiction with no TaxBenefitProvider yet', () => {
    const result = computeRecommendations('ca', {}, []);
    expect(result.programs).toHaveLength(0);
    expect(result.message).toMatch(/not yet available/i);
  });

  it('returns an empty list with an explanatory message for a completely unknown jurisdiction', () => {
    const result = computeRecommendations('de', {}, []);
    expect(result.programs).toHaveLength(0);
    expect(result.message).toMatch(/not yet available/i);
  });

  it('never returns a silent empty state — a supported jurisdiction with zero matching programs still gets a message (story A6)', () => {
    // Empty profile: no R&D spend, no companyType — roughlyApplies() is false for all 3 US programs.
    const result = computeRecommendations('us', {}, CATALOG);
    expect(result.programs).toHaveLength(0);
    expect(result.message).toBeDefined();
    expect(result.message).not.toMatch(/not yet available/i); // distinct from the unsupported-jurisdiction message
  });
});
