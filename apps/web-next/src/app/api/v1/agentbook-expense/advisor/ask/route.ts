/**
 * Expense advisor — natural language Q&A backed by Gemini.
 *
 * Receives a free-text `question` and optional `period` { start, end }.
 * Fetches all expenses in the period, builds category + vendor aggregates,
 * then asks Gemini to answer in the context of that data. Returns a
 * structured JSON response the agent brain formats for chat.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { advisorGemini, formatCents } from '@/lib/agentbook-advisor';
import { parsePeriodFromQuestion } from '@agentbook-core/period-parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const body = await request.json() as { question?: string; period?: { start?: string; end?: string } };
    const question = body.question?.trim();
    if (!question) {
      return NextResponse.json({ success: false, error: 'question is required' }, { status: 400 });
    }

    // Period: explicit override → NLP extraction from question → year-to-date
    let startDate: Date;
    let endDate: Date;
    let periodLabel: string;
    if (body.period?.start && body.period?.end) {
      startDate = new Date(body.period.start);
      endDate = new Date(body.period.end);
      periodLabel = `${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`;
    } else {
      const parsed = parsePeriodFromQuestion(question);
      startDate = parsed.startDate;
      endDate = parsed.endDate;
      periodLabel = parsed.label;
    }

    // Fetch expenses with vendor
    const expenses = await db.abExpense.findMany({
      where: { tenantId, isPersonal: false, deletedAt: null, date: { gte: startDate, lte: endDate } },
      include: { vendor: true },
      orderBy: { date: 'desc' },
    });

    // Resolve category names
    const catIds = [...new Set(expenses.map((e) => e.categoryId).filter(Boolean) as string[])];
    const catAccounts = catIds.length > 0
      ? await db.abAccount.findMany({ where: { id: { in: catIds }, tenantId }, select: { id: true, name: true } })
      : [];
    const catNameMap: Record<string, string> = Object.fromEntries(catAccounts.map((a) => [a.id, a.name]));

    // Aggregations
    const total = expenses.reduce((s, e) => s + e.amountCents, 0);

    const byCatRaw: Record<string, number> = {};
    for (const e of expenses) {
      const name = e.categoryId ? (catNameMap[e.categoryId] || e.categoryId) : 'Uncategorized';
      byCatRaw[name] = (byCatRaw[name] || 0) + e.amountCents;
    }
    const byCat = Object.entries(byCatRaw).sort(([, a], [, b]) => b - a).slice(0, 8);

    const byVendorRaw: Record<string, number> = {};
    for (const e of expenses) {
      const name = (e.vendor as any)?.name || 'Unknown';
      byVendorRaw[name] = (byVendorRaw[name] || 0) + e.amountCents;
    }
    const byVendor = Object.entries(byVendorRaw).sort(([, a], [, b]) => b - a).slice(0, 10);

    // Per-month breakdown (useful for multi-month questions)
    const byMonthRaw: Record<string, number> = {};
    for (const e of expenses) {
      const d = new Date(e.date);
      const key = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      byMonthRaw[key] = (byMonthRaw[key] || 0) + e.amountCents;
    }
    const byMonth = Object.entries(byMonthRaw).reverse();

    // Recent individual expenses (newest first)
    const recentExpenses = expenses.slice(0, 20).map((e) => {
      const vName = (e.vendor as any)?.name || 'Unknown';
      const catName = e.categoryId ? (catNameMap[e.categoryId] || 'Uncategorized') : 'Uncategorized';
      return `${new Date(e.date).toLocaleDateString()} | ${vName} | ${formatCents(e.amountCents)} | ${catName}${e.description ? ' | ' + e.description : ''}`;
    });

    const contextStr = [
      `Period: ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`,
      `Total expenses: ${formatCents(total)} (${expenses.length} transactions)`,
      `Top categories: ${byCat.map(([n, v]) => `${n}: ${formatCents(v)}`).join(', ')}`,
      `Top vendors: ${byVendor.map(([n, v]) => `${n}: ${formatCents(v)}`).join(', ')}`,
      byMonth.length > 1
        ? `By month: ${byMonth.map(([m, v]) => `${m}: ${formatCents(v)}`).join(', ')}`
        : '',
      `\nRecent expenses (newest first):`,
      `Date | Vendor | Amount | Category | Description`,
      ...recentExpenses,
    ].filter(Boolean).join('\n');

    const systemPrompt = `You are AgentBook Expense Advisor — a friendly, concise financial expert.
You have access to the user's expense data for the requested period.
Answer the question directly using the data provided. Include specific dollar amounts.
When listing top vendors or top spending, show the amounts prominently.
Respond in JSON: { "answer": "your answer (use \\n for line breaks)", "chartData": { "type": "bar"|"pie", "data": [{ "name": "string", "value": number_in_cents }] } | null, "suggestedActions": [{ "label": "string", "type": "suggestion" }] }
Only include chartData if visualization adds value. Keep the answer under 200 words.`;

    const llmResponse = await advisorGemini(systemPrompt, `Context:\n${contextStr}\n\nQuestion: ${question}`, 600);

    let answer = '';
    let chartData: unknown = null;
    let actions: { label: string; type: string }[] = [];

    if (llmResponse) {
      try {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          answer = parsed.answer || llmResponse;
          chartData = parsed.chartData || null;
          actions = (parsed.suggestedActions || []).map((a: { label: string; type?: string }) => ({
            label: a.label,
            type: a.type || 'suggestion',
          }));
        } else {
          answer = llmResponse;
        }
      } catch {
        answer = llmResponse;
      }
    }

    // Template fallback when Gemini unavailable
    if (!answer) {
      const q = question.toLowerCase();
      if (q.match(/vendor|who.*spend|top.*spend|spend.*most/)) {
        answer = byVendor.length > 0
          ? `Top vendors (${periodLabel}):\n\n` +
            byVendor.slice(0, 8).map(([n, v], i) => `${i + 1}. **${n}**: ${formatCents(v)}`).join('\n') +
            `\n\nTotal: ${formatCents(total)}`
          : `No expenses found for ${periodLabel}.`;
        chartData = byVendor.length > 0
          ? { type: 'bar', data: byVendor.slice(0, 8).map(([name, value]) => ({ name, value })) }
          : null;
      } else if (q.match(/top|most|biggest|largest|category/)) {
        answer = byCat.length > 0
          ? `Top categories (${periodLabel}):\n\n` + byCat.slice(0, 6).map(([n, v]) => `• **${n}**: ${formatCents(v)}`).join('\n') +
            `\n\nTotal: ${formatCents(total)}`
          : `No expenses found for ${periodLabel}.`;
        chartData = byCat.length > 0
          ? { type: 'bar', data: byCat.slice(0, 6).map(([name, value]) => ({ name, value })) }
          : null;
      } else {
        answer = expenses.length === 0
          ? `No business expenses found for ${periodLabel}.`
          : `You have ${expenses.length} expenses totaling ${formatCents(total)}.\n\nTop vendor: ${byVendor[0] ? `**${byVendor[0][0]}** (${formatCents(byVendor[0][1])})` : 'N/A'}\nTop category: ${byCat[0] ? `**${byCat[0][0]}** (${formatCents(byCat[0][1])})` : 'N/A'}`;
      }
      actions = [{ label: 'Show chart breakdown', type: 'suggestion' }];
    }

    // State the window, always. A total is meaningless without the period it
    // covers, and a misread period is indistinguishable from a wrong total
    // unless the answer says which one it used — that is what made the old
    // substring month-matching bug invisible (see parsePeriodFromQuestion).
    if (!answer.includes(periodLabel)) {
      answer = `${answer}\n\n_Period: ${periodLabel}._`;
    }

    return NextResponse.json({
      success: true,
      data: {
        answer,
        chartData,
        actions,
        period: { start: startDate.toISOString(), end: endDate.toISOString(), label: periodLabel },
        sources: ['expenses', 'categories', 'vendors'],
      },
    });
  } catch (err) {
    console.error('[agentbook-expense/advisor/ask] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
