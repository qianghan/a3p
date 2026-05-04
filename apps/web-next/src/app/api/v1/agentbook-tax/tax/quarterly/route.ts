/**
 * Tax quarterly payments — list installments for a tax year. If no
 * records exist for the year, lazily creates them from the most
 * recent AbTaxEstimate (annual / 4) at the jurisdictional deadlines.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function getQuarterlyDeadlines(year: number, jurisdiction: string): { quarter: number; deadline: Date }[] {
  if (jurisdiction === 'ca') {
    return [
      { quarter: 1, deadline: new Date(`${year}-03-15`) },
      { quarter: 2, deadline: new Date(`${year}-06-15`) },
      { quarter: 3, deadline: new Date(`${year}-09-15`) },
      { quarter: 4, deadline: new Date(`${year}-12-15`) },
    ];
  }
  return [
    { quarter: 1, deadline: new Date(`${year}-04-15`) },
    { quarter: 2, deadline: new Date(`${year}-06-15`) },
    { quarter: 3, deadline: new Date(`${year}-09-15`) },
    { quarter: 4, deadline: new Date(`${year + 1}-01-15`) },
  ];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const yearParam = request.nextUrl.searchParams.get('year');
    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();

    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';

    let payments = await db.abQuarterlyPayment.findMany({
      where: { tenantId, year, jurisdiction },
      orderBy: { quarter: 'asc' },
    });

    if (payments.length === 0) {
      const latestEstimate = await db.abTaxEstimate.findFirst({
        where: { tenantId },
        orderBy: { calculatedAt: 'desc' },
      });
      const annualTax = latestEstimate?.totalTaxCents || 0;
      const quarterlyAmount = Math.ceil(annualTax / 4);
      const deadlines = getQuarterlyDeadlines(year, jurisdiction);

      for (const dl of deadlines) {
        await db.abQuarterlyPayment.upsert({
          where: {
            tenantId_year_quarter_jurisdiction: {
              tenantId,
              year,
              quarter: dl.quarter,
              jurisdiction,
            },
          },
          update: { amountDueCents: quarterlyAmount },
          create: {
            tenantId,
            year,
            quarter: dl.quarter,
            jurisdiction,
            amountDueCents: quarterlyAmount,
            deadline: dl.deadline,
          },
        });
      }
      payments = await db.abQuarterlyPayment.findMany({
        where: { tenantId, year, jurisdiction },
        orderBy: { quarter: 'asc' },
      });
    }

    const totalDue = payments.reduce((s, p) => s + p.amountDueCents, 0);
    const totalPaid = payments.reduce((s, p) => s + p.amountPaidCents, 0);

    return NextResponse.json({
      success: true,
      data: {
        year,
        jurisdiction,
        payments,
        summary: {
          totalDueCents: totalDue,
          totalPaidCents: totalPaid,
          remainingCents: totalDue - totalPaid,
        },
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/tax/quarterly] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
