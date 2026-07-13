import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockIsMcpEnabled = vi.fn(async () => true);
vi.mock('@/lib/mcp/mcp-flag', () => ({
  isMcpEnabled: () => mockIsMcpEnabled(),
}));

const mockValidateSession = vi.fn();
vi.mock('@/lib/api/auth', () => ({
  validateSession: (token: string) => mockValidateSession(token),
}));

const mockInteractionDetails = vi.fn();
const mockInteractionResult = vi.fn();
const mockGrantFind = vi.fn();

class MockGrant {
  addOIDCScope = vi.fn();
  save = vi.fn(async () => 'grant-new-id');
  constructor(public opts: unknown) {}
}

vi.mock('@/lib/mcp/oauth-provider', () => ({
  getOAuthProvider: () => ({
    interactionDetails: mockInteractionDetails,
    interactionResult: mockInteractionResult,
    Grant: Object.assign(MockGrant, { find: mockGrantFind }),
  }),
}));

vi.mock('@/lib/mcp/node-web-adapter', () => ({
  nodeRequestResponseFromWeb: async () => ({
    nodeReq: {},
    nodeRes: { getHeaders: () => ({}) },
  }),
}));

const mockUpsert = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { mcpConsentGrant: { upsert: (...args: unknown[]) => mockUpsert(...args) } },
}));

const { POST } = await import('./route');

function makeRequest(body: unknown, opts: { cookie?: string; csrf?: string } = {}): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.csrf) headers['X-CSRF-Token'] = opts.csrf;
  const req = new NextRequest('http://localhost/api/v1/oauth/consent-decision', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (opts.cookie) req.cookies.set('naap_auth_token', opts.cookie);
  return req;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('POST /api/v1/oauth/consent-decision (Finding 1: flag) + (Finding 4: CSRF)', () => {
  it('returns a clean 503 when MCP is disabled, without touching auth/CSRF/oidc-provider', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    const res = await POST(makeRequest({ uid: 'u1', allow: true }, { cookie: 'tok', csrf: 'a-valid-token' }));
    expect(res.status).toBe(503);
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(mockInteractionDetails).not.toHaveBeenCalled();
  });

  it('returns 401 with no session cookie at all, before any CSRF check', async () => {
    const res = await POST(makeRequest({ uid: 'u1', allow: true }));
    expect(res.status).toBe(401);
  });

  it('rejects a cookie-authenticated request with no X-CSRF-Token header (production CSRF enforcement)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(makeRequest({ uid: 'u1', allow: true }, { cookie: 'tok' }));
    expect(res.status).toBe(403);
    // Must fail before ever reaching session validation / oidc-provider.
    expect(mockValidateSession).not.toHaveBeenCalled();
  });

  it('rejects a cookie-authenticated request with a malformed X-CSRF-Token (too short)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(makeRequest({ uid: 'u1', allow: true }, { cookie: 'tok', csrf: 'short' }));
    expect(res.status).toBe(403);
  });

  it('proceeds to record consent when the CSRF token is present and well-formed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockInteractionDetails.mockResolvedValue({ params: { client_id: 'client-a' }, grantId: undefined });
    mockInteractionResult.mockResolvedValue('/api/v1/oauth/authorize?resume=xyz');

    const res = await POST(
      makeRequest({ uid: 'u1', allow: true }, { cookie: 'tok', csrf: 'a-well-formed-csrf-token' }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.redirectTo).toBe('/api/v1/oauth/authorize?resume=xyz');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_clientId: { userId: 'user-1', clientId: 'client-a' } } }),
    );
  });
});
