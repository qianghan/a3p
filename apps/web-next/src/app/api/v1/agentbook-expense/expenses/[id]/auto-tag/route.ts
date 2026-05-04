/**
 * Auto-tag a single expense based on vendor/description regex rules.
 * Adds tags to the expense without overwriting existing ones.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const TAG_RULES: [RegExp, string][] = [
  [/restaurant|cafe|coffee|starbucks|mcdonald|chipotle|uchi|canoe|alo|dinner|lunch|breakfast|food|eat/i, 'meals'],
  [/uber|lyft|taxi|cab|transit|subway|bus/i, 'transportation'],
  [/hotel|marriott|hyatt|hilton|airbnb|motel|inn/i, 'accommodation'],
  [/air canada|westjet|delta|united|american|flight|airline/i, 'flights'],
  [/adobe|figma|slack|notion|github|asana|shopify|grammarly|wordpress|aws|google cloud|azure/i, 'software'],
  [/apple|dell|wacom|samsung|lenovo|monitor|laptop|keyboard|mouse|printer/i, 'equipment'],
  [/insurance|manulife|hiscox|allstate|geico/i, 'insurance'],
  [/rent|lease|wework|cowork|office space/i, 'rent'],
  [/phone|internet|bell|rogers|comcast|att|verizon|tmobile/i, 'telecom'],
  [/usps|fedex|ups|dhl|shipping|postage/i, 'shipping'],
  [/google ads|facebook ads|marketing|advertising|promotion/i, 'marketing'],
  [/contractor|freelance|consultant/i, 'contractor'],
  [/costco|walmart|target|staples|office depot|supplies/i, 'supplies'],
  [/gas|gasoline|shell|esso|petro/i, 'fuel'],
  [/parking|meter/i, 'parking'],
  [/training|course|udemy|coursera|workshop|conference|seminar/i, 'education'],
  [/netflix|spotify|hulu|disney|entertainment|movie|theater/i, 'entertainment'],
  [/grocery|trader|whole foods|safeway|kroger/i, 'groceries'],
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;
    const expense = await db.abExpense.findFirst({
      where: { id, tenantId },
      include: { vendor: true },
    });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    const vendorName = (expense.vendor?.name || expense.description || '').toLowerCase();
    const tags: string[] = expense.tags
      ? expense.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    for (const [pattern, tag] of TAG_RULES) {
      if (pattern.test(vendorName) && !tags.includes(tag)) tags.push(tag);
    }
    if (expense.amountCents > 100000 && !tags.includes('high-value')) tags.push('high-value');
    if (expense.amountCents < 1000 && !tags.includes('micro')) tags.push('micro');

    const tagString = [...new Set(tags)].join(',');
    await db.abExpense.update({ where: { id }, data: { tags: tagString } });

    return NextResponse.json({
      success: true,
      data: { expenseId: id, tags: tagString.split(',').filter(Boolean) },
    });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/auto-tag] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
