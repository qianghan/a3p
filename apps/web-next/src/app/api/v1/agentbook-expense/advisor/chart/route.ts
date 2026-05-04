/**
 * Advisor chart — group expenses by category (or by month for trend
 * type), with optional comparison period and a one-sentence Gemini
 * annotation explaining the biggest mover.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { advisorGemini, formatCents } from '@/lib/agentbook-advisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899', '#ef4444', '#84cc16'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface ChartDatum {
  name: string;
  value: number;
  color: string;
  previousValue?: number;
  changePercent?: number | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const params = request.nextUrl.searchParams;

    const now = new Date();
    const startDate = params.get('startDate') ? new Date(params.get('startDate')!) : new Date(now.getFullYear(), 0, 1);
    const endDate = params.get('endDate') ? new Date(params.get('endDate')!) : now;
    const chartType = params.get('chartType') || 'bar';

    const expenses = await db.abExpense.findMany({
      where: { tenantId, date: { gte: startDate, lte: endDate } },
    });

    let compExpenses: { categoryId: string | null; amountCents: number }[] = [];
    if (params.get('compareStartDate') && params.get('compareEndDate')) {
      compExpenses = await db.abExpense.findMany({
        where: {
          tenantId,
          date: {
            gte: new Date(params.get('compareStartDate')!),
            lte: new Date(params.get('compareEndDate')!),
          },
        },
        select: { categoryId: true, amountCents: true },
      });
    }

    const allCatIds = new Set<string>();
    [...expenses, ...compExpenses].forEach((e) => {
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

    let data: ChartDatum[] = [];
    let title = '';
    const subtitle = `${startDate.toLocaleDateString()} — ${endDate.toLocaleDateString()}`;

    if (chartType === 'trend') {
      const monthMap: Record<string, number> = {};
      expenses.forEach((e) => {
        const d = new Date(e.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthMap[key] = (monthMap[key] || 0) + e.amountCents;
      });
      data = Object.entries(monthMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value], i) => {
          const month = parseInt(key.split('-')[1], 10) - 1;
          return { name: MONTH_NAMES[month], value, color: COLORS[i % COLORS.length] };
        });
      title = 'Monthly Spending Trend';
    } else {
      const catTotals: Record<string, number> = {};
      expenses.forEach((e) => {
        const cat = e.categoryId || 'uncategorized';
        catTotals[cat] = (catTotals[cat] || 0) + e.amountCents;
      });
      const compCatTotals: Record<string, number> = {};
      compExpenses.forEach((e) => {
        const cat = e.categoryId || 'uncategorized';
        compCatTotals[cat] = (compCatTotals[cat] || 0) + e.amountCents;
      });

      data = Object.entries(catTotals)
        .sort(([, a], [, b]) => b - a)
        .map(([catId, value], i) => {
          const name = catId === 'uncategorized' ? 'Uncategorized' : catNameMap[catId] || catId;
          const entry: ChartDatum = { name, value, color: COLORS[i % COLORS.length] };
          if (compExpenses.length > 0) {
            const prev = compCatTotals[catId] || 0;
            entry.previousValue = prev;
            entry.changePercent = prev > 0 ? Math.round(((value - prev) / prev) * 100) : null;
          }
          return entry;
        });
      title = chartType === 'pie' ? 'Expense Breakdown' : 'Expenses by Category';
    }

    let annotation = '';
    if (data.length > 0) {
      const biggest = data.reduce((max, d) => (d.value > max.value ? d : max), data[0]);
      const totalValue = data.reduce((s, d) => s + d.value, 0);
      const prompt = `Given expense chart data: ${JSON.stringify(data.map((d) => ({ name: d.name, amount: formatCents(d.value) })))}. Total: ${formatCents(totalValue)}. Provide a single-sentence insight.`;
      const llmAnnotation = await advisorGemini(
        'You are a concise financial analyst. Respond with exactly one sentence of insight about the spending data.',
        prompt,
        150,
      );
      annotation = llmAnnotation || `${biggest.name} is your largest expense at ${formatCents(biggest.value)}.`;
    }

    return NextResponse.json({
      success: true,
      data: { chartType, title, subtitle, data, annotation },
    });
  } catch (err) {
    console.error('[agentbook-expense/advisor/chart] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
