/**
 * Mileage list + create — native Next.js route.
 *
 *   POST creates a mileage entry at the jurisdiction-correct rate AND
 *        posts a balanced journal entry (debit Vehicle Expense, credit
 *        Owner's Equity for the deductible amount, since no cash
 *        actually moved on a personal-vehicle business trip).
 *
 *   GET  lists entries (filterable) and, when `?summary=true`, returns
 *        monthly + YTD totals + per-client breakdown for the dashboard
 *        and the year-end aggregator.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getMileageRate } from '@/lib/agentbook-mileage-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface CreateMileageBody {
  date?: string;
  miles?: number;
  unit?: 'mi' | 'km';
  purpose?: string;
  clientId?: string;
  jurisdictionOverride?: 'us' | 'ca';
}

/**
 * Locate the chart-of-accounts row a mileage entry should debit. Falls
 * back through three rules:
 *   1. taxCategory = "Line 9" (US Schedule C, "Car and Truck") OR
 *      taxCategory = "9281" / "Box 9281" (T2125 Motor vehicle expenses)
 *   2. account name matches /vehicle|car & truck|motor/i
 *   3. account code 5100 (the seed default for US) or 5300 (spec hint)
 *
 * Returns null if no match — caller treats that as "skip JE, just save
 * the entry"; the user is told their chart of accounts needs seeding.
 */
async function resolveVehicleExpenseAccount(tenantId: string) {
  const candidates = await db.abAccount.findMany({
    where: { tenantId, accountType: 'expense', isActive: true },
    select: { id: true, code: true, name: true, taxCategory: true },
  });

  // 1. Tax-category match (US Line 9 / CA box 9281)
  let hit = candidates.find((a) =>
    a.taxCategory && /^line\s*9$|^9281$|box\s*9281/i.test(a.taxCategory),
  );
  if (hit) return hit;

  // 2. Name match
  hit = candidates.find((a) => /vehicle|car\s*&?\s*truck|motor/i.test(a.name));
  if (hit) return hit;

  // 3. Common codes — 5100 (seed default) before 5300 (spec hint)
  hit = candidates.find((a) => a.code === '5100' || a.code === '5300');
  return hit || null;
}

async function resolveOwnersEquityAccount(tenantId: string) {
  // The default chart names it "Owner's Equity" at code 3000.
  return db.abAccount.findFirst({
    where: {
      tenantId,
      accountType: 'equity',
      OR: [
        { code: '3000' },
        { name: { contains: 'Owner', mode: 'insensitive' } },
        { name: { contains: 'Equity', mode: 'insensitive' } },
      ],
    },
    select: { id: true, code: true, name: true },
  });
}

/**
 * Sum miles already booked this calendar year so the CRA tier picker
 * can decide low- vs. high-tier. Scoped by `unit` so a mixed-history
 * tenant (rare) doesn't accidentally count miles toward the km tier.
 */
