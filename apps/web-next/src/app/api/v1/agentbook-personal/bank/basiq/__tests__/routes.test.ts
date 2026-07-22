import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const requirePersonalInsightsAddon = vi.fn();
vi.mock('@/lib/agentbook-personal-insights/guard', () => ({
  requirePersonalInsightsAddon: (...a: unknown[]) => requirePersonalInsightsAddon(...a),
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const createBasiqUser = vi.fn();
const getBasiqClientToken = vi.fn();
const pollJob = vi.fn();
const listAccounts = vi.fn();
const listTransactions = vi.fn();
const removeConnection = vi.fn();
const sanitizeBasiqError = vi.fn((e: unknown) => ({ message: 'sanitized: ' + String(e) }));
vi.mock('@/lib/agentbook-basiq', () => ({
  createBasiqUser: (...a: unknown[]) => createBasiqUser(...a),
  getBasiqClientToken: (...a: unknown[]) => getBasiqClientToken(...a),
  pollJob: (...a: unknown[]) => pollJob(...a),
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  listTransactions: (...a: unknown[]) => listTransactions(...a),
  removeConnection: (...a: unknown[]) => removeConnection(...a),
  sanitizeBasiqError: (...a: unknown[]) => sanitizeBasiqError(...a),
}));

const tenantConfigFindUnique = vi.fn();
const tenantConfigUpsert = vi.fn();
const userFindUnique = vi.fn();
const personalAccountFindMany = vi.fn();
const personalAccountFindFirst = vi.fn();
const personalAccountUpsert = vi.fn();
const personalAccountUpdate = vi.fn();
const personalTransactionFindUnique = vi.fn();
const personalTransactionUpsert = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: {
      findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a),
      upsert: (...a: unknown[]) => tenantConfigUpsert(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    abPersonalAccount: {
      findMany: (...a: unknown[]) => personalAccountFindMany(...a),
      findFirst: (...a: unknown[]) => personalAccountFindFirst(...a),
      upsert: (...a: unknown[]) => personalAccountUpsert(...a),
      update: (...a: unknown[]) => personalAccountUpdate(...a),
    },
    abPersonalTransaction: {
      findUnique: (...a: unknown[]) => personalTransactionFindUnique(...a),
      upsert: (...a: unknown[]) => personalTransactionUpsert(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

function postReq(body?: unknown) {
  return new NextRequest('http://x/basiq', {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
  });
}

function getReq(query?: string) {
  return new NextRequest(`http://x/basiq${query ? `?${query}` : ''}`, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePersonalInsightsAddon.mockResolvedValue({ tenantId: 'tenant-1' });
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  eventCreate.mockResolvedValue({});
});

describe('POST /agentbook-personal/bank/basiq/consent-url', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json(
        { error: 'Net-worth trends and proactive alerts are part of Personal Insights — enable it in your Personal Finance settings to use them.' },
        { status: 402 },
      ),
    });
    const { POST } = await import('../consent-url/route');
    const res = await POST(postReq());
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toBe(
      'Net-worth trends and proactive alerts are part of Personal Insights — enable it in your Personal Finance settings to use them.',
    );
    expect(createBasiqUser).not.toHaveBeenCalled();
    expect(getBasiqClientToken).not.toHaveBeenCalled();
  });

  it('reuses an existing basiqUserId without creating a new Basiq user', async () => {
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-existing' });
    getBasiqClientToken.mockResolvedValue('client-token-abc');
    const { POST } = await import('../consent-url/route');
    const res = await POST(postReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(createBasiqUser).not.toHaveBeenCalled();
    expect(getBasiqClientToken).toHaveBeenCalledWith('buser-existing');
    expect(json.data.consentUrl).toContain('https://consent.basiq.io/home');
    expect(json.data.consentUrl).toContain('token=client-token-abc');
    expect(json.data.consentUrl).toContain(`state=${encodeURIComponent('tenant-1')}`);
    expect(json.data.consentUrl).toContain('redirectUrl=');
    expect(json.data.consentUrl).toContain(encodeURIComponent('/api/v1/agentbook-personal/bank/basiq/callback'));
  });

  it('lazily creates a Basiq user + upserts AbTenantConfig when none exists yet', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: 'tenant-1', email: 'sydney@agentbook.test' });
    createBasiqUser.mockResolvedValue({ basiqUserId: 'buser-new' });
    getBasiqClientToken.mockResolvedValue('client-token-xyz');
    tenantConfigUpsert.mockResolvedValue({});
    const { POST } = await import('../consent-url/route');
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect(createBasiqUser).toHaveBeenCalledWith('tenant-1', 'sydney@agentbook.test');
    expect(tenantConfigUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'tenant-1' },
        create: { userId: 'tenant-1', basiqUserId: 'buser-new' },
        update: { basiqUserId: 'buser-new' },
      }),
    );
    expect(getBasiqClientToken).toHaveBeenCalledWith('buser-new');
  });
});

