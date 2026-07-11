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
vi.mock('@/lib/mcp/oauth-provider', () => ({
  getOAuthProvider: () => ({ interactionDetails: mockInteractionDetails }),
}));

vi.mock('@/lib/mcp/node-web-adapter', () => ({
  nodeRequestResponseFromWeb: async () => ({ nodeReq: {}, nodeRes: {} }),
}));

const mockFindUnique = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { mcpConsentGrant: { findUnique: (...args: unknown[]) => mockFindUnique(...args) } },
}));

const { GET } = await import('./route');

function makeRequest(cookieValue?: string): NextRequest {
  const req = new NextRequest('http://localhost/api/v1/oauth/interaction?uid=abc');
  if (cookieValue) req.cookies.set('naap_auth_token', cookieValue);
  return req;
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/oauth/interaction (Finding 1: flag must gate the consent flow too)', () => {
  it('returns a clean 503 when MCP is disabled, without touching auth or oidc-provider', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    const res = await GET(makeRequest('tok'));
    expect(res.status).toBe(503);
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(mockInteractionDetails).not.toHaveBeenCalled();
  });

  it('still requires authentication when MCP is enabled', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns interaction details for an authenticated user when MCP is enabled', async () => {
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockInteractionDetails.mockResolvedValue({ params: { client_id: 'client-a' } });
    mockFindUnique.mockResolvedValue(null);

    const res = await GET(makeRequest('tok'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ clientId: 'client-a', alreadyGranted: false });
  });
});
