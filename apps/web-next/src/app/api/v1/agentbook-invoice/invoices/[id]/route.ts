/**
 * Invoice detail — native Next.js route.
 *
 * GET   — full row + payments + balance.
 * PATCH — limited edit (issuedDate, dueDate, currency, status). PR 10
 *         adds this so the activity log can show "edited invoice X"
 *         events alongside create / send / pay.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { withSoftDelete, parseIncludeDeleted } from '@/lib/agentbook-soft-delete';
import { publicErrorMessage } from '@/lib/api-error';
import { appendBalancedEntry, assertPeriodOpen, LedgerPeriodClosedError } from '@/lib/ledger-writer';
import { voidInvoice } from '@/lib/invoice-void';
import { repostInvoiceLineCogs, InventoryError } from '@/lib/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const includeDeleted = parseIncludeDeleted(request.nextUrl.searchParams);

    const invoice = await db.abInvoice.findFirst({
      where: withSoftDelete({ id, tenantId }, includeDeleted),
      include: { lines: true, payments: true, client: true },
    });

    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }

    const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amountCents, 0);

    return NextResponse.json({
      success: true,
      data: {
        ...invoice,
        totalPaidCents: totalPaid,
        balanceDueCents: invoice.amountCents - totalPaid,
      },
    });
  } catch (err) {
    console.error('[agentbook-invoice/invoices/:id] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}

interface InvoicePatchBody {
  issuedDate?: string;
  dueDate?: string;
  currency?: string;
  status?: string;
  /** PR 5B: quantity edits on a draft invoice's lines — revenue and COGS are reversed and reposted. */
  lines?: { id: string; quantity: number }[];
}

const MAX_QTY = 1_000_000;

/**
 * Re-quantify lines of a DRAFT invoice with no payments and no deferral:
 * mirror-reverse the current revenue entry (invoice_edit_reverse / id:rev),
 * post the recomputed one (invoice_edit / id:rev), and for item lines reverse
 * and repost COGS (stock_sale_edit_reverse + stock_sale / line:rev).
 *
 * Every entry goes through appendBalancedEntry, dated the invoice issue date
 * (the edit corrects that invoice; it must not move revenue between periods),
 * after the closed-period check. The revision is read INSIDE the transaction;
 * a concurrent edit that took the same revision surfaces as a key conflict
 * (P2002) and the whole transaction is retried with a fresh revision.
 * Tax: each original tax line is rescaled by new/old subtotal, so a
 * multi-component invoice (GST+PST) keeps its own rates.
 */
const EDIT_ATTEMPTS = 3;

type EditResult = { status: number; error: string; code?: string } | { status: 200; data: any; before?: { amountCents: number } }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function editLineQuantities(tenantId: string, invoiceId: string, edits: { id: string; quantity: number }[]): Promise<EditResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => editOnce(tx, tenantId, invoiceId, edits));
    } catch (err) {
      if (err instanceof LedgerPeriodClosedError) return { status: 422, code: 'period_closed', error: 'The invoice date is in a closed period' };
      if ((err as { code?: string })?.code === 'P2002' && attempt < EDIT_ATTEMPTS) continue;
      throw err;
    }
  }
}

