import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 1 — schema + data-layer helpers for AbTaxQuestionnaireSession.
 *
 * Mirrors agent-planner.ts's createSession()/getActiveSession()/updateSession()
 * trio exactly, for the new tax-questionnaire session model. See:
 * docs/superpowers/specs/2026-07-13-tax-fast-track-foundation-design.md
 * docs/superpowers/plans/2026-07-13-tax-fast-track-foundation.md (Task 1)
 */

const dbMock = {
  abAgentSession: {
    updateMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async (args: any) => ({
      ...args.data,
      id: 'sess-plan',
      version: 1,
    })),
  },
  abTaxQuestionnaireSession: {
    updateMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async (args: any) => ({
      ...args.data,
      id: 'tqs-1',
      version: 0,
    })),
    findFirst: vi.fn(async (_args?: any) => null as any),
  },
  $executeRaw: vi.fn(async (..._args: any[]) => 1 as any),
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abAgentSession.updateMany.mockResolvedValue({ count: 0 });
  dbMock.abAgentSession.create.mockImplementation(async (args: any) => ({
    ...args.data,
    id: 'sess-plan',
    version: 1,
  }));
  dbMock.abTaxQuestionnaireSession.updateMany.mockResolvedValue({ count: 0 });
  dbMock.abTaxQuestionnaireSession.create.mockImplementation(async (args: any) => ({
    ...args.data,
    id: 'tqs-1',
    version: 0,
  }));
  dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
  dbMock.$executeRaw.mockResolvedValue(1);
});

describe('createTaxQuestionnaireSession', () => {
  it('expires a prior in-progress session for the same tenant before creating the new one', async () => {
    const { createTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    await createTaxQuestionnaireSession('tenant-A', 2025, 'us', null, 'fast_track', 'filing-1');

    expect(dbMock.abTaxQuestionnaireSession.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-A', status: 'in_progress' },
      data: { status: 'abandoned' },
    });

    // The expire call must happen before the create call (same ordering as
    // agent-planner.ts's createSession()).
    const updateManyOrder = dbMock.abTaxQuestionnaireSession.updateMany.mock.invocationCallOrder[0];
    const createOrder = dbMock.abTaxQuestionnaireSession.create.mock.invocationCallOrder[0];
    expect(updateManyOrder).toBeLessThan(createOrder);

    expect(dbMock.abTaxQuestionnaireSession.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-A',
        taxYear: 2025,
        jurisdiction: 'us',
        region: null,
        trigger: 'fast_track',
        sourceFilingId: 'filing-1',
        status: 'in_progress',
        qaHistory: [],
        askedCount: 0,
        consecutiveFailures: 0,
        expiresAt: expect.any(Date),
      },
    });
  });
});

describe('updateTaxQuestionnaireSession', () => {
  it('returns true and applies the update when version matches', async () => {
    dbMock.$executeRaw.mockResolvedValue(1);
    const { updateTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    const ok = await updateTaxQuestionnaireSession('tqs-1', 0, {
      qaHistory: [{ question: 'Q1', answer: 'A1' }],
      askedCount: 1,
    });

    expect(ok).toBe(true);
    expect(dbMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('returns false (no mutation) when version does not match', async () => {
    dbMock.$executeRaw.mockResolvedValue(0);
    const { updateTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    const ok = await updateTaxQuestionnaireSession('tqs-1', 5, {
      qaHistory: [{ question: 'Q1', answer: 'A1' }],
      askedCount: 1,
    });

    expect(ok).toBe(false);
  });
});

describe('getActiveTaxQuestionnaireSession', () => {
  it('returns null for an expired session (expiresAt in the past) even if status is still in_progress', async () => {
    // The expiry filter lives in the `where` clause passed to Prisma — an
    // expired row simply never matches, so the DB (and here, the mock
    // standing in for it) returns null.
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    const { getActiveTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    const result = await getActiveTaxQuestionnaireSession('tenant-A');

    expect(result).toBeNull();
    const callArgs = dbMock.abTaxQuestionnaireSession.findFirst.mock.calls[0]?.[0];
    expect(callArgs?.where.status).toBe('in_progress');
    expect(callArgs?.where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it('returns the session when neither status nor expiry excludes it', async () => {
    const fakeSession = {
      id: 'tqs-1',
      tenantId: 'tenant-A',
      status: 'in_progress',
      expiresAt: new Date(Date.now() + 60_000),
    };
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(fakeSession);
    const { getActiveTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    const result = await getActiveTaxQuestionnaireSession('tenant-A');

    expect(result).toEqual(fakeSession);
  });
});

describe('createSession() reverse mutual exclusion (agent-planner.ts)', () => {
  it('expires an active AbTaxQuestionnaireSession for the tenant when starting a new plan-confirmation session', async () => {
    const { createSession } = await import('../agent-planner.js');

    await createSession('tenant-A', 'some-trigger', []);

    expect(dbMock.abTaxQuestionnaireSession.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-A', status: 'in_progress' },
      data: { status: 'abandoned' },
    });
  });
});
