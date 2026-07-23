/**
 * Live Stripe activation for ALL add-on price rows — the batch backfill that
 * didn't exist (previously add-on stripePriceIds could only be attached one
 * row at a time via the admin route, so they were all null → every add-on
 * subscribe 400'd). Closes launch blocker C1 for add-ons.
 *
 * For each active BillAddOnPrice with a positive price and no stripePriceId:
 *   - ensure a live Stripe Product exists for its add-on (one per add-on, reused
 *     across that add-on's region/tier price rows),
 *   - create a live Stripe Price (currency, recurring interval from the add-on)
 *     with region/tier metadata,
 *   - attach the stripePriceId back to the row.
 *
 * Idempotent: rows that already have a stripePriceId are skipped. Requires a
 * LIVE Stripe key; refuses a test-mode key. Key read from env, never logged.
 *
 * Usage: STRIPE_SECRET_KEY=sk_live_… npx tsx agentbook/activate-addon-pricing.ts
 */
import Stripe from 'stripe';
import { prisma } from '@naap/database';

function requireLiveKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  if (!/^(sk|rk)_live_/.test(key)) {
    throw new Error('STRIPE_SECRET_KEY is not a live-mode key (sk_live_*/rk_live_*) — refusing to create test-mode products under a production activation script');
  }
  return key;
}

async function main() {
  const stripe = new Stripe(requireLiveKey());

  const rows = await prisma.billAddOnPrice.findMany({
    where: { isActive: true, priceCents: { gt: 0 } },
    include: { addOn: true },
    orderBy: [{ addOnId: 'asc' }, { region: 'asc' }, { tier: 'asc' }],
  });

  // One Stripe Product per add-on, reused across its price rows.
  const productByAddOn = new Map<string, string>();
  let created = 0, skipped = 0;

  for (const row of rows) {
    if (row.stripePriceId) {
      console.log(`  skip ${row.addOn.code} [${row.region}/${row.tier}] — already has stripePriceId`);
      skipped++;
      continue;
    }
    let productId = productByAddOn.get(row.addOnId);
    if (!productId) {
      const product = await stripe.products.create({
        name: row.addOn.name,
        metadata: { addOnCode: row.addOn.code },
      });
      productId = product.id;
      productByAddOn.set(row.addOnId, productId);
      console.log(`  product for ${row.addOn.code} -> ${productId}`);
    }
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: row.priceCents,
      currency: row.currency.toLowerCase(),
      recurring: { interval: (row.addOn.interval === 'month' ? 'month' : 'year') as 'month' | 'year' },
      metadata: { addOnCode: row.addOn.code, region: row.region, tier: row.tier },
    });
    await prisma.billAddOnPrice.update({ where: { id: row.id }, data: { stripePriceId: price.id } });
    console.log(`  created ${row.addOn.code} [${row.region}/${row.tier}] ${row.currency} ${(row.priceCents / 100).toFixed(2)} -> price=${price.id}`);
    created++;
  }

  console.log(`\nDone. created=${created}, skipped(existing)=${skipped}, add-ons=${productByAddOn.size}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
