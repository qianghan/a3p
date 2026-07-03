import { describe, expect, it, vi, beforeEach } from 'vitest';

const addOnFindUnique = vi.fn();
const addOnSubFindUnique = vi.fn();
const priceFindMany = vi.fn();
const addOnSubCount = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billAddOn: { findUnique: (...a: unknown[]) => addOnFindUnique(...a) },
    billAddOnSubscription: {
      findUnique: (...a: unknown[]) => addOnSubFindUnique(...a),
      count: (...a: unknown[]) => addOnSubCount(...a),
    },
    billAddOnPrice: { findMany: (...a: unknown[]) => priceFindMany(...a) },
  },
}));

import { hasAddOn, resolveAddOnPrice } from '../src/addons.js';

const addOn = { id: 'addon-1', code: 'startup_tax_benefits', isActive: true };

beforeEach(() => {
  addOnFindUnique.mockReset();
  addOnSubFindUnique.mockReset();
  addOnSubCount.mockReset();
  priceFindMany.mockReset();
});

describe('hasAddOn', () => {
  it('returns false when the add-on code does not exist', async () => {
    addOnFindUnique.mockResolvedValue(null);
    expect(await hasAddOn('tenant-1', 'nonexistent')).toBe(false);
  });

  it('returns false when the account has no BillAddOnSubscription row', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    addOnSubFindUnique.mockResolvedValue(null);
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(false);
  });

  it('returns false when the subscription status is canceled', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    addOnSubFindUnique.mockResolvedValue({ status: 'canceled' });
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(false);
  });

  it('returns true when the subscription status is active', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    addOnSubFindUnique.mockResolvedValue({ status: 'active' });
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(true);
  });

  it('fails closed (returns false) on a database error', async () => {
    addOnFindUnique.mockRejectedValue(new Error('connection lost'));
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(false);
  });
});

describe('resolveAddOnPrice', () => {
  const founding = { id: 'price-founding', tier: 'founding_member', priceCents: 9900, currency: 'usd', stripePriceId: null, maxSlots: 250, availableUntil: null };
  const standard = { id: 'price-standard', tier: 'standard', priceCents: 24900, currency: 'usd', stripePriceId: null, maxSlots: null, availableUntil: null };

  it('returns the founding_member price when slots remain', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    priceFindMany.mockResolvedValue([founding, standard]);
    addOnSubCount.mockResolvedValue(10); // 10 of 250 taken
    const price = await resolveAddOnPrice('startup_tax_benefits', 'us');
    expect(price?.tier).toBe('founding_member');
    expect(price?.priceCents).toBe(9900);
  });

  it('falls back to standard once maxSlots is reached', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    priceFindMany.mockResolvedValue([founding, standard]);
    addOnSubCount.mockResolvedValue(250); // cap reached
    const price = await resolveAddOnPrice('startup_tax_benefits', 'us');
    expect(price?.tier).toBe('standard');
    expect(price?.priceCents).toBe(24900);
  });

  it('falls back to standard once availableUntil has passed', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    const expiredFounding = { ...founding, availableUntil: new Date('2020-01-01') };
    priceFindMany.mockResolvedValue([expiredFounding, standard]);
    addOnSubCount.mockResolvedValue(0);
    const price = await resolveAddOnPrice('startup_tax_benefits', 'us');
    expect(price?.tier).toBe('standard');
  });

  it('returns null when the add-on has no price row for the region', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    priceFindMany.mockResolvedValue([]);
    const price = await resolveAddOnPrice('startup_tax_benefits', 'de');
    expect(price).toBeNull();
  });
});
