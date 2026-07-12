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
const mockOidcModelFindFirst = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    mcpConsentGrant: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
    oidcModel: { findFirst: (...args: unknown[]) => mockOidcModelFindFirst(...args) },
  },
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

  it('returns interaction details for an authenticated user when MCP is enabled, falling back to the raw client id if no friendly name is registered', async () => {
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockInteractionDetails.mockResolvedValue({ params: { client_id: 'client-a' } });
    mockFindUnique.mockResolvedValue(null);
    mockOidcModelFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest('tok'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ clientId: 'client-a', clientName: 'client-a', alreadyGranted: false });
  });

  it('surfaces the DCR-registered client_name so the consent screen shows a real app name, not the opaque client id', async () => {
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockInteractionDetails.mockResolvedValue({ params: { client_id: 'client-a' } });
    mockFindUnique.mockResolvedValue(null);
    mockOidcModelFindFirst.mockResolvedValue({ payload: { client_name: 'Claude Desktop' } });

    const res = await GET(makeRequest('tok'));
    const body = await res.json();

    expect(mockOidcModelFindFirst).toHaveBeenCalledWith({ where: { type: 'Client', id: 'client-a' } });
    expect(body).toEqual({ clientId: 'client-a', clientName: 'Claude Desktop', alreadyGranted: false });
  });
});
