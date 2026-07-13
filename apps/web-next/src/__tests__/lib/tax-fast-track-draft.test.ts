import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const dbMock = {
  abTaxQuestionnaireSession: { findUnique: vi.fn(async () => null as any) },
  abTaxFastTrackDraft: {
    upsert: vi.fn(async () => ({ id: 'draft-1' })),
    update: vi.fn(async () => ({})),
  },
};
vi.mock('@naap/database', () => ({ prisma: dbMock }));

const computeMock = vi.fn();
class FakeComputeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
vi.mock('@agentbook-core/tax-fast-track-draft-compute', () => ({
  computeFilingDraftSummaryAndLetter: (...args: any[]) => computeMock(...args),
  TaxFastTrackComputeError: FakeComputeError,
}));

const renderDraftMock = vi.fn(async () => Buffer.from('draft-pdf'));
const renderLetterMock = vi.fn(async () => Buffer.from('letter-pdf'));
vi.mock('@/lib/tax-fast-track-pdf', () => ({
  renderFilingDraftPdf: (...args: any[]) => renderDraftMock(...args),
  renderClientLetterPdf: (...args: any[]) => renderLetterMock(...args),
}));

const uploadBlobMock = vi.fn(async (name: string) => ({ url: `https://blob.test/${name}`, size: 100 }));
vi.mock('@/lib/agentbook-blob', () => ({ uploadBlob: (...args: any[]) => uploadBlobMock(...args) }));

function makeSession(overrides: Partial<Record<string, any>> = {}) {
  return { id: 'tqs-1', tenantId: 'tenant-A', taxYear: 2025, jurisdiction: 'us', status: 'completed', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue(makeSession());
  dbMock.abTaxFastTrackDraft.upsert.mockResolvedValue({ id: 'draft-1' });
});

describe('generateFilingDraft', () => {
  it('happy path: computes, renders both PDFs, uploads both, marks ready', async () => {
    computeMock.mockResolvedValue({ summary: { changesFromLastYear: [], openQuestions: [], caveat: 'est.' }, letterBody: 'Dear Accountant' });
    const { generateFilingDraft } = await import('../../lib/tax-fast-track-draft');

    await generateFilingDraft('tqs-1', vi.fn());

    expect(renderDraftMock).toHaveBeenCalledTimes(1);
    expect(renderLetterMock).toHaveBeenCalledTimes(1);
    expect(uploadBlobMock).toHaveBeenCalledTimes(2);
    const [updateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[0];
    expect(updateArgs.data.status).toBe('ready');
    expect(updateArgs.data.draftPdfUrl).toContain('draft.pdf');
    expect(updateArgs.data.letterPdfUrl).toContain('letter.pdf');
  });

  it('marks failed with the categorized code when delta extraction fails', async () => {
    computeMock.mockRejectedValue(new FakeComputeError('delta_extraction_failed', 'callGemini returned falsy'));
    const { generateFilingDraft } = await import('../../lib/tax-fast-track-draft');

    await generateFilingDraft('tqs-1', vi.fn());

    const [updateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[0];
    expect(updateArgs.data.status).toBe('failed');
    expect(updateArgs.data.errorMsg).toBe('delta_extraction_failed');
  });

  it('marks failed with pdf_render_failed when a PDF render throws', async () => {
    computeMock.mockResolvedValue({ summary: { changesFromLastYear: [], openQuestions: [], caveat: 'est.' }, letterBody: 'Dear Accountant' });
    renderDraftMock.mockRejectedValueOnce(new Error('renderToBuffer exploded'));
    const { generateFilingDraft } = await import('../../lib/tax-fast-track-draft');

    await generateFilingDraft('tqs-1', vi.fn());

    const [updateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[0];
    expect(updateArgs.data.status).toBe('failed');
    expect(updateArgs.data.errorMsg).toBe('pdf_render_failed');
  });

  it('is safe to call again after a failure (re-upserts the same row, does not create a duplicate)', async () => {
    computeMock.mockRejectedValueOnce(new FakeComputeError('delta_extraction_failed', 'first attempt fails'));
    const { generateFilingDraft } = await import('../../lib/tax-fast-track-draft');
    await generateFilingDraft('tqs-1', vi.fn());

    computeMock.mockResolvedValueOnce({ summary: { changesFromLastYear: [], openQuestions: [], caveat: 'est.' }, letterBody: 'Dear Accountant' });
    await generateFilingDraft('tqs-1', vi.fn());

    expect(dbMock.abTaxFastTrackDraft.upsert).toHaveBeenCalledTimes(2);
    expect(dbMock.abTaxFastTrackDraft.upsert.mock.calls[1][0].where).toEqual({ sessionId: 'tqs-1' });
    const [secondUpdateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[1];
    expect(secondUpdateArgs.data.status).toBe('ready');
  });
});
