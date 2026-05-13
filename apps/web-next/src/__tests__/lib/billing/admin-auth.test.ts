import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));

vi.mock('@/lib/api/auth', () => ({
  validateSession: vi.fn(),
}));

import { validateSession } from '@/lib/api/auth';
import { requireAdmin } from '@/lib/billing/admin-auth';
import { NextRequest } from 'next/server';

const mockSession = validateSession as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockSession.mockReset();
  process.env.ADMIN_EMAILS = 'admin@a3p.io,ops@a3p.io';
});

function req(token?: string): NextRequest {
  const r = new NextRequest('http://x/admin');
  if (token) r.cookies.set('naap_auth_token', token);
  return r;
}

describe('requireAdmin', () => {
  it('returns user when email is in ADMIN_EMAILS', async () => {
    mockSession.mockResolvedValue({ id: 'u1', email: 'admin@a3p.io' });
    const u = await requireAdmin(req('tok'));
    expect(u.email).toBe('admin@a3p.io');
  });

  it('throws 403 when email not in allowlist', async () => {
    mockSession.mockResolvedValue({ id: 'u1', email: 'maya@agentbook.test' });
    await expect(requireAdmin(req('tok'))).rejects.toMatchObject({ status: 403 });
  });

  it('throws 401 when no session token', async () => {
    await expect(requireAdmin(req())).rejects.toMatchObject({ status: 401 });
  });
});
