/**
 * Credit notes — list + create. Posts a reversing journal entry and
 * decrements the client's totalBilledCents.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const creditNotes = await db.abCreditNote.findMany({
      where: { tenantId },
      include: { invoice: { select: { number: true, clientId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ success: true, data: creditNotes });
  } catch (err) {
    console.error('[agentbook-invoice/credit-notes GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface CreateCreditNoteBody {
  invoiceId?: string;
  amountCents?: number;
  reason?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CreateCreditNoteBody;
    const { invoiceId, amountCents, reason } = body;

    if (!invoiceId || !amountCents || amountCents <= 0 || !reason) {
      return NextResponse.json(
        { success: false, error: 'invoiceId, amountCents (positive), and reason are required' },
        { status: 400 },
      );
    }

    const invoice = await db.abInvoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { payments: true, client: true },
    });
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }
    if (invoice.status === 'void') {
      return NextResponse.json({ success: false, error: 'Cannot credit a voided invoice' }, { status: 422 });
    }

    const totalPaid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
    const balance = invoice.amountCents - totalPaid;
    if (amountCents > balance) {
      return NextResponse.json(
        { success: false, error: `Credit amount (${amountCents}) exceeds remaining balance (${balance})` },
        { status: 422 },
      );
    }

    const year = new Date().getFullYear();
    const lastCN = await db.abCreditNote.findFirst({
      where: { tenantId, number: { startsWith: `CN-${year}-` } },
      orderBy: { number: 'desc' },
    });
    let cnSeq = 1;
    if (lastCN) cnSeq = parseInt(lastCN.number.split('-')[2], 10) + 1;
    const cnNumber = `CN-${year}-${String(cnSeq).padStart(4, '0')}`;

    // Prorate the credited amount between Revenue and each tax-liability
    // account, in the same proportion as the original invoice's subtotal
    // vs. tax split — a full credit against a taxed invoice must clear the
    // tax liability too, not book the whole amount as a Revenue reversal
    // (which would over-reverse Revenue and leave 2100/2200 stuck non-zero).
    // Invoices with no tax (taxCents === 0, including every pre-PR-6 row)
    // fall through to the original 2-line Revenue/AR behavior unchanged.
    const taxComponents = invoice.taxCents > 0
      ? await db.abSalesTaxCollected.findMany({ where: { invoiceId: invoice.id } })
      : [];

    const [arAccount, revenueAccount, liabilityAccounts] = await Promise.all([
      db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
      db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '4000' } } }),
      taxComponents.length > 0
        ? db.abAccount.findMany({ where: { tenantId, code: { in: [...new Set(taxComponents.map((c) => (c.taxType === 'PST' ? '2200' : '2100')))] } } })
        : Promise.resolve([]),
    ]);
    if (!arAccount || !revenueAccount) {
      return NextResponse.json({ success: false, error: 'AR/Revenue accounts not found' }, { status: 422 });
    }
    const liabilityByCode = new Map(liabilityAccounts.map((a) => [a.code, a]));
    for (const c of taxComponents) {
      const code = c.taxType === 'PST' ? '2200' : '2100';
      if (!liabilityByCode.has(code)) {
        return NextResponse.json({ success: false, error: `Tax liability account ${code} not found` }, { status: 422 });
      }
    }

    let creditLines: { tenantId: string; accountId: string; debitCents: number; creditCents: number; description: string }[];
    if (taxComponents.length === 0) {
      creditLines = [
        { tenantId, accountId: revenueAccount.id, debitCents: amountCents, creditCents: 0, description: `Revenue reversal - ${cnNumber}` },
      ];
    } else {
      const subtotalCents = invoice.amountCents - invoice.taxCents;
      const revenuePortion = Math.round((amountCents * subtotalCents) / invoice.amountCents);
      const taxPortion = amountCents - revenuePortion;
      let allocatedTax = 0;
      const componentLines = taxComponents.map((c, i) => {
        const code = c.taxType === 'PST' ? '2200' : '2100';
        const share = i === taxComponents.length - 1
          ? taxPortion - allocatedTax // last component absorbs the rounding remainder
          : Math.round((taxPortion * c.amountCents) / invoice.taxCents);
        allocatedTax += share;
        return { tenantId, accountId: liabilityByCode.get(code)!.id, debitCents: share, creditCents: 0, description: `${c.taxType} reversal - ${cnNumber}` };
      }).filter((l) => l.debitCents > 0);
      creditLines = [
        ...(revenuePortion > 0 ? [{ tenantId, accountId: revenueAccount.id, debitCents: revenuePortion, creditCents: 0, description: `Revenue reversal - ${cnNumber}` }] : []),
        ...componentLines,
      ];
    }

    const creditNote = await db.$transaction(async (tx) => {
      const je = await tx.abJournalEntry.create({
        data: {
          tenantId,
          date: new Date(),
          memo: `Credit note ${cnNumber} against ${invoice.number}`,
          sourceType: 'credit_note',
          verified: true,
          lines: {
            create: [
              ...creditLines,
              { tenantId, accountId: arAccount.id, debitCents: 0, creditCents: amountCents, description: `AR reduction - ${cnNumber}` }, // G-009
            ],
          },
        },
      });

      const cn = await tx.abCreditNote.create({
        data: {
          tenantId,
          invoiceId,
          number: cnNumber,
          amountCents,
          reason,
          journalEntryId: je.id,
        },
      });

      await tx.abClient.update({
        where: { id: invoice.clientId },
        data: { totalBilledCents: { decrement: amountCents } },
      });

      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: 'credit_note.created',
          actor: 'agent',
          action: { creditNoteId: cn.id, number: cnNumber, invoiceId, amountCents, reason },
        },
      });

      return cn;
    });

    return NextResponse.json({ success: true, data: creditNote }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-invoice/credit-notes POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
