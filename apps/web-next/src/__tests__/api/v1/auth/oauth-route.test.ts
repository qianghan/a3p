import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const getOAuthUrlFn = vi.fn();
const generateCSRFTokenFn = vi.fn();

vi.mock('@/lib/api/auth', () => ({
  getOAuthUrl: (...a: unknown[]) => getOAuthUrlFn(...a),
  generateCSRFToken: (...a: unknown[]) => generateCSRFTokenFn(...a),
}));

import { GET } from '@/app/api/v1/auth/oauth/[provider]/route';

function req(url: string): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  getOAuthUrlFn.mockReset();
  generateCSRFTokenFn.mockReset();
  generateCSRFTokenFn.mockReturnValue('state123');
  getOAuthUrlFn.mockReturnValue('https://accounts.google.com/o/oauth2/authorize?state=state123');
});

describe('GET /api/v1/auth/oauth/[provider] — oauth_standalone cookie lifecycle', () => {
  it('sets oauth_standalone=1 when standalone=1 is requested', async () => {
    const res = await GET(req('http://x/api/v1/auth/oauth/google?standalone=1'), {
      params: Promise.resolve({ provider: 'google' }),
    });
    const setCookie = res.cookies.get('oauth_standalone');
    expect(setCookie?.value).toBe('1');
  });

  it('explicitly clears oauth_standalone when standalone is not requested, so a stale cookie from an earlier abandoned attempt cannot misroute this sign-in', async () => {
    const res = await GET(req('http://x/api/v1/auth/oauth/google'), {
      params: Promise.resolve({ provider: 'google' }),
    });
    const setCookie = res.cookies.get('oauth_standalone');
    expect(setCookie?.value).toBe('');
    expect(setCookie?.maxAge).toBe(0);
  });

  it('always sets oauth_state regardless of standalone', async () => {
    const res = await GET(req('http://x/api/v1/auth/oauth/google'), {
      params: Promise.resolve({ provider: 'google' }),
    });
    expect(res.cookies.get('oauth_state')?.value).toBe('state123');
  });
});
