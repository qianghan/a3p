/**
 * One-time/idempotent admin seed for the agentbook-startup plugin's
 * StartupBenefitProgram catalog and startup_tax_benefits BillAddOn pricing.
 *
 * Mirrors bin/seed-startup-benefit-programs.ts and
 * bin/seed-startup-benefit-addon.ts exactly, but runs server-side against
 * whichever DATABASE_URL the deployed function already has configured —
 * no local production DB credentials needed. Auth: admin session only
 * (requireAdmin), same as the other agentbook-startup/billing admin routes.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { requireAdmin, type HttpError } from '@/lib/billing/admin-auth';
import { US_STARTUP_BENEFIT_PROGRAMS } from '@/lib/agentbook-startup/us-programs';

export const runtime = 'nodejs';

const ADDON_CODE = 'startup_tax_benefits';
const REGIONS: { region: string; currency: string }[] = [
  { region: 'us', currency: 'usd' },
  { region: 'ca', currency: 'cad' },
  { region: 'uk', currency: 'gbp' },
];
const TIERS: { tier: string; priceCents: number; maxSlots: number | null }[] = [
  { tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
  { tier: 'standard', priceCents: 24900, maxSlots: null },
  { tier: 'scaled', priceCents: 49900, maxSlots: null },
];

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  let programsCreated = 0;
  let programsUpdated = 0;
  const now = new Date();

  for (const program of US_STARTUP_BENEFIT_PROGRAMS) {
    const existing = await prisma.startupBenefitProgram.findUnique({
      where: { jurisdiction_programCode: { jurisdiction: program.jurisdiction, programCode: program.programCode } },
    });
    const data = {
      jurisdiction: program.jurisdiction,
      programCode: program.programCode,
      name: program.name,
      authority: program.authority,
      typicalValueLowCents: program.typicalValueLowCents,
      typicalValueHighCents: program.typicalValueHighCents,
      eligibilityCriteria: program.eligibilityCriteria,
      requiredDocuments: program.requiredDocuments,
      sourceUrl: program.sourceUrl,
      lastVerifiedAt: now,
      enabled: true,
    };
    if (existing) {
      await prisma.startupBenefitProgram.update({ where: { id: existing.id }, data });
      programsUpdated++;
    } else {
      await prisma.startupBenefitProgram.create({ data });
      programsCreated++;
    }
  }

  const addOn = await prisma.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Startup Tax Benefits', interval: 'year', isActive: true },
    create: { code: ADDON_CODE, name: 'Startup Tax Benefits', interval: 'year', isActive: true },
  });

  let pricesCreated = 0;
  let pricesUpdated = 0;

  for (const { region, currency } of REGIONS) {
    for (const { tier, priceCents, maxSlots } of TIERS) {
      const existing = await prisma.billAddOnPrice.findUnique({
        where: { addOnId_region_tier: { addOnId: addOn.id, region, tier } },
      });
      const data = { addOnId: addOn.id, region, currency, tier, priceCents, maxSlots, isActive: true };
      if (existing) {
        await prisma.billAddOnPrice.update({ where: { id: existing.id }, data });
        pricesUpdated++;
      } else {
        await prisma.billAddOnPrice.create({ data });
        pricesCreated++;
      }
    }
  }

  return NextResponse.json({
    programs: { created: programsCreated, updated: programsUpdated },
    addOnPrices: { created: pricesCreated, updated: pricesUpdated },
  });
}
