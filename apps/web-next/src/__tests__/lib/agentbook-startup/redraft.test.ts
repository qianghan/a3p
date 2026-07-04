import { describe, it, expect, vi, beforeEach } from 'vitest';

const applicationFindUnique = vi.fn();
const applicationUpdate = vi.fn();
const programFindUnique = vi.fn();
const profileFindUnique = vi.fn();
const documentFindMany = vi.fn();
const decisionPointFindMany = vi.fn();
const decisionPointCreateMany = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitApplication: { findUnique: (...a: unknown[]) => applicationFindUnique(...a), update: (...a: unknown[]) => applicationUpdate(...a) },
    startupBenefitProgram: { findUnique: (...a: unknown[]) => programFindUnique(...a) },
    startupBenefitProfile: { findUnique: (...a: unknown[]) => profileFindUnique(...a) },
    startupBenefitDocument: { findMany: (...a: unknown[]) => documentFindMany(...a) },
    startupBenefitDecisionPoint: {
      findMany: (...a: unknown[]) => decisionPointFindMany(...a),
      createMany: (...a: unknown[]) => decisionPointCreateMany(...a),
    },
  },
}));
vi.mock('@agentbook/jurisdictions', () => ({
  getJurisdictionPack: (jurisdiction: string) => {
    if (jurisdiction !== 'us') return undefined;
    return {
      taxBenefits: {
        draftApplication: (programCode: string, inputs: { profile: { annualRdSpendCents?: number } }) => ({
          programCode,
          sections: { 'Qualified Research Expenses': inputs.profile.annualRdSpendCents ? [{ label: 'x', value: 1, sourceType: 'book_entry' }] : [] },
          completeness: inputs.profile.annualRdSpendCents ? 1 : 0,
        }),
        getDecisionPoints: (_programCode: string, draft: { completeness: number }) =>
          draft.completeness < 1 ? [{ sequenceOrder: 1, kind: 'approval', prompt: 'Confirm it.', options: ['approve', 'reject'] }] : [],
      },
    };
  },
  loadBuiltInPacks: () => {},
}));

import { redraftApplication } from '@/lib/agentbook-startup/redraft';

beforeEach(() => {
  applicationFindUnique.mockReset(); applicationUpdate.mockReset(); programFindUnique.mockReset();
  profileFindUnique.mockReset(); documentFindMany.mockReset(); decisionPointFindMany.mockReset(); decisionPointCreateMany.mockReset();
  applicationFindUnique.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', programId: 'prog-1' });
  programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'us_rd_credit_41', jurisdiction: 'us' });
  profileFindUnique.mockResolvedValue({ companyType: 'c_corp', annualRdSpendCents: 40_000_000 });
  documentFindMany.mockResolvedValue([]);
  decisionPointCreateMany.mockResolvedValue({ count: 1 });
  applicationUpdate.mockImplementation(({ data }) => ({ id: 'app-1', ...data }));
});

describe('redraftApplication', () => {
  it('creates a new decision point when the draft is incomplete and sets status to decision_pending', async () => {
    profileFindUnique.mockResolvedValue({ companyType: 'c_corp', annualRdSpendCents: null });
    decisionPointFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'dp-1', sequenceOrder: 1, response: null, blocksProgress: true }]);
    const result = await redraftApplication('app-1');
    expect(result.status).toBe(200);
    expect(decisionPointCreateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ sequenceOrder: 1 })]),
    }));
    expect((result.body.application as { status: string }).status).toBe('decision_pending');
  });

  it('reaches ready_for_review when the draft is complete and no decision points are pending', async () => {
    decisionPointFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await redraftApplication('app-1');
    expect(decisionPointCreateMany).not.toHaveBeenCalled();
    expect((result.body.application as { status: string }).status).toBe('ready_for_review');
  });

  it('does not recreate a decision point that already exists (preserves an already-recorded response)', async () => {
    profileFindUnique.mockResolvedValue({ companyType: 'c_corp', annualRdSpendCents: null });
    decisionPointFindMany.mockResolvedValueOnce([{ id: 'dp-1', sequenceOrder: 1, response: 'approve', blocksProgress: true }])
      .mockResolvedValueOnce([{ id: 'dp-1', sequenceOrder: 1, response: 'approve', blocksProgress: true }]);
    const result = await redraftApplication('app-1');
    expect(decisionPointCreateMany).not.toHaveBeenCalled();
    expect((result.body.application as { status: string }).status).toBe('drafting');
  });

  it('returns 404 when the application does not exist', async () => {
    applicationFindUnique.mockResolvedValue(null);
    const result = await redraftApplication('nope');
    expect(result.status).toBe(404);
  });

  it('returns 400 when the jurisdiction is not supported', async () => {
    programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'ca_sred', jurisdiction: 'ca' });
    const result = await redraftApplication('app-1');
    expect(result.status).toBe(400);
  });
});
