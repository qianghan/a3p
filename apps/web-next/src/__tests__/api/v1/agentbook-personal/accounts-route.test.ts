import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const accountFindMany = vi.fn();
const accountFindFirst = vi.fn();
const accountUpdate = vi.fn();
const accountCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: {
      findMany: (...a: unknown[]) => accountFindMany(...a),
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
      update: (...a: unknown[]) => accountUpdate(...a),
      create: (...a: unknown[]) => accountCreate(...a),
    },
  },
}));

function getReq(): NextRequest {
  return new NextRequest('http://x/accounts');
}
function putReq(body: unknown): NextRequest {
  return new NextRequest('http://x/accounts/a1', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

function plaidLinkedAccountRow() {
  return {
    id: 'a1', tenantId: 'tenant-1', name: 'Checking', type: 'checking', balanceCents: 100,
    currency: 'USD', isAsset: true, archived: false,
    plaidAccountId: 'plaid-1', plaidItemId: 'item-1', accessTokenEnc: 'SECRET-CIPHERTEXT',
    cursorToken: 'cursor-1', institution: 'Chase', officialName: null, subtype: null, mask: '1234',
    connected: true, lastSynced: new Date(), createdAt: new Date(), updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
});

describe('GET /api/v1/agentbook-personal/accounts', () => {
  it('never returns accessTokenEnc or cursorToken even for a Plaid-linked account', async () => {
    accountFindMany.mockResolvedValueOnce([plaidLinkedAccountRow()]);
    const { GET } = await import('@/app/api/v1/agentbook-personal/accounts/route');
    const res = await GET(getReq());
    const json = await res.json();
    expect(json.data[0].accessTokenEnc).toBeUndefined();
    expect(json.data[0].cursorToken).toBeUndefined();
    expect(json.data[0].institution).toBe('Chase'); // safe fields still present
  });
});

describe('PUT /api/v1/agentbook-personal/accounts/[id]', () => {
  it('never returns accessTokenEnc or cursorToken for a Plaid-linked account after a name/balance edit', async () => {
    accountFindFirst.mockResolvedValueOnce(plaidLinkedAccountRow());
    accountUpdate.mockResolvedValueOnce({ ...plaidLinkedAccountRow(), name: 'Renamed' });
    const { PUT } = await import('@/app/api/v1/agentbook-personal/accounts/[id]/route');
    const res = await PUT(putReq({ name: 'Renamed' }), { params: Promise.resolve({ id: 'a1' }) });
    const json = await res.json();
    expect(json.data.accessTokenEnc).toBeUndefined();
    expect(json.data.cursorToken).toBeUndefined();
    expect(json.data.name).toBe('Renamed');
  });
});
