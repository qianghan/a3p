/**
 * Auto-detect recurring monthly outflows from expense history.
 * Single high-confidence threshold: ≥3 occurrences in last 90 days at
 * 25–35 day cadence with amounts within ±10%. False positives are rare;
 * users get no UI to suppress them in V1.
 */

import { db } from '../db/client.js';

export interface ExpenseRow {
  id: string;
  vendor: string;
  amountCents: number;
  date: Date;
}

export interface RecurringOutflow {
  vendor: string;
  amountCents: number;       // average of cluster
  nextExpectedDate: string;  // ISO date (YYYY-MM-DD)
}

const MIN_OCCURRENCES = 3;
const MIN_CADENCE_DAYS = 25;
const MAX_CADENCE_DAYS = 35;
const AMOUNT_TOLERANCE = 0.10;
const LOOKBACK_DAYS = 90;

function normalizeVendor(v: string): string {
  return v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function detectRecurringFromHistory(
  rows: ExpenseRow[],
  today: Date
): RecurringOutflow[] {
  const byVendor = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    const key = normalizeVendor(r.vendor);
    if (!key) continue;
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key)!.push(r);
  }

  const out: RecurringOutflow[] = [];

  for (const cluster of byVendor.values()) {
    if (cluster.length < MIN_OCCURRENCES) continue;
    cluster.sort((a, b) => a.date.getTime() - b.date.getTime());

    const meanAmount = avg(cluster.map(c => c.amountCents));
    const tolerance = meanAmount * AMOUNT_TOLERANCE;
    if (cluster.some(c => Math.abs(c.amountCents - meanAmount) > tolerance)) continue;

    const gaps: number[] = [];
    for (let i = 1; i < cluster.length; i++) {
      gaps.push(daysBetween(cluster[i].date, cluster[i - 1].date));
    }
    if (gaps.some(g => g < MIN_CADENCE_DAYS || g > MAX_CADENCE_DAYS)) continue;

    const lastDate = cluster[cluster.length - 1].date;
    const avgCadence = Math.round(avg(gaps));
    const next = new Date(lastDate);
    next.setDate(next.getDate() + avgCadence);
    if (next < today) continue;

    out.push({
      vendor: cluster[0].vendor,
      amountCents: Math.round(meanAmount),
      nextExpectedDate: next.toISOString().slice(0, 10),
    });
  }

  return out.sort((a, b) => a.nextExpectedDate.localeCompare(b.nextExpectedDate));
}

export async function detectRecurringForTenant(
  tenantId: string,
  today: Date = new Date()
): Promise<RecurringOutflow[]> {
  const since = new Date(today);
  since.setDate(since.getDate() - LOOKBACK_DAYS);

  const expenses = await db.abExpense.findMany({
    where: { tenantId, isPersonal: false, date: { gte: since } },
    select: { id: true, description: true, amountCents: true, date: true, vendor: true },
  });

  const rows: ExpenseRow[] = expenses.map((e: any) => ({
    id: e.id,
    vendor: e.vendor || e.description || '',
    amountCents: e.amountCents,
    date: e.date,
  }));

  return detectRecurringFromHistory(rows, today);
}
