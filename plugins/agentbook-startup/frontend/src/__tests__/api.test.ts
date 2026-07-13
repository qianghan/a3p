import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startupApi } from '../lib/api';

describe('startupApi add-on checkout methods', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('getAddOnIntent posts to the billing subscription intent route and returns the client secret', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ clientSecret: 'seti_123_secret_abc', customerId: 'cus_1' }),
    });

    const result = await startupApi.getAddOnIntent();

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/agentbook-billing/me/subscription/intent',
      { method: 'POST' },
    );
    expect(result.clientSecret).toBe('seti_123_secret_abc');
  });

  it('getAddOnIntent throws with the response body on a non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'no customer; call /me/subscription/intent first',
    });

    await expect(startupApi.getAddOnIntent()).rejects.toThrow('no customer');
  });

  it('subscribeAddOn posts region + paymentMethodId to the startup_tax_benefits subscribe route', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, subscriptionId: 'sub_1', tier: 'founding_member' }),
    });

    await startupApi.subscribeAddOn('pm_test_123');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/agentbook-billing/me/addons/startup_tax_benefits/subscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: 'us', paymentMethodId: 'pm_test_123' }),
      },
    );
  });

  it('subscribeAddOn sends the given region instead of the default', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, subscriptionId: 'sub_1', tier: 'founding_member' }),
    });

    await startupApi.subscribeAddOn('pm_test_123', 'au');

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/agentbook-billing/me/addons/startup_tax_benefits/subscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: 'au', paymentMethodId: 'pm_test_123' }),
      },
    );
  });

  it('subscribeAddOn throws with the response body on a non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'subscribe failed',
    });

    await expect(startupApi.subscribeAddOn('pm_test_123')).rejects.toThrow('subscribe failed');
  });
});
