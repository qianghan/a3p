import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({
  prisma: { featureFlag: { findUnique: vi.fn() } },
}));

import { prisma } from '@naap/database';
import { isMcpEnabled, MCP_FLAG_KEY } from './mcp-flag';

describe('isMcpEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when no flag row exists (safe default: off)', async () => {
    (prisma.featureFlag.findUnique as any).mockResolvedValue(null);
    expect(await isMcpEnabled()).toBe(false);
    expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({ where: { key: MCP_FLAG_KEY } });
  });

  it('returns the stored enabled value when a row exists', async () => {
    (prisma.featureFlag.findUnique as any).mockResolvedValue({ enabled: true });
    expect(await isMcpEnabled()).toBe(true);
  });
});
