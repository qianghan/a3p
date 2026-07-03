/**
 * Seed a default chart of accounts for the tenant's jurisdiction.
 *
 * Uses the US Schedule-C-style chart for now (the legacy handler also
 * defaults to US even when jurisdiction='ca'). Re-runnable: upserts
 * by (tenantId, code).
 *
 * businessType='student' gets a separate set — tuition/scholarship/gig
 * income isn't a Schedule-C business and the US_ACCOUNTS categories
 * (Commissions & Fees, Contract Labor, Legal & Professional, ...) don't
 * match what a student actually needs to track.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const US_ACCOUNTS: { code: string; name: string; accountType: string; taxCategory?: string }[] = [
  { code: '1000', name: 'Cash', accountType: 'asset' },
  { code: '1100', name: 'Accounts Receivable', accountType: 'asset' },
  { code: '1200', name: 'Business Checking', accountType: 'asset' },
  { code: '2000', name: 'Accounts Payable', accountType: 'liability' },
  { code: '2100', name: 'Sales Tax Payable', accountType: 'liability' },
  { code: '3000', name: "Owner's Equity", accountType: 'equity' },
  { code: '4000', name: 'Service Revenue', accountType: 'revenue', taxCategory: 'Line 1' },
  { code: '5000', name: 'Advertising', accountType: 'expense', taxCategory: 'Line 8' },
  { code: '5100', name: 'Car & Truck', accountType: 'expense', taxCategory: 'Line 9' },
  { code: '5200', name: 'Commissions & Fees', accountType: 'expense', taxCategory: 'Line 10' },
  { code: '5300', name: 'Contract Labor', accountType: 'expense', taxCategory: 'Line 11' },
  { code: '5400', name: 'Insurance', accountType: 'expense', taxCategory: 'Line 15' },
  { code: '5700', name: 'Legal & Professional', accountType: 'expense', taxCategory: 'Line 17' },
  { code: '5800', name: 'Office Expenses', accountType: 'expense', taxCategory: 'Line 18' },
  { code: '5900', name: 'Rent', accountType: 'expense', taxCategory: 'Line 20b' },
  { code: '6100', name: 'Supplies', accountType: 'expense', taxCategory: 'Line 22' },
  { code: '6300', name: 'Travel', accountType: 'expense', taxCategory: 'Line 24a' },
  { code: '6400', name: 'Meals', accountType: 'expense', taxCategory: 'Line 24b' },
  { code: '6500', name: 'Utilities', accountType: 'expense', taxCategory: 'Line 25' },
  { code: '6600', name: 'Software & Subscriptions', accountType: 'expense', taxCategory: 'Line 27a' },
  { code: '6700', name: 'Bank Fees', accountType: 'expense', taxCategory: 'Line 27a' },
];

const STUDENT_ACCOUNTS: { code: string; name: string; accountType: string; taxCategory?: string }[] = [
  { code: '1000', name: 'Cash', accountType: 'asset' },
  { code: '1200', name: 'Checking / Debit Account', accountType: 'asset' },
  { code: '3000', name: "Owner's Equity", accountType: 'equity' },
  { code: '4000', name: 'Part-Time Job Income', accountType: 'revenue' },
  { code: '4100', name: 'Tutoring / Gig Income', accountType: 'revenue', taxCategory: 'Schedule C' },
  { code: '4200', name: 'Scholarship / Grant Income', accountType: 'revenue' },
  { code: '4300', name: 'Family Support / Allowance', accountType: 'revenue' },
  { code: '5000', name: 'Tuition & Fees', accountType: 'expense', taxCategory: '1098-T / T2202' },
  { code: '5100', name: 'Textbooks & Course Materials', accountType: 'expense' },
  { code: '5200', name: 'Rent / Housing', accountType: 'expense' },
  { code: '5300', name: 'Meal Plan / Groceries', accountType: 'expense' },
  { code: '5400', name: 'Transportation', accountType: 'expense' },
  { code: '5500', name: 'Phone & Software Subscriptions', accountType: 'expense' },
  { code: '5600', name: 'Student Loan Interest', accountType: 'expense', taxCategory: '1098-E' },
];

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const tenantConfig = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { businessType: true },
    });
    // TODO: also branch on AbTenantConfig.jurisdiction when a CA chart lands.
    const accounts = tenantConfig?.businessType === 'student' ? STUDENT_ACCOUNTS : US_ACCOUNTS;

    const created = await db.$transaction(
      accounts.map((a) =>
        db.abAccount.upsert({
          where: { tenantId_code: { tenantId, code: a.code } },
          update: { name: a.name, accountType: a.accountType, taxCategory: a.taxCategory },
          create: { tenantId, ...a },
        }),
      ),
    );

    return NextResponse.json({ success: true, data: { count: created.length } });
  } catch (err) {
    console.error('[agentbook-core/accounts/seed-jurisdiction] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
