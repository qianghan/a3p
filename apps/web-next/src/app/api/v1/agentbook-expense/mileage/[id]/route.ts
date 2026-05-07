/**
 * Single-entry mileage operations.
 *
 *   PATCH — recompute deductibleAmountCents at the current tier and
 *           atomically reverse the prior journal entry + post a new one
 *           (journal entries are immutable in this codebase, so edits
 *           are reversal + replacement, never line edits).
 *   DELETE — hard delete; reverse the linked journal entry first so
 *            the trial balance stays consistent.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getMileageRate } from '@/lib/agentbook-mileage-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface PatchBody {
  miles?: number;
  purpose?: string;
  clientId?: string | null;
}

async function resolveVehicleAccountId(tenantId: string, fallbackJournalLines?: { accountId: string; debitCents: number }[]): Promise<string | null> {
  // First, prefer the account the original JE used (so a re-post lands
  // on the same line of the trial balance).
  if (fallbackJournalLines) {
    const debitLine = fallbackJournalLines.find((l) => l.debitCents > 0);
    if (debitLine) return debitLine.accountId;
  }
  const acc = await db.abAccount.findFirst({
    where: {
      tenantId,
      accountType: 'expense',
      isActive: true,
      OR: [
        { taxCategory: { contains: 'Line 9', mode: 'insensitive' } },
        { taxCategory: { contains: '9281' } },
        { name: { contains: 'Vehicle', mode: 'insensitive' } },
        { name: { contains: 'Car', mode: 'insensitive' } },
        { code: '5100' },
        { code: '5300' },
      ],
    },
    select: { id: true },
  });
  return acc?.id || null;
}

async function resolveEquityAccountId(tenantId: string, fallbackJournalLines?: { accountId: string; creditCents: number }[]): Promise<string | null> {
  if (fallbackJournalLines) {
    const creditLine = fallbackJournalLines.find((l) => l.creditCents > 0);
    if (creditLine) return creditLine.accountId;
  }
  const acc = await db.abAccount.findFirst({
    where: {
      tenantId,
      accountType: 'equity',
      OR: [{ code: '3000' }, { name: { contains: 'Owner', mode: 'insensitive' } }],
    },
    select: { id: true },
  });
  return acc?.id || null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as PatchBody;

    const existing = await db.abMileageEntry.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'mileage entry not found' },
        { status: 404 },
      );
    }

    const newMiles = typeof body.miles === 'number' && isFinite(body.miles) && body.miles > 0
      ? body.miles
      : existing.miles;
    const newPurpose = (body.purpose && body.purpose.trim()) || existing.purpose;
    const newClientId = body.clientId === undefined ? existing.clientId : body.clientId;

    // Recompute the deductible amount at today's tier (CRA tiers depend
    // on the YTD-before-this-entry, which itself depends on whether we
    // count THIS entry in the running total — we exclude it so editing
    // is idempotent).
    const year = existing.date.getUTCFullYear();
    let ratePerUnitCents = existing.ratePerUnitCents;
    if (existing.jurisdiction === 'ca') {
      const start = new Date(Date.UTC(year, 0, 1));
      const end = new Date(Date.UTC(year + 1, 0, 1));
      const others = await db.abMileageEntry.findMany({
        where: {
          tenantId,
          unit: existing.unit,
          date: { gte: start, lt: end },
          NOT: { id },
        },
        select: { miles: true },
      });
      const ytd = others.reduce((s, r) => s + r.miles, 0);
      ratePerUnitCents = getMileageRate('ca', year, ytd).ratePerUnitCents;
    } else {
      ratePerUnitCents = getMileageRate('us', year, 0).ratePerUnitCents;
    }
    const newDeductibleCents = Math.round(newMiles * ratePerUnitCents);

    const updated = await db.$transaction(async (tx) => {
      let nextJeId: string | null = existing.journalEntryId;

      // Reverse + repost when the booked amount actually changed.
      if (existing.journalEntryId && newDeductibleCents !== existing.deductibleAmountCents) {
        const original = await tx.abJournalEntry.findUnique({
          where: { id: existing.journalEntryId },
          include: { lines: true },
        });
        if (original) {
          await tx.abJournalEntry.create({
            data: {
              tenantId,
              date: new Date(),
              memo: `REVERSAL: ${original.memo} (mileage edit)`,
              sourceType: 'mileage',
              sourceId: existing.id,
              verified: true,
              lines: {
                create: original.lines.map((l) => ({
                  accountId: l.accountId,
                  debitCents: l.creditCents,
                  creditCents: l.debitCents,
                  description: `Reversal: ${l.description || ''}`,
                })),
              },
            },
          });

          const vehicleAcctId = await resolveVehicleAccountId(tenantId, original.lines);
          const equityAcctId = await resolveEquityAccountId(tenantId, original.lines);
          if (vehicleAcctId && equityAcctId && newDeductibleCents > 0) {
            const replacement = await tx.abJournalEntry.create({
              data: {
                tenantId,
                date: existing.date,
                memo: `Mileage (amended): ${newMiles} ${existing.unit} — ${newPurpose}`,
                sourceType: 'mileage',
                sourceId: existing.id,
                verified: true,
                lines: {
                  create: [
                    {
                      accountId: vehicleAcctId,
                      debitCents: newDeductibleCents,
                      creditCents: 0,
                      description: `Mileage @ ${ratePerUnitCents}¢/${existing.unit}`,
                    },
                    {
                      accountId: equityAcctId,
                      debitCents: 0,
                      creditCents: newDeductibleCents,
                      description: 'Personal vehicle, no cash outlay',
                    },
                  ],
                },
              },
            });
            nextJeId = replacement.id;
          } else {
            nextJeId = null;
          }
        }
      }

      const row = await tx.abMileageEntry.update({
        where: { id },
        data: {
          miles: newMiles,
          purpose: newPurpose,
          clientId: newClientId,
          ratePerUnitCents,
          deductibleAmountCents: newDeductibleCents,
          journalEntryId: nextJeId,
        },
      });

      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: 'mileage.updated',
          actor: 'user',
          action: {
            mileageEntryId: id,
            previousMiles: existing.miles,
            newMiles,
            previousDeductibleCents: existing.deductibleAmountCents,
            newDeductibleCents,
          },
        },
      });

      return row;
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/mileage PATCH] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;

    const existing = await db.abMileageEntry.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'mileage entry not found' },
        { status: 404 },
      );
    }

    await db.$transaction(async (tx) => {
      // Reverse the JE before deleting the row so the ledger stays
      // self-consistent without us having to teach `AbJournalEntry`
      // about a missing source.
      if (existing.journalEntryId) {
        const original = await tx.abJournalEntry.findUnique({
          where: { id: existing.journalEntryId },
          include: { lines: true },
        });
        if (original) {
          await tx.abJournalEntry.create({
            data: {
              tenantId,
              date: new Date(),
              memo: `REVERSAL: ${original.memo} (mileage delete)`,
              sourceType: 'mileage',
              sourceId: existing.id,
              verified: true,
              lines: {
                create: original.lines.map((l) => ({
                  accountId: l.accountId,
                  debitCents: l.creditCents,
                  creditCents: l.debitCents,
                  description: `Reversal: ${l.description || ''}`,
                })),
              },
            },
          });
        }
      }
      await tx.abMileageEntry.delete({ where: { id } });
      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: 'mileage.deleted',
          actor: 'user',
          action: {
            mileageEntryId: id,
            miles: existing.miles,
            deductibleCents: existing.deductibleAmountCents,
          },
        },
      });
    });

    return NextResponse.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[agentbook-expense/mileage DELETE] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
