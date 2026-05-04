/**
 * Record a quarterly tax payment against a year + quarter row.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RecordPaymentBody {
  amountPaidCents?: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string; quarter: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const p = await params;
    const year = parseInt(p.year, 10);
    const quarter = parseInt(p.quarter, 10);
    const body = (await request.json().catch(() => ({}))) as RecordPaymentBody;
    const { amountPaidCents } = body;

    if (!year || !quarter || quarter < 1 || quarter > 4) {
      return NextResponse.json(
        { success: false, error: 'Invalid year or quarter (1-4)' },
        { status: 400 },
      );
    }
    if (!amountPaidCents || amountPaidCents <= 0) {
      return NextResponse.json(
        { success: false, error: 'amountPaidCents must be a positive integer' },
        { status: 400 },
      );
    }

    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';

    const payment = await db.abQuarterlyPayment.findUnique({
      where: {
        tenantId_year_quarter_jurisdiction: { tenantId, year, quarter, jurisdiction },
      },
    });

    if (!payment) {
      return NextResponse.json(
        {
          success: false,
          error: 'Quarterly payment record not found. Call GET /tax/quarterly first.',
        },
        { status: 404 },
      );
    }

    const updated = await db.abQuarterlyPayment.update({
      where: { id: payment.id },
      data: {
        amountPaidCents: payment.amountPaidCents + amountPaidCents,
        paidAt: new Date(),
      },
    });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'tax.quarterly.payment_recorded',
        actor: 'agent',
        action: {
          paymentId: updated.id,
          year,
          quarter,
          jurisdiction,
          amountPaidCents,
          newTotalPaid: updated.amountPaidCents,
        },
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-tax/tax/quarterly/:year/:quarter/record-payment] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
