import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-A' })),
}));

const coreMock = {
  startTaxQuestionnaire: vi.fn(),
  answerTaxQuestionnaire: vi.fn(),
  cancelTaxQuestionnaire: vi.fn(),
};
vi.mock('@agentbook-core/tax-questionnaire-core', () => coreMock);

const sessionHelpersMock = { getActiveTaxQuestionnaireSession: vi.fn() };
vi.mock('@agentbook-core/tax-questionnaire-session', async () => {
  const actual = await vi.importActual<typeof import('@agentbook-core/tax-questionnaire-session')>('@agentbook-core/tax-questionnaire-session');
  return { ...actual, getActiveTaxQuestionnaireSession: sessionHelpersMock.getActiveTaxQuestionnaireSession };
});

vi.mock('@agentbook-core/server', () => ({ callGemini: vi.fn() }));

const generateFilingDraftMock = vi.fn(async () => {});
vi.mock('@/lib/tax-fast-track-draft', () => ({ generateFilingDraft: (...args: any[]) => generateFilingDraftMock(...args) }));

const afterMock = vi.fn((cb: () => void) => cb());
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: (...args: any[]) => afterMock(...args) };
});

const dbMock = {
  abTenantConfig: { findFirst: vi.fn(async () => null as any) },
  abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null as any), findUnique: vi.fn(async () => null as any) },
  abTaxFastTrackDraft: { findUnique: vi.fn(async () => null as any) },
};
vi.mock('@naap/database', () => ({
  prisma: dbMock,
  // Needed because vi.importActual('@agentbook-core/tax-questionnaire-session')
  // below pulls in the real ./db/client.js, which does `new PrismaClient()`.
  PrismaClient: function PrismaClient() { return dbMock; },
}));

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/v1/agentbook-core/tax-fast-track/start', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /tax-fast-track/start', () => {
  it('resolves jurisdiction via abTenantConfig.findFirst({where:{userId}}) and triggers generateFilingDraft on done', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
    coreMock.startTaxQuestionnaire.mockResolvedValue({ status: 'done', sessionId: 'tqs-1' });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/start/route');

    const res = await POST(makeRequest({ taxYear: 2025 }));
    const json = await res.json();

    expect(dbMock.abTenantConfig.findFirst).toHaveBeenCalledWith({ where: { userId: 'tenant-A' } });
    expect(coreMock.startTaxQuestionnaire).toHaveBeenCalledWith('tenant-A', { taxYear: 2025, jurisdiction: 'ca', region: 'ON' }, expect.anything());
    expect(json.data.status).toBe('done');
    expect(generateFilingDraftMock).toHaveBeenCalledWith('tqs-1', expect.anything());
  });

  it('does not trigger generateFilingDraft when the result is a question, not done', async () => {
    coreMock.startTaxQuestionnaire.mockResolvedValue({ status: 'question', question: 'Filing status?', sessionId: 'tqs-2' });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/start/route');

    await POST(makeRequest({}));

    expect(generateFilingDraftMock).not.toHaveBeenCalled();
  });
});

describe('POST /tax-fast-track/answer', () => {
  it('returns 400 when there is no active session', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/answer/route');

    const res = await POST(makeRequest({ text: 'Single, no changes' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('no_active_session');
  });

  it('happy path: answers via the core function and triggers generation on done', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue({ id: 'tqs-3' });
    coreMock.answerTaxQuestionnaire.mockResolvedValue({ status: 'done', sessionId: 'tqs-3' });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/answer/route');

    const res = await POST(makeRequest({ text: 'Still single' }));
    const json = await res.json();

    expect(json.data.status).toBe('done');
    expect(generateFilingDraftMock).toHaveBeenCalledWith('tqs-3', expect.anything());
  });
});

describe('POST /tax-fast-track/cancel', () => {
  it('returns 400 when there is no active session', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/cancel/route');

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('happy path: cancels via the core function', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue({ id: 'tqs-4' });
    coreMock.cancelTaxQuestionnaire.mockResolvedValue({ status: 'cancelled', sessionId: 'tqs-4' });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/cancel/route');

    const res = await POST(makeRequest({}));
    const json = await res.json();
    expect(json.data.status).toBe('cancelled');
  });
});

describe('GET /tax-fast-track/status', () => {
  it('returns {session:null, draft:null} when the tenant has never started a session', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data).toEqual({ session: null, draft: null });
  });

  it('finds a COMPLETED session (not just in_progress) and its linked draft', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({
      id: 'tqs-5', status: 'completed', qaHistory: [{ question: 'Q', answer: 'A' }], askedCount: 3,
    });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'ready', draftPdfUrl: 'https://x/draft.pdf', letterPdfUrl: 'https://x/letter.pdf',
      draftSummary: { caveat: 'est.' }, errorMsg: null, updatedAt: new Date(),
    });
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data.session.status).toBe('completed');
    expect(json.data.draft.status).toBe('ready');
    expect(json.data.draft.stale).toBe(false);
  });

  it('flags a draft as stale when pending for more than 2 minutes', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-6', status: 'completed', qaHistory: [], askedCount: 3 });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'pending', draftPdfUrl: null, letterPdfUrl: null, draftSummary: null, errorMsg: null,
      updatedAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data.draft.stale).toBe(true);
  });

  it('synthesizes a stale-pending draft when the draft row was never created (after() killed before its first write) and the completed session has sat idle past the timeout', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({
      id: 'tqs-12', status: 'completed', qaHistory: [], askedCount: 3,
      updatedAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue(null);
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data.draft).toEqual({
      status: 'pending', draftPdfUrl: null, letterPdfUrl: null, draftSummary: null, errorMsg: null, stale: true,
    });
  });

  it('keeps draft null when the draft row is missing but the completed session is still within the stale timeout', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({
      id: 'tqs-13', status: 'completed', qaHistory: [], askedCount: 3,
      updatedAt: new Date(),
    });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue(null);
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data.draft).toBeNull();
  });
});

describe('POST /tax-fast-track/regenerate', () => {
  it('rejects when the session is not completed', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-7', tenantId: 'tenant-A', status: 'in_progress' });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-7' }));
    expect(res.status).toBe(400);
  });

  it('rejects when the draft is still ready (not a retry target)', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-8', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'ready', updatedAt: new Date() });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-8' }));
    expect(res.status).toBe(400);
    expect(generateFilingDraftMock).not.toHaveBeenCalled();
  });

  it('accepts a failed draft and triggers regeneration', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-9', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'failed', updatedAt: new Date() });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-9' }));
    expect(res.status).toBe(200);
    expect(generateFilingDraftMock).toHaveBeenCalledWith('tqs-9', expect.anything());
  });

  it('accepts a stale-pending draft and triggers regeneration', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-10', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date(Date.now() - 3 * 60 * 1000) });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-10' }));
    expect(res.status).toBe(200);
    expect(generateFilingDraftMock).toHaveBeenCalled();
  });

  it('rejects a fresh-pending draft (still genuinely in flight)', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-11', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date() });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-11' }));
    expect(res.status).toBe(400);
    expect(generateFilingDraftMock).not.toHaveBeenCalled();
  });
});
