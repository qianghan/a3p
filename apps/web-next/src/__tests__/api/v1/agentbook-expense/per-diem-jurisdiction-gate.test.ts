import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The wiring layer for the per-diem jurisdiction gate.
 *
 * `perDiemAvailability` being right in the jurisdictions pack proves nothing
 * about what a user is told — that depends on the route consulting it. The
 * e2e that was supposed to cover this asserted a hardcoded copy of the
 * response body against itself and never called the route at all, so it
 * could not fail no matter what the route did.
 *
 * These call the route.
 */

vi.mock('server-only', () => ({}));

const expenseCreate = vi.fn();
const tenantConfigFindUnique = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abExpense: { create: (...a: unknown[]) => expenseCreate(...a), createMany: (...a: unknown[]) => expenseCreate(...a) },
    abEvent: { create: vi.fn() },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ abExpense: { create: (...a: unknown[]) => expenseCreate(...a) }, abEvent: { create: vi.fn() } }),
  },
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }),
}));

import { POST } from '@/app/api/v1/agentbook-expense/per-diem/route';
import { perDiemAvailability } from '@agentbook/jurisdictions';

const req = () => new NextRequest('http://x/api/v1/agentbook-expense/per-diem', {
  method: 'POST',
  body: JSON.stringify({ city: 'New York City', days: 3, option: 'mie_only' }),
  headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  expenseCreate.mockReset();
  tenantConfigFindUnique.mockReset();
});

describe('POST /agentbook-expense/per-diem — jurisdiction gate', () => {
  it.each(['au', 'ca', 'uk'])('refuses %s with the pack\'s own explanation, and writes nothing', async (j) => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: j });
    const res = await POST(req());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('unsupported_jurisdiction');
    // Asserted against the shared helper, not a copy of the string: a copy is
    // what let the old e2e agree with itself while the route said something
    // else entirely.
    expect(body.error).toBe(perDiemAvailability(j).message);
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it('tells an AU sole trader why, not that it is coming later', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    const body = await (await POST(req())).json();
    expect(body.error).toMatch(/employee/i);
    expect(body.error).not.toMatch(/future release|coming soon/i);
  });

  it('refuses an unmodelled jurisdiction rather than treating it as the US', async () => {
    // The old gate listed ca/au/uk explicitly, so a tenant on any other
    // jurisdiction fell through and got US GSA rates for a deduction their
    // authority does not recognise.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'de' });
    const res = await POST(req());
    expect(res.status).toBe(422);
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it('lets a US tenant through to the booking path', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    const res = await POST(req());
    expect(res.status).not.toBe(422);
  });
});
