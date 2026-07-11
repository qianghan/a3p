import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./index', () => ({
  prisma: {
    oidcModel: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from './index';
import { PrismaOidcAdapter } from './oidc-adapter';

describe('PrismaOidcAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upsert stores the payload under (type, id) with expiresAt derived from expiresIn', async () => {
    const adapter = new PrismaOidcAdapter('AccessToken');
    const now = Date.now();
    await adapter.upsert('token-123', { foo: 'bar' }, 3600);

    expect(prisma.oidcModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type_id: { type: 'AccessToken', id: 'token-123' } },
        create: expect.objectContaining({
          type: 'AccessToken',
          id: 'token-123',
          payload: { foo: 'bar' },
        }),
      })
    );
    const call = (prisma.oidcModel.upsert as any).mock.calls[0][0];
    const storedExpiry = call.create.expiresAt.getTime();
    expect(storedExpiry).toBeGreaterThan(now + 3500 * 1000);
    expect(storedExpiry).toBeLessThan(now + 3700 * 1000);
  });

  it('find returns null for a missing or expired record', async () => {
    (prisma.oidcModel.findFirst as any).mockResolvedValue(null);
    const adapter = new PrismaOidcAdapter('AccessToken');
    const result = await adapter.find('missing-id');
    expect(result).toBeUndefined();
  });

  it('find returns the stored payload for a live record', async () => {
    (prisma.oidcModel.findFirst as any).mockResolvedValue({ payload: { foo: 'bar' } });
    const adapter = new PrismaOidcAdapter('AccessToken');
    const result = await adapter.find('token-123');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('consume merges a consumed timestamp into the existing payload instead of overwriting it', async () => {
    (prisma.oidcModel.findUnique as any).mockResolvedValue({
      payload: { foo: 'bar', accountId: 'acct-1', grantId: 'grant-1' },
    });
    const adapter = new PrismaOidcAdapter('AuthorizationCode');
    await adapter.consume('code-123');

    expect(prisma.oidcModel.findUnique).toHaveBeenCalledWith({
      where: { type_id: { type: 'AuthorizationCode', id: 'code-123' } },
    });

    const call = (prisma.oidcModel.updateMany as any).mock.calls[0][0];
    expect(call.where).toEqual({ type: 'AuthorizationCode', id: 'code-123' });
    expect(call.data.payload).toEqual(
      expect.objectContaining({ foo: 'bar', accountId: 'acct-1', grantId: 'grant-1' })
    );
    expect(typeof call.data.payload.consumed).toBe('number');
  });

  it('consume is a no-op when the record does not exist', async () => {
    (prisma.oidcModel.findUnique as any).mockResolvedValue(null);
    const adapter = new PrismaOidcAdapter('AuthorizationCode');
    await adapter.consume('missing-id');
    expect(prisma.oidcModel.updateMany).not.toHaveBeenCalled();
  });

  it('findByUserCode returns undefined for an expired record', async () => {
    (prisma.oidcModel.findFirst as any).mockResolvedValue(null);
    const adapter = new PrismaOidcAdapter('DeviceCode');
    const result = await adapter.findByUserCode('expired-user-code');
    expect(result).toBeUndefined();
    expect(prisma.oidcModel.findFirst).toHaveBeenCalledWith({
      where: {
        type: 'DeviceCode',
        userCode: 'expired-user-code',
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
    });
  });

  it('findByUid returns undefined for an expired record', async () => {
    (prisma.oidcModel.findFirst as any).mockResolvedValue(null);
    const adapter = new PrismaOidcAdapter('Session');
    const result = await adapter.findByUid('expired-uid');
    expect(result).toBeUndefined();
    expect(prisma.oidcModel.findFirst).toHaveBeenCalledWith({
      where: {
        type: 'Session',
        uid: 'expired-uid',
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
    });
  });
});
