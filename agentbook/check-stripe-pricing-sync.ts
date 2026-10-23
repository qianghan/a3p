/**
 * READ-ONLY price reconciliation: code (@agentbook/pricing) vs database vs the live Stripe Price objects.
 * Writes nothing anywhere: Stripe calls are GET prices.retrieve only, database calls are findMany only.
 *
 * Why it exists: checkout charges the Stripe Price behind row.stripePriceId, whose amount is immutable, and the
 * activate-*-pricing scripts skip rows that already have an id. So editing a price in code never reaches Stripe
 * on its own, and nothing else in the repo detects the gap. See agentbook/pricing-sync-lib.ts.
 *
 * Usage (your own shell; the key is read from the environment and never printed or written to disk):
 *   DATABASE_URL=... STRIPE_SECRET_KEY=rk_live_... npx tsx agentbook/check-stripe-pricing-sync.ts
 * Exit code: 0 only if every row is OK.
 */
import Stripe from 'stripe';
import { prisma } from '@naap/database';
import { CORE_PLANS, ADDON_PRICES } from '@agentbook/pricing';
import { classifyRow, remediation, summarize, type Interval, type StripePrice, type SyncStatus } from './pricing-sync-lib';

/** Add-on billing intervals (the code table has amounts only). personal_insights bills monthly; the rest yearly. */
const addOnInterval = (code: string): Interval => (code === 'personal_insights' ? 'month' : 'year');

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const stripe = new Stripe(key);
  console.log(`Stripe key mode: ${/^(sk|rk)_live_/.test(key) ? 'LIVE' : 'TEST (not the prices customers are charged)'}\n`);

  const cache = new Map<string, StripePrice | null>();
  const fetchPrice = async (id: string | null): Promise<StripePrice | null> => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id)!;
    let out: StripePrice | null = null;
    try {
      const p = await stripe.prices.retrieve(id);
      out = {
        cents: p.unit_amount ?? -1,
        currency: p.currency,
        interval: (p.recurring?.interval === 'year' ? 'year' : 'month') as Interval,
        active: p.active,
      };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404 && (e as { code?: string }).code !== 'resource_missing') throw e;
    }
    cache.set(id, out);
    return out;
  };

  const results: Array<{ label: string; status: SyncStatus; detail: string }> = [];

  const plans = await prisma.billPlan.findMany({ where: { isActive: true } });
  for (const w of CORE_PLANS) {
    const row = plans.find((p) => p.code === w.code && p.region === w.region);
    const stripeP = row ? await fetchPrice(row.stripePriceId) : null;
    const input = {
      label: `plan ${w.code} [${w.region}]`,
      want: { cents: w.priceCents, currency: w.currency, interval: w.interval as Interval },
      db: row ? { cents: row.priceCents, currency: row.currency, interval: row.interval as Interval, stripePriceId: row.stripePriceId, isActive: row.isActive } : null,
      stripe: stripeP,
    };
    const status = classifyRow(input);
    const fmt = (m: { cents: number; currency: string; interval: string } | null) => (m ? `${(m.cents / 100).toFixed(2)} ${m.currency.toUpperCase()}/${m.interval}` : 'none');
    results.push({ label: input.label, status, detail: `code ${fmt(input.want)} | db ${fmt(input.db)} | stripe ${fmt(input.stripe)}` });
  }

  const addOns = await prisma.billAddOn.findMany({ where: { isActive: true }, include: { prices: { where: { isActive: true } } } });
  for (const [code, tiers] of Object.entries(ADDON_PRICES)) {
    const addOn = addOns.find((a) => a.code === code);
    for (const w of tiers) {
      const row = addOn?.prices.find((p) => p.region === w.region && p.tier === w.tier);
      const stripeP = row ? await fetchPrice(row.stripePriceId) : null;
      const interval = (addOn?.interval === 'month' ? 'month' : addOn ? 'year' : addOnInterval(code)) as Interval;
      const input = {
        label: `add-on ${code} [${w.region}/${w.tier}]`,
        want: { cents: w.priceCents, currency: w.currency, interval: addOnInterval(code) },
        db: row ? { cents: row.priceCents, currency: row.currency, interval, stripePriceId: row.stripePriceId, isActive: row.isActive } : null,
        stripe: stripeP,
      };
      const status = classifyRow(input);
      const fmt = (m: { cents: number; currency: string; interval: string } | null) => (m ? `${(m.cents / 100).toFixed(2)} ${m.currency.toUpperCase()}/${m.interval}` : 'none');
      results.push({ label: input.label, status, detail: `code ${fmt(input.want)} | db ${fmt(input.db)} | stripe ${fmt(input.stripe)}` });
    }
  }

  for (const r of results) console.log(`${r.status === 'OK' ? 'OK  ' : 'FIX '} ${r.label.padEnd(46)} ${r.status.padEnd(16)} ${r.detail}`);
  const { counts, clean } = summarize(results.map((r) => r.status));
  console.log('\nSummary:', JSON.stringify(counts));
  const todo = [...new Set(results.filter((r) => r.status !== 'OK').map((r) => r.status))];
  if (todo.length) {
    console.log('\nWhat to do:');
    for (const s of todo) console.log(`  ${s}: ${remediation(s)}`);
  }
  console.log(clean ? '\nIN SYNC: code, database and Stripe agree on every price.' : '\nNOT IN SYNC.');
  process.exitCode = clean ? 0 : 1;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); }).finally(() => prisma.$disconnect());