describe('GET /agentbook-personal/bank/basiq/callback', () => {
  it('extracts jobId from the query string and embeds it in a postMessage script', async () => {
    const { GET } = await import('../callback/route');
    const res = await GET(getReq('jobId=job-123&state=tenant-1'));
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('window.opener.postMessage');
    expect(html).toContain('basiqJobId: "job-123"');
    expect(html).toContain('window.close()');
  });

  it('does not require the personal_insights add-on', async () => {
    const { GET } = await import('../callback/route');
    await GET(getReq('jobId=job-123'));
    expect(requirePersonalInsightsAddon).not.toHaveBeenCalled();
  });
});

describe('GET /agentbook-personal/bank/basiq/status', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { GET } = await import('../status/route');
    const res = await GET(getReq('jobId=job-1'));
    expect(res.status).toBe(402);
    expect(pollJob).not.toHaveBeenCalled();
  });

  it('returns 400 when jobId is missing', async () => {
    const { GET } = await import('../status/route');
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  it('returns 400 when the tenant has no Basiq user yet', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    const { GET } = await import('../status/route');
    const res = await GET(getReq('jobId=job-1'));
    expect(res.status).toBe(400);
    expect(pollJob).not.toHaveBeenCalled();
  });

  it('reports in-progress without creating any account', async () => {
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    pollJob.mockResolvedValue({ status: 'in-progress' });
    const { GET } = await import('../status/route');
    const res = await GET(getReq('jobId=job-1'));
    const json = await res.json();
    expect(json.data.status).toBe('in-progress');
    expect(listAccounts).not.toHaveBeenCalled();
    expect(personalAccountUpsert).not.toHaveBeenCalled();
  });

  it('reports the failure reason on a failed job', async () => {
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    pollJob.mockResolvedValue({ status: 'failed', error: 'invalid-credentials' });
    const { GET } = await import('../status/route');
    const res = await GET(getReq('jobId=job-1'));
    const json = await res.json();
    expect(json.data.status).toBe('failed');
    expect(json.data.error).toBe('invalid-credentials');
    expect(personalAccountUpsert).not.toHaveBeenCalled();
  });

  it('creates AbPersonalAccount rows on job success', async () => {
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    pollJob.mockResolvedValue({ status: 'success', connectionId: 'conn-1' });
    listAccounts.mockResolvedValue([
      {
        id: 'acct-1',
        name: 'Everyday Account',
        balance: '1234.56',
        currency: 'AUD',
        class: { type: 'transaction' },
        institution: 'AU00000',
        connection: 'conn-1',
      },
    ]);
    personalAccountUpsert.mockResolvedValue({});
    const { GET } = await import('../status/route');
    const res = await GET(getReq('jobId=job-1'));
    const json = await res.json();
    expect(json.data.status).toBe('success');
    expect(json.data.accountsLinked).toBe(1);
    expect(personalAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { basiqAccountId: 'acct-1' },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          provider: 'basiq',
          basiqAccountId: 'acct-1',
          basiqConnectionId: 'conn-1',
          balanceCents: 123456,
          currency: 'AUD',
        }),
      }),
    );
  });
});

