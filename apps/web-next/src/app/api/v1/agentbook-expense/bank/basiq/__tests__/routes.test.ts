import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

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
  sanitizeBasiqError: (e: unknown) => sanitizeBasiqError(e),
}));

const runMatcherOnTransaction = vi.fn();
vi.mock('@/lib/agentbook-plaid', () => ({
  runMatcherOnTransaction: (...a: unknown[]) => runMatcherOnTransaction(...a),
}));

const tenantConfigFindUnique = vi.fn();
const tenantConfigUpsert = vi.fn();
const userFindUnique = vi.fn();
const bankAccountUpsert = vi.fn();
const bankAccountFindMany = vi.fn();
const bankAccountFindFirst = vi.fn();
const bankAccountUpdate = vi.fn();
const bankTransactionFindUnique = vi.fn();
const bankTransactionCreate = vi.fn();
const bankTransactionUpdate = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: {
      findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a),
      upsert: (...a: unknown[]) => tenantConfigUpsert(...a),
    },
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
    },
    abBankAccount: {
      upsert: (...a: unknown[]) => bankAccountUpsert(...a),
      findMany: (...a: unknown[]) => bankAccountFindMany(...a),
      findFirst: (...a: unknown[]) => bankAccountFindFirst(...a),
      update: (...a: unknown[]) => bankAccountUpdate(...a),
    },
    abBankTransaction: {
      findUnique: (...a: unknown[]) => bankTransactionFindUnique(...a),
      create: (...a: unknown[]) => bankTransactionCreate(...a),
      update: (...a: unknown[]) => bankTransactionUpdate(...a),
    },
    abEvent: {
      create: (...a: unknown[]) => eventCreate(...a),
    },
  },
}));

function postReq(body?: unknown) {
  return new NextRequest('http://x/basiq', {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
  });
}

function getReq(query: string) {
  return new NextRequest(`http://x/basiq${query}`, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  eventCreate.mockResolvedValue({});
});

describe('POST /bank/basiq/consent-url', () => {
  it('creates a basiq user lazily and returns a consentUrl', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ email: 'maya@agentbook.test' });
    createBasiqUser.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
    tenantConfigUpsert.mockResolvedValue({});
    getBasiqClientToken.mockResolvedValue('client-token-abc');

    const { POST } = await import('../consent-url/route');
    const res = await POST(postReq());
    const json = await res.json();

    expect(createBasiqUser).toHaveBeenCalledWith('tenant-1', 'maya@agentbook.test');
    expect(tenantConfigUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'tenant-1' } }),
    );
    expect(json.data.consentUrl).toContain('https://consent.basiq.io/home');
    expect(json.data.consentUrl).toContain('token=client-token-abc');
    expect(json.data.consentUrl).toContain('state=tenant-1');
  });

  it('reuses an existing basiqUserId without creating a new one', async () => {
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'existing-user' });
    getBasiqClientToken.mockResolvedValue('client-token-xyz');

    const { POST } = await import('../consent-url/route');
    const res = await POST(postReq());
    const json = await res.json();

    expect(createBasiqUser).not.toHaveBeenCalled();
    expect(getBasiqClientToken).toHaveBeenCalledWith('existing-user');
    expect(json.data.consentUrl).toContain('token=client-token-xyz');
  });
});

describe('GET /bank/basiq/callback', () => {
  it('extracts jobId from the query string and hands it back via postMessage', async () => {
    const { GET } = await import('../callback/route');
    const res = await GET(getReq('?jobId=job-123&state=tenant-1'));
    const html = await res.text();

    expect(html).toContain('job-123');
    expect(html).toContain('window.opener.postMessage');
    expect(html).toContain('window.close()');
  });
});

