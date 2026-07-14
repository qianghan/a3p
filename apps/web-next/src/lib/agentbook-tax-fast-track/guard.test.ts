import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const hasAddOnMock = vi.fn();
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: unknown[]) => hasAddOnMock(...args) }));

const safeResolveMock = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...args: unknown[]) => safeResolveMock(...args) }));

beforeEach(() => { vi.clearAllMocks(); });

describe('requireTaxFastTrackAddon', () => {
  it('returns the tenantId when the tenant has an active tax_fast_track add-on', async () => {
    safeResolveMock.mockResolvedValue({ tenantId: 'tenant-A' });
    hasAddOnMock.mockResolvedValue(true);
    const { requireTaxFastTrackAddon, TAX_FAST_TRACK_ADDON_CODE } = await import('./guard');

    const result = await requireTaxFastTrackAddon({} as any);

    expect(result).toEqual({ tenantId: 'tenant-A' });
    expect(hasAddOnMock).toHaveBeenCalledWith('tenant-A', TAX_FAST_TRACK_ADDON_CODE);
  });

  it('returns a 402 response when the tenant lacks the add-on', async () => {
    safeResolveMock.mockResolvedValue({ tenantId: 'tenant-B' });
    hasAddOnMock.mockResolvedValue(false);
    const { requireTaxFastTrackAddon } = await import('./guard');

    const result = await requireTaxFastTrackAddon({} as any);

    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(402);
      const body = await result.response.json();
      expect(body.error).toContain('paid add-on');
    }
  });

  it('short-circuits on a safeResolveAgentbookTenant failure without calling hasAddOn', async () => {
    const fakeResponse = { status: 401 };
    safeResolveMock.mockResolvedValue({ response: fakeResponse });
    const { requireTaxFastTrackAddon } = await import('./guard');

    const result = await requireTaxFastTrackAddon({} as any);

    expect(result).toEqual({ response: fakeResponse });
    expect(hasAddOnMock).not.toHaveBeenCalled();
  });
});
