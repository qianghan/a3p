import { describe, it, expect, vi, beforeEach } from 'vitest';
import { billingApi } from '../lib/api';

describe('billingApi.listPlans / listAllPlans', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listPlans (used by the tenant-facing PlanGrid) hits the plain, non-admin-gated route', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ plans: [] }),
    });

    await billingApi.listPlans();

    // Regression guard: this endpoint must NOT carry `?all=true` — that
    // query param is gated behind requireAdmin() and 403s for ordinary
    // tenants. A prior fix pointed the (then-shared) listPlans() at that
    // gated route to fix the admin screen, which broke /billing for every
    // non-admin tenant; listAllPlans() below is the admin-only escape hatch.
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/agentbook-billing/plans');
  });

  it('listAllPlans (used by the admin PlanList) hits the `?all=true` admin-gated route', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ plans: [] }),
    });

    await billingApi.listAllPlans();

    expect(global.fetch).toHaveBeenCalledWith('/api/v1/agentbook-billing/plans?all=true');
  });
});
