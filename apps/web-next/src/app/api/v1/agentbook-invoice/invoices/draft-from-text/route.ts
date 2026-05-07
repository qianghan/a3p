/**
 * Draft an invoice from a freeform NL message — entry point for the
 * "invoice Acme $5K for July consulting" Telegram flow.
 *
 *   1. Run the NL parser → ParsedInvoiceDraft (or null)
 *   2. Resolve the client by name (case-insensitive substring on
 *      AbClient.name within the tenant). 0 → ask. 1 → create. 2+ → ask.
 *   3. Persist as `AbInvoice { status: 'draft', source: 'telegram' }`
 *      with no journal entry yet — the journal posts on send.
 *
 * Returns one of:
 *   • { success, data: { draftId, invoiceNumber, clientName, totalCents, lines, dueDate, currency, clientEmail } }
 *   • { success, ambiguous: true, candidates: [{id, name, email}, ...], parsed: ParsedInvoiceDraft }
 *   • { success, needsClarify: true, question: string, parsed?: ParsedInvoiceDraft }
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { parseInvoiceFromText, type ParsedInvoiceDraft } from '@/lib/agentbook-invoice-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface DraftFromTextBody {
  text?: string;
  clientId?: string; // optional: caller can pre-pick a client (e.g. after picker)
  parsed?: ParsedInvoiceDraft; // optional: caller already parsed
}

function computeDueDate(hint: string | undefined, issued: Date): Date {
  if (hint && hint.toLowerCase() !== 'net-30') {
    const parsed = new Date(hint);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date(issued.getTime() + 30 * 24 * 60 * 60 * 1000);
}

async function nextInvoiceNumber(tenantId: string, year: number): Promise<string> {
  const last = await db.abInvoice.findFirst({
    where: { tenantId, number: { startsWith: `INV-${year}-` } },
    orderBy: { number: 'desc' },
  });
  let nextSeq = 1;
  if (last) {
    const parts = last.number.split('-');
    const n = parseInt(parts[2], 10);
    if (!isNaN(n)) nextSeq = n + 1;
  }
  return `INV-${year}-${String(nextSeq).padStart(4, '0')}`;
}

async function createDraft(
  tenantId: string,
  parsed: ParsedInvoiceDraft,
  client: { id: string; name: string; email: string | null },
): Promise<{
  draftId: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string | null;
  totalCents: number;
  lines: { description: string; rateCents: number; quantity: number; amountCents: number }[];
  dueDate: string;
  issuedDate: string;
  currency: string;
}> {
  const issuedDate = new Date();
  const dueDate = computeDueDate(parsed.dueDateHint, issuedDate);
  const invoiceNumber = await nextInvoiceNumber(tenantId, issuedDate.getFullYear());

  const tenantConfig = await db.abTenantConfig.findUnique({
    where: { userId: tenantId },
    select: { currency: true },
  });
  const currency = parsed.currencyHint || tenantConfig?.currency || 'USD';

  const lineItems = parsed.lines.map((l) => ({
    description: l.description || '',
    quantity: l.quantity || 1,
    rateCents: l.rateCents,
    amountCents: Math.round((l.quantity || 1) * l.rateCents),
  }));
  const totalAmountCents = lineItems.reduce((sum, l) => sum + l.amountCents, 0);

  // No journal entry on draft — posting happens at send-time so the user
  // can still cancel without polluting the books.
  const inv = await db.abInvoice.create({
    data: {
      tenantId,
      clientId: client.id,
      number: invoiceNumber,
      amountCents: totalAmountCents,
      currency,
      issuedDate,
      dueDate,
      status: 'draft',
      source: 'telegram',
      lines: { create: lineItems },
    },
    include: { lines: true },
  });

  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'invoice.drafted_from_chat',
      actor: 'agent',
      action: {
        invoiceId: inv.id,
        number: invoiceNumber,
        clientId: client.id,
        amountCents: totalAmountCents,
        lineCount: lineItems.length,
        source: 'telegram',
      },
    },
  });

  return {
    draftId: inv.id,
    invoiceNumber,
    clientName: client.name,
    clientEmail: client.email,
    totalCents: totalAmountCents,
    lines: inv.lines.map((l) => ({
      description: l.description,
      rateCents: l.rateCents,
      quantity: l.quantity,
      amountCents: l.amountCents,
    })),
    dueDate: dueDate.toISOString(),
    issuedDate: issuedDate.toISOString(),
    currency,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as DraftFromTextBody;
    const text = (body.text || '').trim();

    let parsed: ParsedInvoiceDraft | null = body.parsed ?? null;
    if (!parsed) {
      if (!text) {
        return NextResponse.json(
          { success: false, error: 'text is required' },
          { status: 400 },
        );
      }
      parsed = await parseInvoiceFromText(text);
    }

    if (!parsed) {
      return NextResponse.json({
        success: true,
        needsClarify: true,
        question: "I read that as an invoice request but couldn't pin down the client and amount. Try \"invoice Acme $5K for July consulting\".",
      });
    }

    // Caller forced a clientId (typical: ambiguous-picker callback).
    if (body.clientId) {
      const client = await db.abClient.findFirst({
        where: { id: body.clientId, tenantId },
        select: { id: true, name: true, email: true },
      });
      if (!client) {
        return NextResponse.json(
          { success: false, error: 'Client not found' },
          { status: 404 },
        );
      }
      const data = await createDraft(tenantId, parsed, client);
      return NextResponse.json({ success: true, data });
    }

    // Resolve client by name (case-insensitive substring match).
    const allClients = await db.abClient.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true },
    });
    const hint = parsed.clientNameHint.toLowerCase();
    const candidates = allClients.filter(
      (c) => c.name.toLowerCase().includes(hint) || hint.includes(c.name.toLowerCase()),
    );

    if (candidates.length === 0) {
      return NextResponse.json({
        success: true,
        needsClarify: true,
        question: `Which client is "${parsed.clientNameHint}"? I don't have one with that name on file.`,
        parsed,
      });
    }

    if (candidates.length > 1) {
      return NextResponse.json({
        success: true,
        ambiguous: true,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, email: c.email })),
        parsed,
      });
    }

    const data = await createDraft(tenantId, parsed, candidates[0]);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[agentbook-invoice/invoices/draft-from-text] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
