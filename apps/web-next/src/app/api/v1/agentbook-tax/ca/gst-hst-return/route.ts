/**
 * GET /api/v1/agentbook-tax/ca/gst-hst-return?periodStart=&periodEnd=
 *
 * Computes a Canadian GST/HST return for the period from the tenant's own
 * booked data — GST collected from invoices' persisted taxCents (line 105),
 * input tax credits from expenses' persisted taxAmountCents (line 108) — and
 * returns the CRA return lines + the sales/purchase working papers.
 *
 * CA-only (422 otherwise). This is prep + net-tax computation; electronic
 * lodgment (NETFILE) is a separate accreditation step (see the launch guide) —
 * this route deliberately does not transmit anything.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeGstHstReturn } from '@agentbook/jurisdictions/ca/gst-hst-return';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if ((cfg?.jurisdiction || 'us') !== 'ca') {
      return NextResponse.json(
        { success: false, error: { code: 'unsupported_jurisdiction', message: 'GST/HST returns are only available for Canadian tenants.' } },
        { status: 422 },
      );
    }

    // Default to the current calendar quarter when no period is given.
    const now = new Date();
    const q = Math.floor(now.getUTCMonth() / 3);
    const defStart = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
    const defEnd = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0));
    const periodStart = request.nextUrl.searchParams.get('periodStart') || defStart.toISOString().slice(0, 10);
    const periodEnd = request.nextUrl.searchParams.get('periodEnd') || defEnd.toISOString().slice(0, 10);
    const gte = new Date(`${periodStart}T00:00:00.000Z`);
    const lte = new Date(`${periodEnd}T23:59:59.999Z`);

    const [invoices, expenses] = await Promise.all([
      // GST/HST collected — invoices issued in the period that represent real
      // (not draft/void) sales. taxCents is the persisted tax portion.
      db.abInvoice.findMany({
        where: { tenantId, issuedDate: { gte, lte }, status: { in: ['sent', 'viewed', 'overdue', 'paid'] } },
        select: { amountCents: true, taxCents: true },
      }),
      // ITCs — business (non-personal) expenses in the period; taxAmountCents
      // is the GST/HST paid portion recorded at booking.
      db.abExpense.findMany({
        where: { tenantId, isPersonal: false, date: { gte, lte } },
        select: { taxAmountCents: true },
      }),
    ]);

    const result = computeGstHstReturn({
      periodStart,
      periodEnd,
      sales: invoices.map((i) => ({
        netSalesCents: i.amountCents - (i.taxCents ?? 0),
        taxCollectedCents: i.taxCents ?? 0,
      })),
      purchases: expenses.map((e) => ({ taxPaidCents: e.taxAmountCents ?? 0 })),
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/ca/gst-hst-return] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
