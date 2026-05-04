/**
 * Advisor insights — generates 6 types of automatic findings:
 * spending spikes, anomalies (3x rolling avg), duplicates,
 * missing receipts, uncategorized expenses, and recurring-vendor
 * savings opportunities. Pure code, no LLM call.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { formatCents } from '@/lib/agentbook-advisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Insight {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  data: Record<string, unknown>;
  action?: { label: string; type: string; target: string };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;
    const now = new Date();
    const startDate = params.get('startDate') ? new Date(params.get('startDate')!) : new Date(now.getFullYear(), 0, 1);
    const endDate = params.get('endDate') ? new Date(params.get('endDate')!) : now;
    const periodMs = endDate.getTime() - startDate.getTime();
    const prevStart = new Date(startDate.getTime() - periodMs);
    const prevEnd = new Date(startDate.getTime());

    const insights: Insight[] = [];
    let idx = 0;

    const [currentExpenses, prevExpenses] = await Promise.all([
      db.abExpense.findMany({ where: { tenantId, date: { gte: startDate, lte: endDate } } }),
      db.abExpense.findMany({ where: { tenantId, date: { gte: prevStart, lt: prevEnd } } }),
    ]);

    const allCatIds = new Set<string>();
    [...currentExpenses, ...prevExpenses].forEach((e) => {
      if (e.categoryId) allCatIds.add(e.categoryId);
    });
    const catAccounts = allCatIds.size > 0
      ? await db.abAccount.findMany({
          where: { id: { in: Array.from(allCatIds) } },
          select: { id: true, name: true },
        })
      : [];
    const catNameMap: Record<string, string> = {};
    catAccounts.forEach((a) => {
      catNameMap[a.id] = a.name;
    });

    // 1. Spending spikes
    const groupBy = (list: typeof currentExpenses): Record<string, number> => {
      const m: Record<string, number> = {};
      list.forEach((e) => {
        if (e.categoryId) m[e.categoryId] = (m[e.categoryId] || 0) + e.amountCents;
      });
      return m;
    };
    const curByCat = groupBy(currentExpenses);
    const prevByCat = groupBy(prevExpenses);
    for (const catId of Object.keys(curByCat)) {
      const cur = curByCat[catId];
      const prev = prevByCat[catId] || 0;
      if (prev > 0) {
        const pct = ((cur - prev) / prev) * 100;
        if (pct > 20) {
          const severity = pct > 50 ? 'critical' : 'warning';
          const catName = catNameMap[catId] || catId;
          insights.push({
            id: `insight-${++idx}`,
            type: 'spending_spike',
            severity,
            title: `Spending spike in ${catName}`,
            message: `${catName} spending increased ${Math.round(pct)}% from ${formatCents(prev)} to ${formatCents(cur)}.`,
            data: { categoryId: catId, categoryName: catName, currentAmount: cur, previousAmount: prev, changePercent: Math.round(pct) },
          });
        }
      }
    }

    // 2. Anomalies — > 3x 90-day rolling average per category
    const ninetyDaysAgo = new Date(endDate.getTime() - 90 * 86_400_000);
    const rollingExpenses = await db.abExpense.findMany({
      where: { tenantId, date: { gte: ninetyDaysAgo, lte: endDate } },
    });
    const catAvg: Record<string, { total: number; count: number }> = {};
    rollingExpenses.forEach((e) => {
      if (e.categoryId) {
        if (!catAvg[e.categoryId]) catAvg[e.categoryId] = { total: 0, count: 0 };
        catAvg[e.categoryId].total += e.amountCents;
        catAvg[e.categoryId].count += 1;
      }
    });
    for (const e of currentExpenses) {
      if (e.categoryId && catAvg[e.categoryId] && catAvg[e.categoryId].count >= 2) {
        const avg = catAvg[e.categoryId].total / catAvg[e.categoryId].count;
        if (e.amountCents > avg * 3) {
          const catName = catNameMap[e.categoryId] || e.categoryId;
          insights.push({
            id: `insight-${++idx}`,
            type: 'anomaly',
            severity: 'warning',
            title: `Unusual expense in ${catName}`,
            message: `${formatCents(e.amountCents)} is ${Math.round(e.amountCents / avg)}x the 90-day average of ${formatCents(Math.round(avg))} for ${catName}.`,
            data: { expenseId: e.id, amount: e.amountCents, average: Math.round(avg), categoryName: catName },
          });
        }
      }
    }

    // 3. Duplicates
    const sorted = [...currentExpenses].sort((a, b) => a.date.getTime() - b.date.getTime());
    const seenDups = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (!a.vendorId || a.vendorId !== b.vendorId) continue;
        const dayDiff = Math.abs(a.date.getTime() - b.date.getTime()) / 86_400_000;
        if (dayDiff > 3) break;
        const amtDiff = Math.abs(a.amountCents - b.amountCents) / Math.max(a.amountCents, b.amountCents);
        if (amtDiff <= 0.05) {
          const key = [a.id, b.id].sort().join('-');
          if (!seenDups.has(key)) {
            seenDups.add(key);
            insights.push({
              id: `insight-${++idx}`,
              type: 'duplicate',
              severity: 'warning',
              title: 'Potential duplicate expense',
              message: `Two charges of ${formatCents(a.amountCents)} and ${formatCents(b.amountCents)} to the same vendor within ${Math.round(dayDiff)} day(s).`,
              data: { expenseIds: [a.id, b.id], amounts: [a.amountCents, b.amountCents] },
            });
          }
        }
      }
    }

    // 4. Missing receipts
    const missingReceipts = currentExpenses.filter((e) => !e.isPersonal && e.amountCents > 2500 && !e.receiptUrl);
    if (missingReceipts.length > 0) {
      insights.push({
        id: `insight-${++idx}`,
        type: 'missing_receipts',
        severity: 'info',
        title: `${missingReceipts.length} expense(s) missing receipts`,
        message: `${missingReceipts.length} business expense(s) over $25 are missing receipt documentation.`,
        data: { count: missingReceipts.length, expenseIds: missingReceipts.map((e) => e.id) },
      });
    }

    // 5. Uncategorized
    const uncategorized = currentExpenses.filter((e) => !e.categoryId);
    if (uncategorized.length > 0) {
      insights.push({
        id: `insight-${++idx}`,
        type: 'uncategorized',
        severity: 'info',
        title: `${uncategorized.length} uncategorized expense(s)`,
        message: `${uncategorized.length} expense(s) need category assignment for accurate reporting.`,
        data: { count: uncategorized.length, expenseIds: uncategorized.map((e) => e.id) },
      });
    }

    // 6. Recurring-vendor savings
    const sixMonthsAgo = new Date(endDate.getTime() - 180 * 86_400_000);
    const recentExpenses = await db.abExpense.findMany({
      where: { tenantId, date: { gte: sixMonthsAgo, lte: endDate }, vendorId: { not: null } },
      include: { vendor: true },
    });
    const byVendor: Record<string, { amounts: number[]; vendorName: string }> = {};
    recentExpenses.forEach((e) => {
      if (e.vendorId) {
        if (!byVendor[e.vendorId]) byVendor[e.vendorId] = { amounts: [], vendorName: e.vendor?.name || e.vendorId };
        byVendor[e.vendorId].amounts.push(e.amountCents);
      }
    });
    for (const [vendorId, info] of Object.entries(byVendor)) {
      if (info.amounts.length >= 3) {
        const avg = info.amounts.reduce((s, a) => s + a, 0) / info.amounts.length;
        const maxVariance = Math.max(...info.amounts.map((a) => Math.abs(a - avg) / avg));
        if (maxVariance <= 0.1) {
          const totalAnnual = avg * 12;
          insights.push({
            id: `insight-${++idx}`,
            type: 'savings',
            severity: 'info',
            title: `Savings opportunity with ${info.vendorName}`,
            message: `${info.amounts.length} recurring charges averaging ${formatCents(Math.round(avg))}. Consider an annual plan to save.`,
            data: {
              vendorId,
              vendorName: info.vendorName,
              chargeCount: info.amounts.length,
              averageAmount: Math.round(avg),
              estimatedAnnual: Math.round(totalAnnual),
            },
            action: { label: 'Review vendor', type: 'navigate', target: `/expenses?vendor=${vendorId}` },
          });
        }
      }
    }

    return NextResponse.json({ success: true, data: { insights } });
  } catch (err) {
    console.error('[agentbook-expense/advisor/insights] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