async function ytdMilesOrKm(tenantId: string, year: number, unit: 'mi' | 'km'): Promise<number> {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const rows = await db.abMileageEntry.findMany({
    where: {
      tenantId,
      unit,
      date: { gte: start, lt: end },
    },
    select: { miles: true },
  });
  return rows.reduce((s, r) => s + r.miles, 0);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as CreateMileageBody;
    const miles = typeof body.miles === 'number' ? body.miles : NaN;

    if (!isFinite(miles) || miles <= 0) {
      return NextResponse.json(
        { success: false, error: 'miles must be a positive number' },
        { status: 400 },
      );
    }
    if (!body.purpose || !body.purpose.trim()) {
      return NextResponse.json(
        { success: false, error: 'purpose is required' },
        { status: 400 },
      );
    }

    // Jurisdiction snapshot: prefer override (the bot passes it after
    // looking it up), else read from tenant config, else default 'us'.
    let jurisdiction: 'us' | 'ca' = body.jurisdictionOverride === 'ca' ? 'ca' : 'us';
    if (!body.jurisdictionOverride) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
    }

    const date = body.date ? new Date(body.date) : new Date();
    const year = date.getUTCFullYear();

    // Default unit follows jurisdiction. The bot may also pass `unit`
    // explicitly when the user said "23 km" while in a US tenant —
    // we honour that but stamp the rate accordingly.
    const unit: 'mi' | 'km' = body.unit === 'km' || body.unit === 'mi'
      ? body.unit
      : (jurisdiction === 'ca' ? 'km' : 'mi');

    const ytd = jurisdiction === 'ca' ? await ytdMilesOrKm(tenantId, year, unit) : 0;
    const rate = getMileageRate(jurisdiction, year, ytd);
    // If the user gave us miles in a CA tenant (or vice-versa), the rate
    // table picked a per-km rate — we still trust the user's recorded
    // unit for the stored entry, but apply the jurisdiction's rate.
    const deductibleAmountCents = Math.round(miles * rate.ratePerUnitCents);

    // Try to post a journal entry. If the chart of accounts isn't
    // seeded we still save the entry — the user can rebuild the JE later.
    const vehicleAcct = await resolveVehicleExpenseAccount(tenantId);
    const equityAcct = await resolveOwnersEquityAccount(tenantId);

    const entry = await db.$transaction(async (tx) => {
      let journalEntryId: string | null = null;
      if (vehicleAcct && equityAcct && deductibleAmountCents > 0) {
        const memo = `Mileage: ${miles} ${unit} — ${body.purpose}`;
        const je = await tx.abJournalEntry.create({
          data: {
            tenantId,
            date,
            memo,
            sourceType: 'mileage',
            verified: true,
            lines: {
              create: [
                {
                  accountId: vehicleAcct.id,
                  debitCents: deductibleAmountCents,
                  creditCents: 0,
                  description: `Mileage @ ${rate.ratePerUnitCents}¢/${rate.unit}`,
                },
                {
                  accountId: equityAcct.id,
                  debitCents: 0,
                  creditCents: deductibleAmountCents,
                  description: 'Personal vehicle, no cash outlay',
                },
              ],
            },
          },
        });
        journalEntryId = je.id;
      }

      const created = await tx.abMileageEntry.create({
        data: {
          tenantId,
          date,
          miles,
          unit,
          purpose: body.purpose!.trim(),
          clientId: body.clientId || null,
          jurisdiction,
          ratePerUnitCents: rate.ratePerUnitCents,
          deductibleAmountCents,
          journalEntryId,
        },
      });

      // Backfill the JE.sourceId now that we have the mileage entry id.
      if (journalEntryId) {
        await tx.abJournalEntry.update({
          where: { id: journalEntryId },
          data: { sourceId: created.id },
        });
      }

      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: 'mileage.recorded',
          actor: 'agent',
          action: {
            mileageEntryId: created.id,
            miles,
            unit,
            jurisdiction,
            ratePerUnitCents: rate.ratePerUnitCents,
            deductibleAmountCents,
            clientId: body.clientId || null,
          },
        },
      });

      return created;
    });

    return NextResponse.json(
      {
        success: true,
        data: entry,
        meta: {
          rateReason: rate.reason,
          journalPosted: !!entry.journalEntryId,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[agentbook-expense/mileage POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const clientId = params.get('clientId') || undefined;
    const since = params.get('since');
    const until = params.get('until');
    const summary = params.get('summary') === 'true';

    const where: Record<string, unknown> = { tenantId };
    if (clientId) where.clientId = clientId;
    if (since || until) {
      const date: Record<string, Date> = {};
      if (since) date.gte = new Date(since);
      if (until) date.lt = new Date(until);
      where.date = date;
    }

    const entries = await db.abMileageEntry.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 500,
    });

    if (!summary) {
      return NextResponse.json({ success: true, data: entries });
    }

    // Summary mode: monthly + YTD totals + per-client breakdown.
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const ytd = entries.filter((e) => e.date >= yearStart);

    const monthly = new Map<string, { miles: number; deductibleCents: number; unit: 'mi' | 'km' }>();
    let ytdMiles = 0;
    let ytdDeductibleCents = 0;
    const byClient = new Map<string, { miles: number; deductibleCents: number; unit: 'mi' | 'km' }>();

    for (const e of ytd) {
      const ym = `${e.date.getUTCFullYear()}-${String(e.date.getUTCMonth() + 1).padStart(2, '0')}`;
      const slot = monthly.get(ym) || { miles: 0, deductibleCents: 0, unit: e.unit as 'mi' | 'km' };
      slot.miles += e.miles;
      slot.deductibleCents += e.deductibleAmountCents;
      monthly.set(ym, slot);

      ytdMiles += e.miles;
      ytdDeductibleCents += e.deductibleAmountCents;

      if (e.clientId) {
        const cslot = byClient.get(e.clientId) || { miles: 0, deductibleCents: 0, unit: e.unit as 'mi' | 'km' };
        cslot.miles += e.miles;
        cslot.deductibleCents += e.deductibleAmountCents;
        byClient.set(e.clientId, cslot);
      }
    }

    // Decorate by-client with names.
    const clientIds = Array.from(byClient.keys());
    const clients = clientIds.length
      ? await db.abClient.findMany({
          where: { id: { in: clientIds }, tenantId },
          select: { id: true, name: true },
        })
      : [];
    const clientName = new Map(clients.map((c) => [c.id, c.name]));

    return NextResponse.json({
      success: true,
      data: {
        entries,
        summary: {
          ytd: {
            miles: ytdMiles,
            deductibleCents: ytdDeductibleCents,
            entryCount: ytd.length,
          },
          monthly: Array.from(monthly.entries())
            .map(([month, s]) => ({ month, ...s }))
            .sort((a, b) => a.month.localeCompare(b.month)),
          byClient: Array.from(byClient.entries()).map(([id, s]) => ({
            clientId: id,
            clientName: clientName.get(id) || id,
            ...s,
          })),
        },
      },
    });
  } catch (err) {
    console.error('[agentbook-expense/mileage GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
