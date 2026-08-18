import { describe, it, expect, vi, beforeEach } from 'vitest';

const filingFindFirst = vi.fn();
const reviewUpsert = vi.fn();
const tenantConfigFindFirst = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a) },
    abTaxFilingReview: { upsert: (...a: any[]) => reviewUpsert(...a) },
    abTenantConfig: { findFirst: (...a: any[]) => tenantConfigFindFirst(...a) },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  tenantConfigFindFirst.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
  reviewUpsert.mockResolvedValue({ id: 'r1' });
});

describe('startReview', () => {
  it('computes real totals via the CA bracket calculator, calls the LLM, verifies the summary is grounded, and persists the review row', async () => {
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
      forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, total_tax_43500: 1145500 }, T2125: {} },
    });
    const callGemini = vi.fn().mockResolvedValue('{"summaryText": "Your taxable income is $73,000 and your estimated tax payable is $11,455. Anything you\'d like to change before submitting?"}');

    const { startReview } = await import('../tax-review-agent.js');
    const result = await startReview('t1', 2025, callGemini);

    expect(result.message).toContain('$73,000');
    expect(result.criticalFields.length).toBeGreaterThan(0); // additive field for the web review tab (Task 15)
    expect(result.computedTotals.taxableIncomeCents).toBe(7300000); // additive field for the web review tab
    // Tax payable is the T1 total-payable line as the forms themselves
    // computed it (federal + provincial + CPP), not a re-derived subtotal —
    // so the $11,455 the LLM narrated above verifies as grounded and is
    // shown, rather than being replaced by the deterministic fallback.
    expect(result.computedTotals.taxPayableCents).toBe(1145500);
    expect(result.message).toContain('$11,455');
    expect(reviewUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_taxYear: { tenantId: 't1', taxYear: 2025 } },
    }));
  });

  it('prepends the language directive naming the tenant\'s configured language, and calls the LLM with a French instruction for a fr-CA tenant', async () => {
    tenantConfigFindFirst.mockResolvedValue({ jurisdiction: 'ca', region: 'ON', locale: 'fr-CA' });
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
      forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, total_tax_43500: 1145500 }, T2125: {} },
    });
    const callGemini = vi.fn().mockResolvedValue('{"summaryText": "Votre revenu imposable est de 73 000,00 $."}');

    const { startReview } = await import('../tax-review-agent.js');
    await startReview('t1', 2025, callGemini);

    const [systemPrompt] = callGemini.mock.calls[0];
    expect(systemPrompt).toContain('LANGUAGE: Reply in the same language');
    expect(systemPrompt).toContain('French');
  });

  it('falls back to a deterministic, numbers-only message if the LLM invents an ungrounded figure', async () => {
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
      forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, total_tax_43500: 1145500 }, T2125: {} },
    });
    // $99,999 does not match any real computed total — must be caught, not shown.
    const callGemini = vi.fn().mockResolvedValue('{"summaryText": "Your tax payable is $99,999."}');

    const { startReview } = await import('../tax-review-agent.js');
    const result = await startReview('t1', 2025, callGemini);

    expect(result.message).not.toContain('99,999');
    expect(result.message).toContain('$'); // still shows the real numbers, just not narrated by the LLM
  });

  it('throws a clear error if no filing exists for this tenant/year', async () => {
    filingFindFirst.mockResolvedValue(null);
    const { startReview } = await import('../tax-review-agent.js');
    await expect(startReview('t1', 2025, vi.fn())).rejects.toThrow('No filing found');
  });
});
