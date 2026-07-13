import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = {
  abTaxQuestionnaireSession: { findUnique: vi.fn(async () => null as any) },
  abPastTaxFiling: { findUnique: vi.fn(async () => null as any) },
};
vi.mock('../db/client.js', () => ({ db: dbMock }));

const packMock = {
  jurisdiction: 'us',
  extractDeltasPrompt: vi.fn(() => 'DELTA PROMPT'),
  parseDeltas: vi.fn((parsed: unknown) => parsed as any),
  clientLetterPrompt: vi.fn(() => 'LETTER PROMPT'),
  parseClientLetter: vi.fn((parsed: unknown) => parsed as any),
};
const jurisdictionsLoader = { getFilingDraftPack: vi.fn(() => packMock) };
vi.mock('@agentbook/jurisdictions/filing-draft-loader', () => jurisdictionsLoader);

function makeSession(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'tqs-1', tenantId: 'tenant-A', taxYear: 2025, jurisdiction: 'us',
    sourceFilingId: 'filing-1', status: 'completed',
    qaHistory: [{ question: 'Filing status?', answer: 'Same as last year' }],
    ...overrides,
  };
}

function makeFiling(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'filing-1',
    extractedData: {
      formType: '1040', taxYear: 2024, jurisdiction: 'us',
      totalIncomeCents: 8500000, taxableIncomeCents: 7200000, taxPayableCents: 1150000,
      formFields: {}, attachedForms: {}, confidence: 0.9,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue(makeSession());
  dbMock.abPastTaxFiling.findUnique.mockResolvedValue(makeFiling());
  jurisdictionsLoader.getFilingDraftPack.mockReturnValue(packMock);
});

describe('computeFilingDraftSummaryAndLetter', () => {
  it('computes a real tax figure via calculateTax, not an LLM-invented one', async () => {
    const { computeFilingDraftSummaryAndLetter } = await import('../tax-fast-track-draft-compute');
    const callGemini = vi.fn(async (prompt: string) => {
      if (prompt === 'DELTA PROMPT') return JSON.stringify({ incomeDeltaPercent: 0, changesFromLastYear: [], openQuestions: [] });
      return JSON.stringify({ letterBody: 'Dear Accountant, ...' });
    });

    const { summary, letterBody } = await computeFilingDraftSummaryAndLetter('tqs-1', callGemini);

    // 0% delta on $72,000 taxable income — verify against the real
    // usTaxBrackets.calculateTax() output for tax year 2025, not a guess.
    const { usTaxBrackets } = await import('@agentbook/jurisdictions/us/tax-brackets');
    const expected = usTaxBrackets.calculateTax(7200000, 2025);
    expect(summary.estimatedTaxPayableCents).toBe(expected.taxCents);
    expect(summary.taxPayableDeltaVsLastYearCents).toBe(expected.taxCents - 1150000);
    expect(letterBody).toContain('Dear Accountant');
  });

  it('degrades gracefully (omits numeric fields) when the prior filing has no taxable income on file', async () => {
    dbMock.abPastTaxFiling.findUnique.mockResolvedValue(makeFiling({
      extractedData: { formType: '1040', taxYear: 2024, jurisdiction: 'us', formFields: {}, attachedForms: {}, confidence: 0.3 },
    }));
    const callGemini = vi.fn(async () => JSON.stringify({ changesFromLastYear: [], openQuestions: [] }));

    const { computeFilingDraftSummaryAndLetter } = await import('../tax-fast-track-draft-compute');
    const { summary } = await computeFilingDraftSummaryAndLetter('tqs-1', callGemini);

    expect(summary.estimatedTaxPayableCents).toBeUndefined();
    expect(summary.estimatedTotalIncomeCents).toBeUndefined();
  });

  it('throws a categorized TaxFastTrackComputeError when callGemini returns falsy for delta extraction', async () => {
    const { computeFilingDraftSummaryAndLetter, TaxFastTrackComputeError } = await import('../tax-fast-track-draft-compute');
    const callGemini = vi.fn(async () => null);

    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toThrow(TaxFastTrackComputeError);
    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toMatchObject({ code: 'delta_extraction_failed' });
  });

  it('throws a categorized TaxFastTrackComputeError when callGemini returns falsy for the letter', async () => {
    const callGemini = vi.fn(async (prompt: string) => (prompt === 'DELTA PROMPT' ? JSON.stringify({ changesFromLastYear: [], openQuestions: [] }) : null));
    const { computeFilingDraftSummaryAndLetter, TaxFastTrackComputeError } = await import('../tax-fast-track-draft-compute');

    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toThrow(TaxFastTrackComputeError);
    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toMatchObject({ code: 'letter_generation_failed' });
  });
});
