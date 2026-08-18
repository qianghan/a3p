import { describe, it, expect } from 'vitest';
import { registerTaxReviewPack, getTaxReviewPack, listSupportedJurisdictions } from '../tax-review-loader.js';
import type { TaxReviewPack } from '../interfaces.js';

describe('tax-review-loader', () => {
  it('CA, US, AU are all registered by default', () => {
    expect(listSupportedJurisdictions().sort()).toEqual(['au', 'ca', 'us']);
  });

  it('getTaxReviewPack throws a descriptive error for an unregistered jurisdiction', () => {
    expect(() => getTaxReviewPack('uk')).toThrow('No TaxReviewPack for jurisdiction: uk');
  });

  it('registerTaxReviewPack allows adding a new jurisdiction without touching existing ones', () => {
    const fakePack: TaxReviewPack = {
      jurisdiction: 'nz',
      criticalFields: () => [],
      summaryPrompt: () => '',
      parseSummary: () => ({ summaryText: '' }),
      explainFieldPrompt: () => '',
      parseFieldExplanation: () => ({ explanation: '' }),
    };
    registerTaxReviewPack(fakePack);
    expect(getTaxReviewPack('nz')).toBe(fakePack);
    expect(listSupportedJurisdictions()).toContain('ca'); // unaffected
  });
});
