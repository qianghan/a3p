import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const registerFn = vi.fn();
const rateLimitFn = vi.fn();

vi.mock('@/lib/api/auth', () => ({
  register: (...a: unknown[]) => registerFn(...a),
}));

vi.mock('@/lib/api/rate-limit', () => ({
  enforceRateLimit: (...a: unknown[]) => rateLimitFn(...a),
}));

import { POST } from '@/app/api/v1/auth/register/route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  registerFn.mockReset();
  rateLimitFn.mockReset();
  rateLimitFn.mockReturnValue(null); // no rate limiting in tests
  registerFn.mockResolvedValue(undefined);
});

describe('POST /api/v1/auth/register — age-attestation gate', () => {
  it('400s when ageConfirmed is missing entirely', async () => {
    const res = await POST(req({ email: 'a@example.com', password: 'password123' }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toMatch(/18 years old/i);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it('400s when ageConfirmed is explicitly false', async () => {
    const res = await POST(req({ email: 'a@example.com', password: 'password123', ageConfirmed: false }));
    expect(res.status).toBe(400);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it('400s when ageConfirmed is a truthy non-boolean (e.g. the string "true")', async () => {
    // Strict `!== true` check — a client sending the string "true" instead of
    // the boolean must not slip through.
    const res = await POST(req({ email: 'a@example.com', password: 'password123', ageConfirmed: 'true' }));
    expect(res.status).toBe(400);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it('succeeds when ageConfirmed is true and email/password are present', async () => {
    const res = await POST(req({ email: 'a@example.com', password: 'password123', displayName: 'A', ageConfirmed: true }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(registerFn).toHaveBeenCalledWith('a@example.com', 'password123', 'A', undefined);
  });

  it('still 400s on missing email/password before the age check runs', async () => {
    const res = await POST(req({ ageConfirmed: true }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/Email and password/i);
    expect(registerFn).not.toHaveBeenCalled();
  });
});
