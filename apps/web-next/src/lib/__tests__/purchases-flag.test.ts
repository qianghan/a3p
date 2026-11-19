// @vitest-environment node
/** PR 3bc.10 — per-tenant rollout of `purchases_at_entry`; at_entry is for accrual tenants only (R-AP-1, R-AP-3). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
const findUnique = vi.fn();
let lookupFails = false;
vi.mock('@naap/database', () => ({ prisma: { featureFlag: { findUnique: async (...a: unknown[]) => { if (lookupFails) throw new Error('db down'); return findUnique(...a); } } } }));

import { isPurchasesAtEntryEnabled, flagAllowsTenant, purchasesAtEntryApplies } from '../purchases-flag';

beforeEach(() => { findUnique.mockReset(); lookupFails = false; });

describe('flagAllowsTenant', () => {
  it('global enabled → every tenant', () => {
    expect(flagAllowsTenant({ enabled: true, metadata: null }, 't9')).toBe(true);
  });
  it('disabled with an allowlist → only listed tenants', () => {
    const row = { enabled: false, metadata: { tenantIds: ['t1', 't2'] } };
    expect([flagAllowsTenant(row, 't1'), flagAllowsTenant(row, 't2'), flagAllowsTenant(row, 't3')]).toEqual([true, true, false]);
  });
  it('fail-closed: missing row, junk metadata, no tenant', () => {
    expect(flagAllowsTenant(null, 't1')).toBe(false);
    expect(flagAllowsTenant({ enabled: false, metadata: { tenantIds: 't1' } }, 't1')).toBe(false);
    expect(flagAllowsTenant({ enabled: false, metadata: 'x' }, 't1')).toBe(false);
    expect(flagAllowsTenant({ enabled: false, metadata: { tenantIds: ['t1'] } }, undefined)).toBe(false);
  });
});

describe('isPurchasesAtEntryEnabled', () => {
  it('reads the row and applies the allowlist', async () => {
    findUnique.mockResolvedValue({ enabled: false, metadata: { tenantIds: ['t1'] } });
    expect([await isPurchasesAtEntryEnabled('t1'), await isPurchasesAtEntryEnabled('t2')]).toEqual([true, false]);
  });
  it('lookup error → off', async () => {
    lookupFails = true;
    expect(await isPurchasesAtEntryEnabled('t1')).toBe(false);
  });
});

describe('purchasesAtEntryApplies', () => {
  it('accrual tenant with the flag → true; cash-basis tenant → false even when flagged; no config → false', async () => {
    findUnique.mockResolvedValue({ enabled: true, metadata: null });
    expect(await purchasesAtEntryApplies('t1', { accountingBasis: 'accrual' })).toBe(true);
    expect(await purchasesAtEntryApplies('t1', { accountingBasis: 'cash' })).toBe(false);
    expect(await purchasesAtEntryApplies('t1', null)).toBe(false);
  });
  it('accrual tenant without the flag → false', async () => {
    findUnique.mockResolvedValue({ enabled: false, metadata: { tenantIds: ['other'] } });
    expect(await purchasesAtEntryApplies('t1', { accountingBasis: 'accrual' })).toBe(false);
  });
});
