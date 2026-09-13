import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  addResourceScope = vi.fn();
  save = vi.fn(async () => 'grant-new-id');
  constructor(public opts: unknown) {}
}
// The instance the route actually used, so assertions read the real calls
// rather than a fresh mock.
let lastGrant: MockGrant | undefined;
class TrackedGrant extends MockGrant {
  constructor(opts: unknown) { super(opts); lastGrant = this; }
}

vi.mock('@/lib/mcp/oauth-provider', () => ({
  getOAuthProvider: () => ({
    interactionDetails: mockInteractionDetails,
    interactionResult: mockInteractionResult,
    Grant: Object.assign(TrackedGrant, { find: mockGrantFind }),
  }),
  MCP_SCOPE: 'agentbook:full',
  mcpResourceUrl: () => 'https://agentbook.test/api/v1/mcp',
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

  // The consent loop.
  //
  // A grant tracks OIDC scopes and RESOURCE-SERVER scopes separately
  // (oidc-provider models/grant.js), and the consent policy's
  // `rs_scopes_missing` check only looks at the latter. Granting the OIDC
  // scope alone satisfied nothing once the client sent an RFC 8707 `resource`,
  // which the MCP spec requires: pressing Allow resumed the authorization, the
  // policy found the resource scope still missing, and a brand-new interaction
  // put the same consent screen back on screen. Approving could never end it.
  describe('resource-server scopes', () => {
    beforeEach(() => {
      lastGrant = undefined;
      mockValidateSession.mockResolvedValue({ id: 'user-1' });
      mockInteractionResult.mockResolvedValue('/api/v1/oauth/authorize?resume=xyz');
    });

    const allow = () =>
      POST(makeRequest({ uid: 'u1', allow: true }, { cookie: 'tok', csrf: 'a-well-formed-csrf-token' }));

    it('grants the scope FOR THE RESOURCE, not only as an OIDC scope', async () => {
      mockInteractionDetails.mockResolvedValue({ params: { client_id: 'client-a' } });

      await allow();

      expect(lastGrant?.addResourceScope).toHaveBeenCalledWith(
        'https://agentbook.test/api/v1/mcp',
        'agentbook:full',
      );
      expect(lastGrant?.addOIDCScope).toHaveBeenCalledWith('agentbook:full');
    });

    it('does so even when the interaction lists nothing missing', async () => {
      // Resources are resolved when the authorization RESUMES, so the first
      // interaction can carry an empty prompt. Waiting for the prompt to name
      // the resource would just cost the user one more lap of the loop.
      mockInteractionDetails.mockResolvedValue({
        params: { client_id: 'client-a' },
        prompt: { name: 'consent', details: {} },
      });

      await allow();

      expect(lastGrant?.addResourceScope).toHaveBeenCalledWith(
        'https://agentbook.test/api/v1/mcp',
        'agentbook:full',
      );
    });

    it('also honours whatever the prompt does report as missing', async () => {
      mockInteractionDetails.mockResolvedValue({
        params: { client_id: 'client-a' },
        prompt: {
          name: 'consent',
          details: {
            missingResourceScopes: { 'https://other.example/api': ['read', 'write'] },
            missingOIDCScope: ['openid'],
          },
        },
      });

      await allow();

      expect(lastGrant?.addResourceScope).toHaveBeenCalledWith('https://other.example/api', 'read write');
      expect(lastGrant?.addOIDCScope).toHaveBeenCalledWith('openid');
    });

    it('grants nothing at all when the user denies', async () => {
      mockInteractionDetails.mockResolvedValue({ params: { client_id: 'client-a' } });

      await POST(makeRequest({ uid: 'u1', allow: false }, { cookie: 'tok', csrf: 'a-well-formed-csrf-token' }));

      expect(lastGrant).toBeUndefined();
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });
});
