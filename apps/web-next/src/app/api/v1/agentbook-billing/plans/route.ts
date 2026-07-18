import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { invalidateAll } from '@naap/billing';
import { getStripe } from '@/lib/billing/stripe';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

const PlanBody = z.object({
  code: z.string().regex(/^[a-z0-9_-]+$/),
  region: z.string().length(2),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
  interval: z.enum(['month', 'year']),
  features: z.object({
    telegram_bot: z.boolean(),
    tax_package_generation: z.boolean(),
    multi_user_teams: z.boolean(),
  }),
  quotas: z.object({
    expenses_created: z.number().int(),
    ocr_scans: z.number().int(),
    ai_messages: z.number().int(),
    invoices_sent: z.number().int(),
    bank_connections: z.number().int(),
  }),
  sortOrder: z.number().int().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const region = cfg?.jurisdiction || 'us';
  const plans = await prisma.billPlan.findMany({
    where: { isActive: true, region },
    orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
  });
  return NextResponse.json({ plans });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  const parsed = PlanBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  const stripe = getStripe();
  let productId: string | null = null;
  try {
    const product = await stripe.products.create({ name: body.name, metadata: { code: body.code } });
    productId = product.id;
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: body.priceCents,
      currency: body.currency,
      recurring: { interval: body.interval },
    });
    // `code` is no longer globally unique (see @@unique([code, region])) — a
    // plain `create` is sufficient here since this route always creates a
    // brand-new row. Any FUTURE upsert-style admin action against this table
    // must use the compound key `where: { code_region: { code, region } }`,
    // not `where: { code } }` (see agentbook/seed-billing-plans.ts for the
    // pattern this route's own future upsert variant should follow).
    const plan = await prisma.billPlan.create({
      data: {
        code: body.code,
        region: body.region,
        name: body.name,
        description: body.description,
        priceCents: body.priceCents,
        currency: body.currency,
        interval: body.interval,
        features: body.features,
        quotas: body.quotas,
        sortOrder: body.sortOrder ?? 0,
        stripeProductId: productId,
        stripePriceId: price.id,
      },
    });
    // Flip the "billing inactive" gate for every account; next
    // entitlement check refreshes from DB.
    invalidateAll();
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    console.error('[billing] plan create failed:', err);
    if (productId) {
      try {
        await stripe.products.update(productId, { active: false });
      } catch (rollbackErr) {
        console.error('[billing] rollback also failed:', rollbackErr);
      }
    }
    return NextResponse.json({ error: 'create failed' }, { status: 500 });
  }
}
