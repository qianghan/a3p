/**
 * Seed a default chart of accounts for the tenant's jurisdiction.
 *
 * Real, tested jurisdiction-pack charts — replaces the previously
 * duplicated, US-only inline account list (and the silent "always US"
 * fallback for every other jurisdiction, including ca and au) with the
 * same us/ca/au ChartOfAccountsTemplate packs already used elsewhere in
 * the tax engine. Re-runnable: upserts by (tenantId, code).
 *
 * businessType='student' gets a separate set — tuition/scholarship/gig
 * income isn't a Schedule-C/T2125/BAS business in any jurisdiction, and
 * there's no per-jurisdiction student chart pack to consume.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { usChartOfAccounts } from '@agentbook/jurisdictions/us/chart-of-accounts';
import { caChartOfAccounts } from '@agentbook/jurisdictions/ca/chart-of-accounts';
import { auChartOfAccounts } from '@agentbook/jurisdictions/au/chart-of-accounts';
import type { ChartOfAccountsTemplate } from '@agentbook/jurisdictions/interfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CHART_PROVIDERS: Record<string, ChartOfAccountsTemplate> = {
  us: usChartOfAccounts,
  ca: caChartOfAccounts,
  au: auChartOfAccounts,
};

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
      select: { businessType: true, jurisdiction: true },
    });

    let accounts: { code: string; name: string; accountType: string; taxCategory?: string }[];
    if (tenantConfig?.businessType === 'student') {
      accounts = STUDENT_ACCOUNTS;
    } else {
      const jurisdiction = tenantConfig?.jurisdiction || 'us';
      const provider = CHART_PROVIDERS[jurisdiction] ?? usChartOfAccounts;
      accounts = provider.getDefaultAccounts(tenantConfig?.businessType ?? 'freelancer').map((a) => ({
        code: a.code,
        name: a.name,
        accountType: a.type,
        taxCategory: a.taxCategory,
      }));
    }

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
