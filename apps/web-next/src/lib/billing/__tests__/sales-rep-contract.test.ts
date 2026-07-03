import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const salesRepApplicationFindUnique = vi.fn();
const salesRepApplicationFindUniqueOrThrow = vi.fn();
const salesRepApplicationUpdate = vi.fn();
const salesRepContractTemplateFindUnique = vi.fn();
const salesRepContractCreate = vi.fn();
const partnerProgramSettingsFindUnique = vi.fn();
const billSubscriptionFindUnique = vi.fn();
const billSubscriptionFindUniqueOrThrow = vi.fn();
const salesRepProfileFindUnique = vi.fn();
const userFindUnique = vi.fn();
const transactionMock = vi.fn((ops: unknown[]) => Promise.all(ops));
// Row(s) returned by the `FOR UPDATE` lock query inside withLockedDraftApplication.
const queryRawRows = vi.fn();

const txMock = {
  $queryRaw: (..._a: unknown[]) => queryRawRows(),
  salesRepApplication: { update: (...a: unknown[]) => salesRepApplicationUpdate(...a) },
};

vi.mock('@naap/database', () => ({
  prisma: {
    salesRepApplication: {
      findUnique: (...a: unknown[]) => salesRepApplicationFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => salesRepApplicationFindUniqueOrThrow(...a),
      update: (...a: unknown[]) => salesRepApplicationUpdate(...a),
    },
    salesRepContractTemplate: {
      findUnique: (...a: unknown[]) => salesRepContractTemplateFindUnique(...a),
    },
    salesRepContract: {
      create: (...a: unknown[]) => salesRepContractCreate(...a),
    },
    partnerProgramSettings: {
      findUnique: (...a: unknown[]) => partnerProgramSettingsFindUnique(...a),
    },
    billSubscription: {
      findUnique: (...a: unknown[]) => billSubscriptionFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => billSubscriptionFindUniqueOrThrow(...a),
    },
    salesRepProfile: {
      findUnique: (...a: unknown[]) => salesRepProfileFindUnique(...a),
    },
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
    },
    // signAndSubmitApplication uses the array form ($transaction([p1, p2]));
    // setApplicationAcknowledgment (via withLockedDraftApplication) uses the
    // callback form ($transaction(async tx => ...)) to hold a row lock.
    $transaction: (arg: unknown[] | ((tx: typeof txMock) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(txMock) : transactionMock(arg),
  },
}));

import {
  getApplicationContractPreview,
  setApplicationAcknowledgment,
  signAndSubmitApplication,
  DEFAULT_COMMISSION_BPS,
} from '../sales-rep-contract';

const usTemplate = {
  jurisdiction: 'us',
  version: 3,
  taxFormType: '1099-NEC',
  bodyTemplate: 'Rep: {{legalName}}, rate {{commissionPercent}}%, signed {{signedByName}} on {{signedAt}}.',
  liabilityClauses: {
    commission_payout: { title: 'Commission & payout', body: 'Earn {{commissionPercent}}%.' },
    fee_rebate: { title: 'Fee rebate', body: 'Rebate at {{rebateCommissionMultiple}}x of {{annualFeeFormatted}}.' },
    contractor_status: { title: 'Contractor status', body: 'You are a contractor.' },
    no_guaranteed_income: { title: 'No guaranteed income', body: 'No guarantees.' },
    termination: { title: 'Termination', body: 'Either party may terminate.' },
  },
};

const paidAnnualSub = {
  status: 'active',
  billingSource: 'stripe',
  plan: { code: 'pro', interval: 'year', priceCents: 30000 },
};

const draftApplication = (overrides: Record<string, unknown> = {}) => ({
  id: 'app1',
  tenantId: 't1',
  status: 'draft',
  jurisdiction: 'us',
  annualFeeCentsPaid: 30000,
  answers: {},
  ...overrides,
});

beforeEach(() => {
  salesRepApplicationFindUnique.mockReset();
  salesRepApplicationFindUniqueOrThrow.mockReset();
  salesRepApplicationUpdate.mockReset();
  salesRepContractTemplateFindUnique.mockReset();
  salesRepContractCreate.mockReset();
  partnerProgramSettingsFindUnique.mockReset();
  billSubscriptionFindUnique.mockReset();
  billSubscriptionFindUniqueOrThrow.mockReset();
  salesRepProfileFindUnique.mockReset();
  userFindUnique.mockReset();
  transactionMock.mockClear();

  partnerProgramSettingsFindUnique.mockResolvedValue({ rebateCommissionMultiple: 1.0 });
  salesRepProfileFindUnique.mockResolvedValue(null);
  billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
  billSubscriptionFindUniqueOrThrow.mockResolvedValue(paidAnnualSub);
  salesRepContractTemplateFindUnique.mockResolvedValue(usTemplate);
});

describe('getApplicationContractPreview', () => {
  it('throws for another tenant\'s application', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(draftApplication({ tenantId: 'other' }));
    await expect(getApplicationContractPreview('t1', 'app1')).rejects.toThrow('not found');
  });

  it('throws when no contract template exists for the jurisdiction', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(draftApplication({ jurisdiction: 'zz' }));
    salesRepContractTemplateFindUnique.mockResolvedValue(null);
    await expect(getApplicationContractPreview('t1', 'app1')).rejects.toThrow('no contract template');
  });

  it('reports every section unacknowledged and not ready to sign by default', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(draftApplication());
    const preview = await getApplicationContractPreview('t1', 'app1');
    expect(preview.sections).toHaveLength(5);
    expect(preview.sections.every((s) => !s.acknowledged)).toBe(true);
    expect(preview.readyToSign).toBe(false);
  });

  it('personalizes section bodies with the applicant\'s numbers', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(draftApplication());
    const preview = await getApplicationContractPreview('t1', 'app1');
    const rebate = preview.sections.find((s) => s.key === 'fee_rebate')!;
    expect(rebate.body).toBe('Rebate at 1x of $300.00.');
  });

  it('is ready to sign once every section and the taxpayer notice are acknowledged', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(
      draftApplication({
        answers: {
          acknowledgedSections: [
            'commission_payout', 'fee_rebate', 'contractor_status', 'no_guaranteed_income', 'termination',
          ],
          taxpayerNoticeAcknowledged: true,
        },
      }),
    );
    const preview = await getApplicationContractPreview('t1', 'app1');
    expect(preview.readyToSign).toBe(true);
  });
});

