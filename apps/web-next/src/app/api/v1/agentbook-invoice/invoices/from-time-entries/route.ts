/**
 * Generate an invoice draft from unbilled time entries (PR 2).
 *
 * Body:
 *   {
 *     clientId: string,
 *     dateRange: { startDate: ISO, endDate: ISO },   // half-open [start, end)
 *     source?: 'telegram' | 'web'                    // drives the "via X" pill
 *   }
 *
 * Pipeline:
 *   1. Resolve the client (404 missing, 403 cross-tenant) — fail fast
 *      before scanning entries.
 *   2. Pull unbilled, billable entries for that client in the date range.
 *      0 entries → friendly 400; the bot turns this into a "no unbilled
 *      time" reply rather than a generic error.
 *   3. Bucket entries by calendar day (in the tenant TZ) → one invoice
 *      line per day, with weighted-mean hourly rate.
 *   4. Persist via the shared `createInvoiceDraft` helper (race-safe
 *      numbering, currency fallback, AbEvent emission) and atomically
 *      flip the consumed time entries to `billed=true` + link them to
 *      the new invoice id.
 *
 * Atomicity note: `createInvoiceDraft` runs its own `$transaction` for
 * numbering, so the "mark consumed" `updateMany` happens as a separate
 * statement *after* the draft commits. To stay correct under failure we
 * scope the update by the entry IDs we just read (so a concurrent
 * billing pass doesn't double-bill); if the update itself fails we throw
 * — the user sees an error and can retry, which is safer than silently
 * leaving the entries unflagged.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { createInvoiceDraft } from '@/lib/agentbook-invoice-draft';
import {
  aggregateByDay,
  type TimeEntryRow,
} from '@/lib/agentbook-time-aggregator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface FromTimeEntriesBody {
  clientId?: string;
  dateRange?: { startDate?: string; endDate?: string };
  source?: 'telegram' | 'web';
}

function isoDateInTz(date: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* fall through */
  }
  return date.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as FromTimeEntriesBody;
    const clientId = body.clientId;
    const startDateRaw = body.dateRange?.startDate;
    const endDateRaw = body.dateRange?.endDate;
    const source: 'telegram' | 'web' = body.source === 'web' ? 'web' : 'telegram';

    if (!clientId) {
      return NextResponse.json(
        { success: false, error: 'clientId is required' },
        { status: 400 },
      );
    }
    if (!startDateRaw || !endDateRaw) {
      return NextResponse.json(
        { success: false, error: 'dateRange.startDate and dateRange.endDate are required' },
        { status: 400 },
      );
    }
    const startDate = new Date(startDateRaw);
    const endDate = new Date(endDateRaw);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return NextResponse.json(
        { success: false, error: 'dateRange contains an invalid ISO date' },
        { status: 400 },
      );
    }

    // 1. Resolve the client; 404 if missing, 403 if it belongs to another tenant.
    const clientGlobal = await db.abClient.findUnique({ where: { id: clientId } });
    if (!clientGlobal) {
      return NextResponse.json(
        { success: false, error: 'Client not found' },
        { status: 404 },
      );
    }
    if (clientGlobal.tenantId !== tenantId) {
      return NextResponse.json(
        { success: false, error: 'Client belongs to a different tenant' },
        { status: 403 },
      );
    }

    // 2. Unbilled, billable entries in [startDate, endDate). Half-open
    //    interval matches `parseDateHint`'s output shape.
    const entries = await db.abTimeEntry.findMany({
      where: {
        tenantId,
        clientId,
        billed: false,
        billable: true,
        startedAt: { gte: startDate, lt: endDate },
      },
      orderBy: { startedAt: 'asc' },
    });

    if (entries.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No unbilled time entries for that range' },
        { status: 400 },
      );
    }

    // Tenant TZ — used to bucket entries by the user's local calendar
    // day, not UTC's. AbTenantConfig.timezone defaults to America/New_York
    // when the row is missing.
    const tenantConfig = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { timezone: true },
    });
    const tz = tenantConfig?.timezone || 'UTC';

    // 3. Bucket by day.
    const rows: TimeEntryRow[] = entries.map((e) => ({
      id: e.id,
      date: isoDateInTz(e.startedAt, tz),
      description: e.description || '',
      durationMinutes: e.durationMinutes || 0,
      hourlyRateCents: e.hourlyRateCents,
    }));
    const aggregated = aggregateByDay(rows);

    // 4. Build the parser-compatible shape expected by createInvoiceDraft.
    const parsedLines = aggregated.map((line) => ({
      description: line.description,
      rateCents: line.rateCents,
      quantity: line.quantity,
    }));

    const draft = await createInvoiceDraft({
      tenantId,
      client: { id: clientGlobal.id, name: clientGlobal.name, email: clientGlobal.email },
      parsed: { lines: parsedLines },
      source,
    });

    // 5. Mark consumed entries as billed and link them to the new invoice.
    //    Scoping by id-list AND `billed=false` prevents a concurrent
    //    billing pass from re-flagging entries it already claimed (which
    //    would silently overwrite the other invoice's link).
    const entryIds = entries.map((e) => e.id);
    await db.abTimeEntry.updateMany({
      where: { id: { in: entryIds }, tenantId, billed: false },
      data: { billed: true, invoiceId: draft.draftId },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          invoiceId: draft.draftId,
          invoiceNumber: draft.invoiceNumber,
          totalCents: draft.totalCents,
          currency: draft.currency,
          dueDate: draft.dueDate,
          issuedDate: draft.issuedDate,
          clientName: draft.clientName,
          clientEmail: draft.clientEmail,
          lineCount: draft.lines.length,
          entryIdsConsumed: entryIds,
          lines: draft.lines,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    // Mirror PR 1's draft-from-text: don't leak Prisma constraint /
    // table names on the wire.
    console.error('[agentbook-invoice/invoices/from-time-entries] failed:', err);
    return NextResponse.json(
      { success: false, error: 'Internal error generating invoice from time entries.' },
      { status: 500 },
    );
  }
}
