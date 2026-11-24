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
import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';
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
 */
async function editLineQuantities(tenantId: string, invoiceId: string, edits: { id: string; quantity: number }[]) {
  const inv = await db.abInvoice.findFirst({
    where: { id: invoiceId, tenantId, deletedAt: null },
    include: { lines: true, payments: true },
  });
  if (!inv) return { status: 404, error: 'Invoice not found' };
  if (inv.status !== 'draft') return { status: 422, error: 'Only draft invoices can have their lines edited' };
  if (inv.payments.length > 0) return { status: 422, error: 'Invoice has payments' };
  const deferred = await db.abDeferredRevenue.findFirst({ where: { tenantId, invoiceId } });
  if (deferred) return { status: 422, error: 'Deferred-revenue invoices cannot have their lines edited' };
  const byId = new Map(inv.lines.map((l) => [l.id, l]));
  for (const e of edits) {
    if (!e || typeof e.id !== 'string' || !byId.has(e.id)) return { status: 404, error: 'Invoice line not found' };
    if (typeof e.quantity !== 'number' || !Number.isFinite(e.quantity) || e.quantity <= 0 || e.quantity > MAX_QTY) {
      return { status: 400, error: 'quantity must be a positive number' };
    }
  }
  const next = inv.lines.map((l) => {
    const e = edits.find((x) => x.id === l.id);
    const quantity = e ? e.quantity : l.quantity;
    return { ...l, quantity, amountCents: Math.round(quantity * l.rateCents), changed: !!e && e.quantity !== l.quantity };
  });
  if (!next.some((l) => l.changed)) return { status: 200, data: inv };
  const subtotalCents = next.reduce((s, l) => s + l.amountCents, 0);
  const origLines = inv.journalEntryId ? await db.abJournalLine.findMany({ where: { entryId: inv.journalEntryId } }) : [];
  const origTaxLines = origLines.filter((l) => l.creditCents > 0 && !/^Revenue/.test(l.description || ''));
  const tax = await computeInvoiceTax(tenantId, subtotalCents, origTaxLines.length === 1 ? inv.taxRate : null);
  const total = subtotalCents + tax.taxCents;
  const accounts = await db.abAccount.findMany({ where: { tenantId, code: { in: ['1100', '4000', ...tax.components.map((c) => c.accountCode)] } } });
  const acct = new Map(accounts.map((a) => [a.code, a.id]));
  if (!acct.get('1100') || !acct.get('4000') || tax.components.some((c) => !acct.get(c.accountCode))) {
    return { status: 422, error: 'Chart of accounts is missing an invoice account' };
  }
  const rev = (await db.abJournalEntry.count({ where: { tenantId, sourceType: 'invoice_edit', sourceId: { startsWith: `${inv.id}:` } } })) + 1;
  const date = new Date();
  const updated = await db.$transaction(async (tx) => {
    if (origLines.length > 0) {
      await tx.abJournalEntry.create({ data: {
        tenantId, date, memo: `EDIT - Reverse Invoice ${inv.number}`, sourceType: 'invoice_edit_reverse', sourceId: `${inv.id}:${rev}`, verified: true,
        lines: { create: origLines.map((l) => ({ tenantId, accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, description: `Reverse: ${l.description || inv.number}` })) },
      } });
    }
    const entry = await tx.abJournalEntry.create({ data: {
      tenantId, date: inv.issuedDate, memo: `Invoice ${inv.number} (edited)`, sourceType: 'invoice_edit', sourceId: `${inv.id}:${rev}`, verified: true,
      lines: { create: [
        { tenantId, accountId: acct.get('1100')!, debitCents: total, creditCents: 0, description: `AR - Invoice ${inv.number}` },
        { tenantId, accountId: acct.get('4000')!, debitCents: 0, creditCents: subtotalCents, description: `Revenue - Invoice ${inv.number}` },
        ...tax.components.map((c) => ({ tenantId, accountId: acct.get(c.accountCode)!, debitCents: 0, creditCents: c.amountCents, description: `${c.type} Payable - Invoice ${inv.number}` })),
      ] },
    } });
    for (const l of next.filter((x) => x.changed)) {
      await tx.abInvoiceLine.update({ where: { id: l.id }, data: { quantity: l.quantity, amountCents: l.amountCents } });
      await repostInvoiceLineCogs(tx, tenantId, { invoiceNumber: inv.number, date, line: { id: l.id, itemId: l.itemId, quantity: l.quantity }, rev });
    }
    await tx.abSalesTaxCollected.deleteMany({ where: { tenantId, invoiceId: inv.id } });
    if (tax.components.length > 0) {
      const cfg = await tx.abTenantConfig.findUnique({ where: { userId: tenantId }, select: { jurisdiction: true, region: true } });
      await tx.abSalesTaxCollected.createMany({ data: tax.components.map((c) => ({
        tenantId, invoiceId: inv.id, jurisdiction: cfg?.jurisdiction || 'us', region: cfg?.region || '', taxType: c.type, rate: c.rate, amountCents: c.amountCents,
      })) });
    }
    await tx.abClient.update({ where: { id: inv.clientId }, data: { totalBilledCents: { increment: total - inv.amountCents } } });
    return tx.abInvoice.update({
      where: { id: inv.id },
      data: { amountCents: total, taxCents: tax.taxCents, taxRate: tax.taxRate || null, journalEntryId: entry.id },
      include: { lines: true },
    });
  });
  return { status: 200, data: updated, before: { amountCents: inv.amountCents } };
}

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

    if (Array.isArray(body.lines) && body.lines.length > 0) {
      const r = await editLineQuantities(tenantId, id, body.lines);
      if (!('data' in r)) return NextResponse.json({ success: false, error: r.error }, { status: r.status });
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