describe('setApplicationAcknowledgment', () => {
  it('refuses to edit an already-submitted application', async () => {
    queryRawRows.mockResolvedValue([draftApplication({ status: 'submitted' })]);
    await expect(
      setApplicationAcknowledgment('t1', 'app1', { sectionKey: 'termination' }, true),
    ).rejects.toThrow('already been submitted');
  });

  it('rejects an unknown section key', async () => {
    queryRawRows.mockResolvedValue([draftApplication()]);
    await expect(
      // @ts-expect-error deliberately invalid for the test
      setApplicationAcknowledgment('t1', 'app1', { sectionKey: 'not_a_real_section' }, true),
    ).rejects.toThrow('Unknown disclosure section');
  });

  it('adds a section to acknowledgedSections', async () => {
    queryRawRows.mockResolvedValue([draftApplication({ answers: { acknowledgedSections: ['termination'] } })]);
    salesRepApplicationUpdate.mockResolvedValue({});
    await setApplicationAcknowledgment('t1', 'app1', { sectionKey: 'fee_rebate' }, true);
    expect(salesRepApplicationUpdate).toHaveBeenCalledWith({
      where: { id: 'app1' },
      data: { answers: { acknowledgedSections: ['termination', 'fee_rebate'] } },
    });
  });

  it('removes a section when un-acknowledging', async () => {
    queryRawRows.mockResolvedValue([
      draftApplication({ answers: { acknowledgedSections: ['termination', 'fee_rebate'] } }),
    ]);
    salesRepApplicationUpdate.mockResolvedValue({});
    await setApplicationAcknowledgment('t1', 'app1', { sectionKey: 'fee_rebate' }, false);
    expect(salesRepApplicationUpdate).toHaveBeenCalledWith({
      where: { id: 'app1' },
      data: { answers: { acknowledgedSections: ['termination'] } },
    });
  });

  it('sets the taxpayer notice flag', async () => {
    queryRawRows.mockResolvedValue([draftApplication()]);
    salesRepApplicationUpdate.mockResolvedValue({});
    await setApplicationAcknowledgment('t1', 'app1', { taxpayerNotice: true }, true);
    expect(salesRepApplicationUpdate).toHaveBeenCalledWith({
      where: { id: 'app1' },
      data: { answers: { taxpayerNoticeAcknowledged: true } },
    });
  });

  it('locks the row via a transaction rather than a bare read-then-write (regression: concurrent toggles must not clobber each other)', async () => {
    queryRawRows.mockResolvedValue([draftApplication({ answers: { acknowledgedSections: ['termination'] } })]);
    salesRepApplicationUpdate.mockResolvedValue({});
    await setApplicationAcknowledgment('t1', 'app1', { sectionKey: 'fee_rebate' }, true);
    // The lock query must run — a plain salesRepApplication.findUnique read
    // (no lock) would let two near-simultaneous requests both read the
    // pre-write value and the second write would silently drop the first.
    expect(queryRawRows).toHaveBeenCalled();
  });
});

