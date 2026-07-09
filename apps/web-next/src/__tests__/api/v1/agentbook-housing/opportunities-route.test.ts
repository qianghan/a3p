import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const requireStudentAddon = vi.fn();
const opportunityCreate = vi.fn();
const isUrlLive = vi.fn();

vi.mock('@/lib/agentbook-student/guard', () => ({
  requireStudentAddon: (...a: unknown[]) => requireStudentAddon(...a),
}));
vi.mock('@/lib/agentbook-student/link-check', () => ({
  isUrlLive: (...a: unknown[]) => isUrlLive(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abStudentOpportunity: {
      create: (...a: unknown[]) => opportunityCreate(...a),
    },
  },
}));

import { POST } from '@/app/api/v1/agentbook-housing/opportunities/route';

beforeEach(() => {
  requireStudentAddon.mockReset();
  opportunityCreate.mockReset();
  isUrlLive.mockReset();
  requireStudentAddon.mockResolvedValue({ tenantId: 'tenant-1' });
  opportunityCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'listing-1', ...data }));
  isUrlLive.mockResolvedValue(true);
});

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://x/opportunities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Housing has no discovery/search pipeline (listings are manually pasted by
// the student) — the equivalent "same validation" ask is confirming the
// pasted link actually resolves before the listing is saved.
describe('POST /api/v1/agentbook-housing/opportunities — link validation', () => {
  it('saves a listing whose sourceUrl resolves', async () => {
    const res = await POST(postReq({ title: 'Nice apartment', sourceUrl: 'https://example.com/listing' }));
    expect(res.status).toBe(201);
    expect(isUrlLive).toHaveBeenCalledWith('https://example.com/listing');
    expect(opportunityCreate).toHaveBeenCalled();
  });

  it('rejects with 422 when the pasted link does not resolve, without saving anything', async () => {
    isUrlLive.mockResolvedValue(false);
    const res = await POST(postReq({ title: 'Nice apartment', sourceUrl: 'https://example.com/404' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(opportunityCreate).not.toHaveBeenCalled();
  });

  it('does not call isUrlLive or block saving when no sourceUrl is given', async () => {
    const res = await POST(postReq({ title: 'Word-of-mouth listing, no link yet' }));
    expect(res.status).toBe(201);
    expect(isUrlLive).not.toHaveBeenCalled();
    expect(opportunityCreate).toHaveBeenCalled();
  });
});
