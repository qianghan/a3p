/**
 * `GET /api/v1/agentbook-core/accounts?type=expense` silently ignored its
 * own `type` query param — the SAME bug fixed in the legacy Express plugin
 * backend (plugins/agentbook-core/backend/src/server.ts), but production
 * resolves `/api/v1/agentbook-core/*` through THIS Next.js route
 * (AGENTBOOK_CORE_URL is unset there — see apps/web-next/src/lib/
 * agentbook-config.ts), not the Express file. Fixing only the Express side
 * (as the original PR did) left the real production endpoint broken: a
 * request for `?type=expense` returned every account type (asset,
 * liability, equity, revenue, expense) unfiltered, exactly the bug this
 * whole fix was supposed to close for ExpenseList.tsx's category picker.
 *
 * Caught live: a fresh account's category dropdown rendered ENABLED after
 * the "fix" deployed, but its only option was "Supplies" (whatever the
 * tenant happened to already use) — the frontend fix genuinely reduced the
 * unfiltered response to a distinct set (map, no dedupe/filter), and this
 * route was returning ALL 34 seeded accounts, not just the 22 expense ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const accountFindMany = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const ALL_ACCOUNTS = [
  { id: 'a1', code: '1000', name: 'Cash', accountType: 'asset' },
  { id: 'a2', code: '4000', name: 'Service Revenue', accountType: 'revenue' },
  { id: 'a3', code: '5900', name: 'Rent or Lease', accountType: 'expense' },
  { id: 'a4', code: '6100', name: 'Supplies', accountType: 'expense' },
];

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  // Real Prisma behaviour: the mock filters by whatever `where` was passed,
  // so a route that forgets to build the accountType clause can't fail here.
  accountFindMany.mockImplementation(async (args: any) =>
    ALL_ACCOUNTS.filter((a) => args.where.accountType === undefined || a.accountType === args.where.accountType),
  );
});

describe('GET /api/v1/agentbook-core/accounts (real production route)', () => {
  it('with no type param, returns every active account type (existing behaviour preserved)', async () => {
    const { GET } = await import('../route');
    const res = await GET(new NextRequest('http://x/api/v1/agentbook-core/accounts'));
    const body = await res.json();

    expect(body.data.map((a: any) => a.accountType).sort()).toEqual(['asset', 'expense', 'expense', 'revenue']);
  });

  it('with type=expense, returns ONLY expense-type accounts — the actual production bug', async () => {
    const { GET } = await import('../route');
    const res = await GET(new NextRequest('http://x/api/v1/agentbook-core/accounts?type=expense'));
    const body = await res.json();

    expect(body.data.map((a: any) => a.accountType)).toEqual(['expense', 'expense']);
    expect(body.data.map((a: any) => a.name).sort()).toEqual(['Rent or Lease', 'Supplies']);
  });
});
