import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const findAccessToken = vi.fn();
vi.mock('./oauth-provider', () => ({
  getOAuthProvider: () => ({
    AccessToken: { find: findAccessToken },
  }),
}));

import { authenticateMcpRequest } from './authenticate-mcp-request';

describe('authenticateMcpRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 with WWW-Authenticate when no bearer token is present', async () => {
    const request = new NextRequest('http://localhost/api/v1/mcp');
    const result = await authenticateMcpRequest(request);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
      expect(result.error.headers.get('WWW-Authenticate')).toContain('invalid_token');
    }
  });

  it('returns 401 when the token is not found or expired', async () => {
    findAccessToken.mockResolvedValue(undefined);
    const request = new NextRequest('http://localhost/api/v1/mcp', {
      headers: { authorization: 'Bearer bad-token' },
    });
    const result = await authenticateMcpRequest(request);
    expect('error' in result).toBe(true);
  });

  it('resolves userId/tenantId/clientId for a valid token (tenantId === userId per current 1:1 model)', async () => {
    findAccessToken.mockResolvedValue({ accountId: 'user-1', clientId: 'client-abc' });
    const request = new NextRequest('http://localhost/api/v1/mcp', {
      headers: { authorization: 'Bearer good-token' },
    });
    const result = await authenticateMcpRequest(request);
    expect(result).toEqual({ userId: 'user-1', tenantId: 'user-1', clientId: 'client-abc' });
  });

  it('resolves with a clean 503 error (not a thrown/unhandled rejection) when AccessToken.find rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    findAccessToken.mockRejectedValue(new Error('connection refused'));
    const request = new NextRequest('http://localhost/api/v1/mcp', {
      headers: { authorization: 'Bearer some-token' },
    });

    const result = await authenticateMcpRequest(request);

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(503);
      const body = await result.error.clone().json();
      expect(body.error.code).toBe('temporarily_unavailable');
      expect(JSON.stringify(body)).not.toContain('connection refused');
    }
    consoleErrorSpy.mockRestore();
  });
});
