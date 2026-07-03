import { prisma } from '@naap/database';
import { resolveAccountId } from './account-resolver.js';

export interface ResolvedAddOnPrice {
  id: string;
  tier: string;
  priceCents: number;
  currency: string;
  stripePriceId: string | null;
}

/**
 * Fail-closed entitlement check (mirrors checkQuota's G-022 property):
 * any error resolving the add-on or its subscription denies access
 * rather than granting it.
 */
export async function hasAddOn(tenantId: string, code: string): Promise<boolean> {
  try {
    const accountId = await resolveAccountId(tenantId);
    const addOn = await prisma.billAddOn.findUnique({ where: { code } });
    if (!addOn || !addOn.isActive) return false;
    const sub = await prisma.billAddOnSubscription.findUnique({
      where: { accountId_addOnId: { accountId, addOnId: addOn.id } },
    });
    return sub?.status === 'active';
  } catch (err) {
    console.error('[billing] hasAddOn failed, denying (fail-closed):', err);
    return false;
  }
}

/**
 * Pick which price tier a NEW subscriber should be offered for a given
 * region: founding_member while slots/time remain, else standard.
 * "scaled" is never auto-assigned — it's for a future admin-driven
 * upgrade flow once an account outgrows the bootstrap tiers.
 */
export async function resolveAddOnPrice(code: string, region: string): Promise<ResolvedAddOnPrice | null> {
  const addOn = await prisma.billAddOn.findUnique({ where: { code } });
  if (!addOn || !addOn.isActive) return null;

  const prices = await prisma.billAddOnPrice.findMany({
    where: { addOnId: addOn.id, region, isActive: true },
  });
  const founding = prices.find((p) => p.tier === 'founding_member');
  const standard = prices.find((p) => p.tier === 'standard');

  if (founding) {
    const now = new Date();
    const withinTime = !founding.availableUntil || now < founding.availableUntil;
    let withinSlots = true;
    if (founding.maxSlots !== null) {
      const taken = await prisma.billAddOnSubscription.count({ where: { priceId: founding.id } });
      withinSlots = taken < founding.maxSlots;
    }
    if (withinTime && withinSlots) {
      return { id: founding.id, tier: founding.tier, priceCents: founding.priceCents, currency: founding.currency, stripePriceId: founding.stripePriceId };
    }
  }

  if (standard) {
    return { id: standard.id, tier: standard.tier, priceCents: standard.priceCents, currency: standard.currency, stripePriceId: standard.stripePriceId };
  }

  return null;
}
