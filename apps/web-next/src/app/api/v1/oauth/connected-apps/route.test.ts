import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockCookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: mockCookieGet }),
}));

const mockValidateSession = vi.fn();
vi.mock('@/lib/api/auth', () => ({
  validateSession: (token: string) => mockValidateSession(token),
}));

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockOidcModelFindMany = vi.fn();
const mockRevokeByGrantId = vi.fn();
const mockDestroy = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    mcpConsentGrant: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    oidcModel: {
      findMany: (...args: unknown[]) => mockOidcModelFindMany(...args),
    },
  },
  PrismaOidcAdapter: class {
    revokeByGrantId(...args: unknown[]) {
      return mockRevokeByGrantId(...args);
    }
    destroy(...args: unknown[]) {
      return mockDestroy(...args);
    }
  },
}));

// Imported after the mocks above so the route picks up the mocked modules.
const { GET, DELETE } = await import('./route');

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/oauth/connected-apps', () => {
  it('returns 401 when there is no valid session', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const res = await GET();

    expect(res.status).toBe(401);
  });

  it('lists the caller\'s non-revoked grants with resolved client names', async () => {
    mockCookieGet.mockReturnValue({ value: 'tok' });
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockFindMany.mockResolvedValue([
      { clientId: 'client-a', scope: 'agentbook:full', grantedAt: new Date('2026-01-01') },
    ]);
    mockOidcModelFindMany.mockResolvedValue([
      { id: 'client-a', payload: { client_name: 'Claude Desktop' } },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      {
        clientId: 'client-a',
        clientName: 'Claude Desktop',
        scope: 'agentbook:full',
        grantedAt: new Date('2026-01-01').toISOString(),
      },
    ]);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
    );
  });

  it('falls back to the raw clientId when no registered client name is found', async () => {
    mockCookieGet.mockReturnValue({ value: 'tok' });
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockFindMany.mockResolvedValue([
      { clientId: 'client-b', scope: 'agentbook:full', grantedAt: new Date('2026-01-01') },
    ]);
    mockOidcModelFindMany.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();

    expect(body.data[0].clientName).toBe('client-b');
  });
});

describe('DELETE /api/v1/oauth/connected-apps', () => {
  function makeRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/v1/oauth/connected-apps', {
      method: 'DELETE',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('returns 401 when there is no valid session', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const res = await DELETE(makeRequest({ clientId: 'client-a' }));

    expect(res.status).toBe(401);
  });

  it('returns 404 when the caller has no grant for the given client', async () => {
    mockCookieGet.mockReturnValue({ value: 'tok' });
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockFindUnique.mockResolvedValue(null);

    const res = await DELETE(makeRequest({ clientId: 'client-a' }));

    expect(res.status).toBe(404);
  });

  it('revokes the consent record and immediately invalidates outstanding tokens via revokeByGrantId + destroy', async () => {
    mockCookieGet.mockReturnValue({ value: 'tok' });
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockFindUnique.mockResolvedValue({ id: 'consent-1', userId: 'user-1', clientId: 'client-a' });
    mockOidcModelFindMany.mockResolvedValue([{ id: 'grant-xyz' }]);
    mockRevokeByGrantId.mockResolvedValue(undefined);
    mockDestroy.mockResolvedValue(undefined);

    const res = await DELETE(makeRequest({ clientId: 'client-a' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'consent-1' },
      data: { revokedAt: expect.any(Date) },
    });
    // Real, immediate token invalidation: every grant-bound token row for
    // this Grant id is swept, and the Grant's own row is destroyed too (it
    // isn't touched by revokeByGrantId since it carries no grantId field of
    // its own).
    expect(mockRevokeByGrantId).toHaveBeenCalledWith('grant-xyz');
    expect(mockDestroy).toHaveBeenCalledWith('grant-xyz');
  });

  it('rejects a request with no clientId', async () => {
    mockCookieGet.mockReturnValue({ value: 'tok' });
    mockValidateSession.mockResolvedValue({ id: 'user-1' });

    const res = await DELETE(makeRequest({}));

    expect(res.status).toBe(400);
  });

  it('does NOT mark the consent record revoked and returns an error when token destruction throws partway through', async () => {
    // Regression test for the non-atomic ordering bug: the original
    // implementation marked mcpConsentGrant revoked BEFORE destroying the
    // underlying oidc-provider tokens, so a failure here would leave the UI
    // showing "revoked" while the real bearer/refresh tokens stayed live.
    // The fix reorders this so destruction happens first and is confirmed
    // before the consent record is ever touched.
    mockCookieGet.mockReturnValue({ value: 'tok' });
    mockValidateSession.mockResolvedValue({ id: 'user-1' });
    mockFindUnique.mockResolvedValue({ id: 'consent-1', userId: 'user-1', clientId: 'client-a' });
    mockOidcModelFindMany.mockResolvedValue([{ id: 'grant-xyz' }]);
    mockRevokeByGrantId.mockResolvedValue(undefined);
    mockDestroy.mockRejectedValue(new Error('db hiccup mid-destroy'));

    const res = await DELETE(makeRequest({ clientId: 'client-a' }));
    const body = await res.json();

    expect(res.status).not.toBe(200);
    expect(body).not.toEqual({ success: true });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