describe('GET /bank/basiq/status', () => {
  it('creates accounts on job success', async () => {
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
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
    bankAccountUpsert.mockResolvedValue({});

    const { GET } = await import('../status/route');
    const res = await GET(getReq('?jobId=job-1'));
    const json = await res.json();

    expect(json.data.status).toBe('success');
    expect(json.data.accountsLinked).toBe(1);
    expect(bankAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { basiqAccountId: 'acct-1' },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          provider: 'basiq',
          basiqAccountId: 'acct-1',
          balanceCents: 123456,
          currency: 'AUD',
        }),
      }),
    );
  });

  it('returns in-progress without creating accounts', async () => {
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
    pollJob.mockResolvedValue({ status: 'in-progress' });

    const { GET } = await import('../status/route');
    const res = await GET(getReq('?jobId=job-1'));
    const json = await res.json();

    expect(json.data.status).toBe('in-progress');
    expect(listAccounts).not.toHaveBeenCalled();
    expect(bankAccountUpsert).not.toHaveBeenCalled();
  });

  it('returns the job error on failure', async () => {
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
    pollJob.mockResolvedValue({ status: 'failed', error: 'invalid-credentials' });

    const { GET } = await import('../status/route');
    const res = await GET(getReq('?jobId=job-1'));
    const json = await res.json();

    expect(json.data.status).toBe('failed');
    expect(json.data.error).toBe('invalid-credentials');
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('returns 400 when jobId is missing', async () => {
    const { GET } = await import('../status/route');
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });
});

describe('POST /bank/basiq/sync', () => {
  it('is a no-op with zero connected accounts', async () => {
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
    bankAccountFindMany.mockResolvedValue([]);

    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    const json = await res.json();

    expect(json.data.accountsSynced).toBe(0);
    expect(json.data.transactionsImported).toBe(0);
    expect(json.data.complete).toBe(true);
    expect(listTransactions).not.toHaveBeenCalled();
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'bank.basiq_sync_completed' }),
      }),
    );
  });

  it('creates new transactions, runs the matcher, and does not touch category on existing rows', async () => {
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
    bankAccountFindMany.mockResolvedValue([
      { id: 'acct-1', tenantId: 'tenant-1', lastSynced: null },
    ]);
    listTransactions.mockResolvedValue([
      {
        id: 'txn-new',
        description: 'Coffee Shop',
        amount: '-4.50',
        direction: 'debit',
        postDate: '2026-07-20',
        account: 'acct-1',
        status: 'posted',
      },
      {
        id: 'txn-existing',
        description: 'Rent',
        amount: '-2000.00',
        direction: 'debit',
        postDate: '2026-07-01',
        account: 'acct-1',
        status: 'posted',
      },
    ]);
    bankTransactionFindUnique.mockImplementation(async ({ where }: { where: { basiqTransactionId: string } }) => {
      if (where.basiqTransactionId === 'txn-existing') return { id: 'row-existing' };
      return null;
    });
    bankTransactionCreate.mockResolvedValue({ id: 'row-new' });
    bankTransactionUpdate.mockResolvedValue({});
    bankAccountUpdate.mockResolvedValue({});

    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    const json = await res.json();

    expect(json.data.transactionsImported).toBe(1);
    expect(json.data.modified).toBe(1);
    expect(bankTransactionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ basiqTransactionId: 'txn-new', amount: 450 }),
      }),
    );
    // category is never referenced in the update payload for existing rows.
    const updateCall = bankTransactionUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('category');
    expect(runMatcherOnTransaction).toHaveBeenCalledWith('tenant-1', { id: 'row-new' });
    expect(runMatcherOnTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when the tenant has no basiqUserId', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    const { POST } = await import('../sync/route');
    const res = await POST(postReq());
    expect(res.status).toBe(400);
  });
});

describe('POST /bank/basiq/disconnect', () => {
  it('removes the connection and flips connected:false', async () => {
    bankAccountFindFirst.mockResolvedValue({
      id: 'acct-1',
      tenantId: 'tenant-1',
      basiqConnectionId: 'conn-1',
    });
    tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
    removeConnection.mockResolvedValue(undefined);
    bankAccountUpdate.mockResolvedValue({});

    const { POST } = await import('../disconnect/route');
    const res = await POST(postReq({ accountId: 'acct-1' }));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(removeConnection).toHaveBeenCalledWith('basiq-user-1', 'conn-1');
    expect(bankAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'acct-1' },
      data: { connected: false },
    });
  });

  it('returns 400 when accountId is missing', async () => {
    const { POST } = await import('../disconnect/route');
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });
});
