/**
 * Recurring invoices — list + create.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { validateInvoiceLines } from '@/lib/money-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'] as const;
type Frequency = (typeof VALID_FREQUENCIES)[number];

interface TemplateLine {
  description?: string;
  quantity?: number;
  rateCents: number;
}

interface CreateRecurringBody {
  clientId?: string;
  frequency?: Frequency;
  nextDue?: string;
  endDate?: string;
  templateLines?: TemplateLine[];
  daysToPay?: number;
  autoSend?: boolean;
  currency?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const items = await db.abRecurringInvoice.findMany({
      where: { tenantId },
      orderBy: { nextDue: 'asc' },
    });
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[agentbook-invoice/recurring-invoices GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CreateRecurringBody;
    const { clientId, frequency, nextDue, endDate, templateLines, daysToPay, autoSend, currency } = body;

    if (!clientId || !frequency || !nextDue || !templateLines || !Array.isArray(templateLines) || templateLines.length === 0) {
      return NextResponse.json(
        { success: false, error: 'clientId, frequency, nextDue, and templateLines are required' },
        { status: 400 },
      );
    }
    if (!VALID_FREQUENCIES.includes(frequency)) {
      return NextResponse.json(
        { success: false, error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` },
        { status: 400 },
      );
    }

    const client = await db.abClient.findFirst({ where: { id: clientId, tenantId } });
    if (!client) {
      return NextResponse.json({ success: false, error: 'Client not found' }, { status: 404 });
    }

    // Validate the template's money now — these lines persist as JSON and the
    // recurring-invoices cron turns them into real invoices AND journal entries
    // later, so a NaN/negative here would poison every future run. Store the
    // normalized lines so the persisted template is always clean.
    const validated = validateInvoiceLines(templateLines);
    if (!validated.ok) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }
    const totalCents = validated.subtotalCents;

    const recurring = await db.abRecurringInvoice.create({
      data: {
        tenantId,
        clientId,
        frequency,
        nextDue: new Date(nextDue),
        endDate: endDate ? new Date(endDate) : null,
        templateLines: validated.lines as never,
        totalCents,
        daysToPay: daysToPay || 30,
        autoSend: autoSend || false,
        currency: currency || 'USD',
      },
    });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'recurring_invoice.created',
        actor: 'agent',
        action: { recurringId: recurring.id, clientId, frequency, totalCents },
      },
    });

    return NextResponse.json({ success: true, data: recurring }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-invoice/recurring-invoices POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