async function editOnce(tx: any, tenantId: string, invoiceId: string, edits: { id: string; quantity: number }[]): Promise<EditResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const inv = await tx.abInvoice.findFirst({
    where: { id: invoiceId, tenantId, deletedAt: null },
    include: { lines: true, payments: true },
  });
  if (!inv) return { status: 404, error: 'Invoice not found' };
  if (inv.status !== 'draft') return { status: 422, error: 'Only draft invoices can have their lines edited' };
  if (inv.payments.length > 0) return { status: 422, error: 'Invoice has payments' };
  const deferred = await tx.abDeferredRevenue.findFirst({ where: { tenantId, invoiceId } });
  if (deferred) return { status: 422, error: 'Deferred-revenue invoices cannot have their lines edited' };
  const lines: Array<{ id: string; quantity: number; rateCents: number; amountCents: number; itemId: string | null }> = inv.lines;
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const e of edits) {
    if (!e || typeof e.id !== 'string' || !byId.has(e.id)) return { status: 404, error: 'Invoice line not found' };
    if (typeof e.quantity !== 'number' || !Number.isFinite(e.quantity) || e.quantity <= 0 || e.quantity > MAX_QTY) {
      return { status: 400, error: 'quantity must be a positive number' };
    }
  }
  const next = lines.map((l) => {
    const e = edits.find((x) => x.id === l.id);
    const quantity = e ? e.quantity : l.quantity;
    return { ...l, quantity, amountCents: Math.round(quantity * l.rateCents), changed: !!e && e.quantity !== l.quantity };
  });
  if (!next.some((l) => l.changed)) return { status: 200, data: inv };

  const date: Date = inv.issuedDate;
  await assertPeriodOpen(tx, tenantId, date);
  const subtotalCents = next.reduce((s, l) => s + l.amountCents, 0);
  const oldSubtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const origLines: Array<{ accountId: string; debitCents: number; creditCents: number; description: string | null }> =
    inv.journalEntryId ? await tx.abJournalLine.findMany({ where: { entryId: inv.journalEntryId } }) : [];
  const [ar, revenue] = await Promise.all([
    tx.abAccount.findFirst({ where: { tenantId, code: '1100' } }),
    tx.abAccount.findFirst({ where: { tenantId, code: '4000' } }),
  ]);
  if (!ar || !revenue) return { status: 422, error: 'Chart of accounts is missing an invoice account' };
  const scale = (c: number) => (oldSubtotal > 0 ? Math.round((c * subtotalCents) / oldSubtotal) : 0);
  const taxLines = origLines
    .filter((l) => l.creditCents > 0 && l.accountId !== revenue.id && l.accountId !== ar.id)
    .map((l) => ({ accountId: l.accountId, creditCents: scale(l.creditCents), description: l.description }));
  const taxCents = taxLines.reduce((s, l) => s + l.creditCents, 0);
  const total = subtotalCents + taxCents;

  const rev = (await tx.abJournalEntry.count({ where: { tenantId, sourceType: 'invoice_edit_reverse', sourceId: { startsWith: `${inv.id}:` } } })) + 1;
  const key = `${inv.id}:${rev}`;
  if (origLines.length > 0) {
    await appendBalancedEntry(tx, tenantId, { date, memo: `EDIT - Reverse Invoice ${inv.number}`, sourceType: 'invoice_edit_reverse', sourceId: key },
      origLines.map((l) => ({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, description: `Reverse: ${l.description || inv.number}` })));
  }
  const entryId = await appendBalancedEntry(tx, tenantId, { date, memo: `Invoice ${inv.number} (edited)`, sourceType: 'invoice_edit', sourceId: key }, [
    { accountId: ar.id, debitCents: total, creditCents: 0, description: `AR - Invoice ${inv.number}` },
    { accountId: revenue.id, debitCents: 0, creditCents: subtotalCents, description: `Revenue - Invoice ${inv.number}` },
    ...taxLines.filter((l) => l.creditCents > 0).map((l) => ({ accountId: l.accountId, debitCents: 0, creditCents: l.creditCents, description: l.description })),
  ]);
  for (const l of next.filter((x) => x.changed)) {
    await tx.abInvoiceLine.update({ where: { id: l.id }, data: { quantity: l.quantity, amountCents: l.amountCents } });
    await repostInvoiceLineCogs(tx, tenantId, { invoiceNumber: inv.number, date, line: { id: l.id, itemId: l.itemId, quantity: l.quantity }, rev });
  }
  const collected: Array<{ id: string; amountCents: number }> = await tx.abSalesTaxCollected.findMany({ where: { tenantId, invoiceId: inv.id } });
  for (const c of collected) {
    await tx.abSalesTaxCollected.update({ where: { id: c.id }, data: { amountCents: scale(c.amountCents) } });
  }
  await tx.abClient.update({ where: { id: inv.clientId }, data: { totalBilledCents: { increment: total - inv.amountCents } } });
  const updated = await tx.abInvoice.update({
    where: { id: inv.id },
    data: { amountCents: total, taxCents, journalEntryId: entryId },
    include: { lines: true },
  });
  return { status: 200, data: updated, before: { amountCents: inv.amountCents } };
}