const fullyAcknowledged = () =>
  draftApplication({
    answers: {
      acknowledgedSections: [
        'commission_payout', 'fee_rebate', 'contractor_status', 'no_guaranteed_income', 'termination',
      ],
      taxpayerNoticeAcknowledged: true,
    },
  });

describe('signAndSubmitApplication', () => {
  it('rejects a blank typed name', async () => {
    await expect(
      signAndSubmitApplication('t1', 'app1', { signedByName: '   ', signerIp: '1.1.1.1', signerUserAgent: 'ua' }),
    ).rejects.toThrow('Type your full legal name');
  });

  it('refuses to sign an already-submitted application', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(draftApplication({ status: 'submitted' }));
    await expect(
      signAndSubmitApplication('t1', 'app1', { signedByName: 'Jane Doe', signerIp: '1.1.1.1', signerUserAgent: 'ua' }),
    ).rejects.toThrow('already been submitted');
  });

  it('refuses to sign when no longer eligible', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(fullyAcknowledged());
    billSubscriptionFindUnique.mockResolvedValue(null);
    await expect(
      signAndSubmitApplication('t1', 'app1', { signedByName: 'Jane Doe', signerIp: '1.1.1.1', signerUserAgent: 'ua' }),
    ).rejects.toThrow('active subscription');
    expect(salesRepContractCreate).not.toHaveBeenCalled();
  });

  it('refuses when the typed name does not match the account name on file', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(fullyAcknowledged());
    userFindUnique.mockResolvedValue({ displayName: 'Jane Doe' });
    await expect(
      signAndSubmitApplication('t1', 'app1', { signedByName: 'Someone Else', signerIp: '1.1.1.1', signerUserAgent: 'ua' }),
    ).rejects.toThrow('must match the name on your account');
    expect(salesRepContractCreate).not.toHaveBeenCalled();
  });

  it('accepts a case/whitespace-insensitive match against the account name', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(fullyAcknowledged());
    userFindUnique.mockResolvedValue({ displayName: 'Jane   Doe' });
    salesRepContractCreate.mockResolvedValue({ id: 'contract1' });
    salesRepApplicationFindUniqueOrThrow.mockResolvedValue({ id: 'app1', status: 'submitted' });

    await signAndSubmitApplication('t1', 'app1', { signedByName: '  jane doe  ', signerIp: '1.1.1.1', signerUserAgent: 'ua' });
    expect(salesRepContractCreate).toHaveBeenCalled();
  });

  it('refuses to sign before all disclosure sections are acknowledged', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(draftApplication());
    userFindUnique.mockResolvedValue(null);
    await expect(
      signAndSubmitApplication('t1', 'app1', { signedByName: 'Jane Doe', signerIp: '1.1.1.1', signerUserAgent: 'ua' }),
    ).rejects.toThrow('acknowledge every disclosure section');
    expect(salesRepContractCreate).not.toHaveBeenCalled();
  });

  it('freezes commissionBpsAtSigning at the platform default and finalizes the application', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(fullyAcknowledged());
    userFindUnique.mockResolvedValue(null); // no displayName on file — accept any typed name
    salesRepContractCreate.mockResolvedValue({ id: 'contract1', commissionBpsAtSigning: DEFAULT_COMMISSION_BPS });
    salesRepApplicationFindUniqueOrThrow.mockResolvedValue({ id: 'app1', status: 'submitted' });

    const result = await signAndSubmitApplication('t1', 'app1', {
      signedByName: 'Jane Doe', signerIp: '9.9.9.9', signerUserAgent: 'test-agent',
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(salesRepApplicationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'app1' },
        data: expect.objectContaining({ status: 'submitted' }),
      }),
    );
    expect(salesRepContractCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationId: 'app1',
          signedByName: 'Jane Doe',
          signerIp: '9.9.9.9',
          signerUserAgent: 'test-agent',
          commissionBpsAtSigning: DEFAULT_COMMISSION_BPS,
          templateVersion: usTemplate.version,
        }),
      }),
    );
    expect(result.contract).toEqual({ id: 'contract1', commissionBpsAtSigning: DEFAULT_COMMISSION_BPS });
  });

  it('refuses to sign into a jurisdiction with no contract template on file', async () => {
    salesRepApplicationFindUnique.mockResolvedValue(fullyAcknowledged());
    userFindUnique.mockResolvedValue(null);
    salesRepContractTemplateFindUnique.mockResolvedValue(null);
    await expect(
      signAndSubmitApplication('t1', 'app1', { signedByName: 'Jane Doe', signerIp: '1.1.1.1', signerUserAgent: 'ua' }),
    ).rejects.toThrow('no contract template');
  });
});
