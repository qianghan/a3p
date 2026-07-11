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
});
