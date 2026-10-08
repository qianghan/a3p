/**
 * "Next up" for the mobile app: AbCalendarEvent rows, estimated-tax
 * instalments and open bills, merged and sorted by date. Read-only — unlike
 * GET /agentbook-tax/tax/quarterly, this never creates instalment rows.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { getQuarterlyDeadlines } from '@/lib/agentbook-quarterly-deadlines';
import type { UpcomingItem } from './types';

const DAY_MS = 86_400_000;
export const UPCOMING_MIN_DAYS = 1;
export const UPCOMING_MAX_DAYS = 90;
const OPEN_CALENDAR_STATUSES = ['upcoming', 'alerted', 'snoozed'];
const KIND_ORDER: Record<UpcomingItem['kind'], number> = { tax: 0, bill: 1, calendar: 2 };

export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Whole UTC calendar days from `from` to `to` (negative when `to` is in the past). */
export function daysBetweenUtc(from: Date, to: Date): number {
  return Math.round((utcDayStart(to).getTime() - utcDayStart(from).getTime()) / DAY_MS);
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export async function getUpcoming(tenantId: string, days: number, now: Date = new Date()): Promise<UpcomingItem[]> {
  const span = Math.min(UPCOMING_MAX_DAYS, Math.max(UPCOMING_MIN_DAYS, Math.floor(days)));
  const start = utcDayStart(now);
  const end = new Date(start.getTime() + (span + 1) * DAY_MS - 1);

  const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId }, select: { jurisdiction: true } });
  const jurisdiction = cfg?.jurisdiction || 'us';
  const year = now.getUTCFullYear();
  // AU instalments of FY(y-1) fall in calendar year y; US Q4 of y falls in y+1.
  const years = [year - 1, year, year + 1];

  const [events, quarterlyRows, bills] = await Promise.all([
    db.abCalendarEvent.findMany({
      where: { tenantId, date: { gte: start, lte: end }, status: { in: OPEN_CALENDAR_STATUSES } },
      orderBy: { date: 'asc' },
    }),
    db.abQuarterlyPayment.findMany({ where: { tenantId, jurisdiction, year: { in: years } } }),
    db.abBill.findMany({
      where: { tenantId, status: 'open', dueDate: { gte: start, lte: end } },
      orderBy: { dueDate: 'asc' },
    }),
  ]);

  const items: UpcomingItem[] = [];
  const taxDays = new Set<string>();

  for (const y of years) {
    for (const dl of getQuarterlyDeadlines(y, jurisdiction)) {
      const row = quarterlyRows.find((r) => r.year === y && r.quarter === dl.quarter);
      const deadline = row?.deadline ?? dl.deadline;
      if (deadline < start || deadline > end) continue;
      taxDays.add(isoDay(deadline));
      const amountCents = row && row.amountDueCents > 0 ? row.amountDueCents - row.amountPaidCents : null;
      if (amountCents !== null && amountCents <= 0) continue; // paid in full
      items.push({
        id: `tax:${jurisdiction}:${y}:Q${dl.quarter}`,
        kind: 'tax',
        titleKey: 'mobile.upcoming.tax_instalment',
        params: { quarter: dl.quarter, year: y },
        date: isoDay(deadline),
        daysAway: daysBetweenUtc(now, deadline),
        amountCents,
      });
    }
  }

  for (const ev of events) {
    // A calendar tax-deadline row duplicates the instalment above, which carries the amount.
    if (ev.eventType === 'tax_deadline' && taxDays.has(isoDay(ev.date))) continue;
    items.push({
      id: `cal:${ev.id}`,
      kind: 'calendar',
      titleKey: ev.titleKey,
      params: {},
      date: isoDay(ev.date),
      daysAway: daysBetweenUtc(now, ev.date),
      amountCents: null,
    });
  }

  for (const b of bills) {
    items.push({
      id: `bill:${b.id}`,
      kind: 'bill',
      titleKey: 'mobile.upcoming.bill_due',
      params: { vendor: b.vendorName },
      date: isoDay(b.dueDate),
      daysAway: daysBetweenUtc(now, b.dueDate),
      amountCents: b.amountCents,
    });
  }

  return items.sort(
    (a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
  );
}
