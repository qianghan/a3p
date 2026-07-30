/**
 * Receipt scan must answer 400 for bad input, not 500.
 *
 * `await request.formData()` THROWS on a non-multipart body, so the route
 * crashed into its outer catch and returned 500 — its own documented
 * `file is required` guard was unreachable for exactly the requests that guard
 * exists to describe.
 *
 * That matters beyond tidiness: a 500 says "the server broke", so whoever is
 * debugging a failed receipt upload goes looking for a crash that never
 * happened, while the real cause (a client sending the wrong content type) is
 * never surfaced. Found by the nightly suite once its assertions were tightened
 * enough to tell 400 from 500 — the previous `status < 500` check passed either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));
vi.mock('@/lib/receipt-parse', () => ({ parseReceiptJson: vi.fn() }));

import { POST } from '@/app/api/v1/agentbook-expense/receipts/scan/route';

const URL_ = 'http://x/api/v1/agentbook-expense/receipts/scan';

beforeEach(() => {
  safeResolveAgentbookTenant.mockReset();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
});

describe('POST /agentbook-expense/receipts/scan — bad input', () => {
  it('answers 400, not 500, for a JSON body', async () => {
    const res = await POST(new NextRequest(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'https://example.test/r.jpg' }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/file is required/i);
  });

  it('answers 400 for an empty body', async () => {
    const res = await POST(new NextRequest(URL_, { method: 'POST' }));
    expect(res.status).toBe(400);
  });

  it('answers 400 for multipart with no file field', async () => {
    const form = new FormData();
    form.set('notafile', 'x');
    const res = await POST(new NextRequest(URL_, { method: 'POST', body: form }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/file is required/i);
  });

  it('still lets the tenant guard reject first', async () => {
    const { NextResponse } = await import('next/server');
    safeResolveAgentbookTenant.mockResolvedValue({
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const res = await POST(new NextRequest(URL_, { method: 'POST' }));
    expect(res.status).toBe(401);
  });
});