/**
 * Status PATCH is a whitelist. `void` runs the real void path (revenue reversed
 * AND sold stock returned); `paid` comes only from payments; nothing goes back
 * to `draft` (a draft is the only line-editable state), and a void or paid
 * invoice cannot change status at all.
 */
const PATCHABLE_STATUSES = new Set(['draft', 'sent', 'viewed', 'overdue']);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as InvoicePatchBody;

    // Soft-delete (PR 26): edits only apply to live rows.
    const existing = await db.abInvoice.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }

    if (body.status !== undefined) {
      if (body.status === 'void') {
        const res = await voidInvoice(tenantId, id);
        if (res.ok) {
          await audit({
            tenantId, source: inferSource(request), actor: await inferActor(request),
            action: 'invoice.update', entityType: 'AbInvoice', entityId: id,
            before: { status: existing.status }, after: { status: 'void' },
          });
        }
        return res;
      }
      if (existing.status === 'void' || existing.status === 'paid') {
        return NextResponse.json({ success: false, error: `A ${existing.status} invoice cannot change status` }, { status: 422 });
      }
      if (body.status === 'paid') {
        return NextResponse.json({ success: false, error: 'Record a payment to mark an invoice paid' }, { status: 422 });
      }
      if (!PATCHABLE_STATUSES.has(body.status)) {
        return NextResponse.json({ success: false, error: 'invalid status' }, { status: 400 });
      }
      if (body.status === 'draft' && existing.status !== 'draft') {
        return NextResponse.json({ success: false, error: 'An issued invoice cannot go back to draft' }, { status: 422 });
      }
    }

    if (Array.isArray(body.lines) && body.lines.length > 0) {
      const r = await editLineQuantities(tenantId, id, body.lines);
      if (!('data' in r)) return NextResponse.json({ success: false, code: r.code, error: r.error }, { status: r.status });
      if (r.before) {
        await audit({
          tenantId, source: inferSource(request), actor: await inferActor(request),
          action: 'invoice.update', entityType: 'AbInvoice', entityId: id,
          before: r.before, after: { amountCents: r.data.amountCents },
        });
      }
      return NextResponse.json({ success: true, data: r.data });
    }

    const data: Record<string, unknown> = {};
    if (body.issuedDate !== undefined) data.issuedDate = new Date(body.issuedDate);
    if (body.dueDate !== undefined) data.dueDate = new Date(body.dueDate);
    if (body.currency !== undefined) data.currency = body.currency;
    if (body.status !== undefined) data.status = body.status;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ success: false, error: 'no editable fields' }, { status: 400 });
    }

    const updated = await db.abInvoice.update({ where: { id }, data });

    // Build the before/after with the same shape so the diff is sparse.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (body.issuedDate !== undefined) {
      before.issuedDate = existing.issuedDate;
      after.issuedDate = updated.issuedDate;
    }
    if (body.dueDate !== undefined) {
      before.dueDate = existing.dueDate;
      after.dueDate = updated.dueDate;
    }
    if (body.currency !== undefined) {
      before.currency = existing.currency;
      after.currency = updated.currency;
    }
    if (body.status !== undefined) {
      before.status = existing.status;
      after.status = updated.status;
    }
    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: 'invoice.update',
      entityType: 'AbInvoice',
      entityId: id,
      before,
      after,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof InventoryError) {
      return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err) }, { status: err.status });
    }
    console.error('[agentbook-invoice/invoices/:id PATCH] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}

/**
 * Soft-delete (PR 26): mark `deletedAt` instead of removing the row.
 * Restorable for 90 days via `/agentbook-core/restore/invoice/[id]`,
 * after which the daily housekeeping cron purges it for real.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const existing = await db.abInvoice.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });
    }

    await db.abInvoice.update({ where: { id }, data: { deletedAt: new Date() } });

    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: 'invoice.delete',
      entityType: 'AbInvoice',
      entityId: id,
      before: {
        number: existing.number,
        clientId: existing.clientId,
        amountCents: existing.amountCents,
        status: existing.status,
        issuedDate: existing.issuedDate,
        dueDate: existing.dueDate,
      },
    });

    return NextResponse.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[agentbook-invoice/invoices/:id DELETE] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