describe('POST /agentbook-personal/bank/basiq/sync', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    expect(res.status).toBe(402);
    expect(personalAccountFindMany).not.toHaveBeenCalled();
  });

  it('returns 400 when the tenant has no Basiq user yet', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    expect(res.status).toBe(400);
  });

  it('is a no-op with zero accounts (no crash)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    personalAccountFindMany.mockResolvedValue([]);
    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.accountsSynced).toBe(0);
    expect(json.data.transactionsImported).toBe(0);
  });

  it('inverts the amount sign relative to the business-side convention: a Basiq debit becomes a NEGATIVE AbPersonalTransaction.amountCents (outflow), a Basiq credit becomes POSITIVE (inflow)', async () => {
    // Per agentbook-personal-plaid.ts's file header, AbPersonalTransaction.amountCents
    // is positive = inflow/income, negative = outflow/spend — the OPPOSITE of
    // AbBankTransaction's convention (positive = outflow/debit) used by the
    // business-side Basiq sync route (Task 2). Basiq's own `amount` is already
    // negative for a debit/outflow and positive for a credit/inflow, which is
    // the SAME sign AbPersonalTransaction expects — so this route must NOT
    // negate, unlike Task 2's business-side sync (which does negate).
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    personalAccountFindMany.mockResolvedValue([
      { id: 'pacct-1', tenantId: 'tenant-1', provider: 'basiq', connected: true, lastSynced: null },
    ]);
    listTransactions.mockResolvedValue([
      { id: 'txn-debit', description: 'Coffee shop', amount: '-4.50', direction: 'debit', postDate: '2026-07-20', status: 'posted', account: 'acct-1' },
      { id: 'txn-credit', description: 'Salary', amount: '2500.00', direction: 'credit', postDate: '2026-07-21', status: 'posted', account: 'acct-1' },
    ]);
    personalTransactionFindUnique.mockResolvedValue(null);
    personalTransactionUpsert.mockResolvedValue({});
    personalAccountUpdate.mockResolvedValue({});

    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.transactionsImported).toBe(2);

    const debitCall = personalTransactionUpsert.mock.calls.find(
      (c) => c[0].where.basiqTransactionId === 'txn-debit',
    );
    const creditCall = personalTransactionUpsert.mock.calls.find(
      (c) => c[0].where.basiqTransactionId === 'txn-credit',
    );
    expect(debitCall).toBeDefined();
    expect(creditCall).toBeDefined();
    expect(debitCall![0].create.amountCents).toBe(-450); // debit/outflow -> negative
    expect(creditCall![0].create.amountCents).toBe(250000); // credit/inflow -> positive
  });

  it('does not overwrite category on an existing transaction', async () => {
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    personalAccountFindMany.mockResolvedValue([
      { id: 'pacct-1', tenantId: 'tenant-1', provider: 'basiq', connected: true, lastSynced: null },
    ]);
    listTransactions.mockResolvedValue([
      { id: 'txn-1', description: 'Groceries', amount: '-30.00', direction: 'debit', postDate: '2026-07-20', status: 'posted', account: 'acct-1' },
    ]);
    personalTransactionFindUnique.mockResolvedValue({ id: 'existing-row' });
    personalTransactionUpsert.mockResolvedValue({});
    personalAccountUpdate.mockResolvedValue({});

    const { POST } = await import('../sync/route');
    await POST(postReq());
    const call = personalTransactionUpsert.mock.calls[0][0];
    expect(call.update.category).toBeUndefined();
  });
});

describe('POST /agentbook-personal/bank/basiq/disconnect', () => {
  it('is NOT gated by personal_insights — works even when requirePersonalInsightsAddon would deny', async () => {
    personalAccountFindFirst.mockResolvedValue({
      id: 'pacct-1',
      tenantId: 'tenant-1',
      basiqConnectionId: 'conn-1',
    });
    tenantConfigFindUnique.mockResolvedValue({ userId: 'tenant-1', basiqUserId: 'buser-1' });
    personalAccountUpdate.mockResolvedValue({});
    const { POST } = await import('../disconnect/route');
    const res = await POST(postReq({ accountId: 'pacct-1' }));
    expect(res.status).toBe(200);
    expect(removeConnection).toHaveBeenCalledWith('buser-1', 'conn-1');
    expect(personalAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'pacct-1' },
      data: { connected: false },
    });
    // Confirms this route never even calls the addon guard.
    expect(requirePersonalInsightsAddon).not.toHaveBeenCalled();
  });

  it('returns 400 when accountId is missing', async () => {
    const { POST } = await import('../disconnect/route');
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });
});
