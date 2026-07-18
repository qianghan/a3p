import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const handleOAuthCallbackFn = vi.fn();
vi.mock('@/lib/api/auth', () => ({
  handleOAuthCallback: (...a: unknown[]) => handleOAuthCallbackFn(...a),
}));

import { GET } from '@/app/api/v1/auth/callback/[provider]/route';

function req(url: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(url);
  for (const [k, v] of Object.entries(cookies)) request.cookies.set(k, v);
  return request;
}

beforeEach(() => {
  handleOAuthCallbackFn.mockReset();
  handleOAuthCallbackFn.mockResolvedValue({
    token: 'tok123',
    user: { id: 'u1' },
    expiresAt: new Date('2026-08-01'),
  });
});

describe('GET /api/v1/auth/callback/[provider] — standalone-aware redirect', () => {
  it('redirects straight to /agentbook when oauth_standalone cookie is absent', async () => {
    const request = req('http://x/api/v1/auth/callback/google?code=abc&state=s1', {
      oauth_state: 's1',
    });
    const res = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/agentbook');
  });

  it('redirects to the /signed-in interstitial when oauth_standalone cookie is present', async () => {
    const request = req('http://x/api/v1/auth/callback/google?code=abc&state=s1', {
      oauth_state: 's1',
      oauth_standalone: '1',
    });
    const res = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/signed-in');
  });

  it('clears both oauth_state and oauth_standalone cookies when standalone', async () => {
    const request = req('http://x/api/v1/auth/callback/google?code=abc&state=s1', {
      oauth_state: 's1',
      oauth_standalone: '1',
    });
    const res = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('naap_auth_token=tok123');
    // Both cookies should be cleared (maxAge=0 -> Max-Age=0 in the header)
    const allCookies = res.cookies.getAll();
    const oauthState = allCookies.find((c) => c.name === 'oauth_state');
    const oauthStandalone = allCookies.find((c) => c.name === 'oauth_standalone');
    expect(oauthState?.value).toBe('');
    expect(oauthStandalone?.value).toBe('');
  });

  it('does not set an oauth_standalone clearing cookie when it was never present', async () => {
    const request = req('http://x/api/v1/auth/callback/google?code=abc&state=s1', {
      oauth_state: 's1',
    });
    const res = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    const allCookies = res.cookies.getAll();
    const oauthStandalone = allCookies.find((c) => c.name === 'oauth_standalone');
    expect(oauthStandalone).toBeUndefined();
  });
});
