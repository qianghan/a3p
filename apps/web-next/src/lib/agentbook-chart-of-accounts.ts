/**
 * Chart of accounts — seeding, shared by onboarding and the ledger paths.
 *
 * The chart used to be created ONLY when a user completed the onboarding flow
 * (Onboarding.tsx / OnboardingChat.tsx call POST accounts/seed-jurisdiction).
 * Signup doesn't seed it. So a user who signed up and skipped or abandoned
 * onboarding had no Cash (1000) / A/R (1100) account — and every posting path
 * silently skipped the ledger, leaving their P&L, trial balance and tax
 * estimate quietly missing real money, with no error shown.
 *
 * `ensureChartOfAccounts` makes that unreachable: the posting paths seed on
 * demand instead of giving up. It's cheap (one indexed lookup when the chart
 * already exists) and idempotent (upsert by tenantId+code), so it's safe to
 * call on any write path.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { usChartOfAccounts } from '@agentbook/jurisdictions/us/chart-of-accounts';
import { caChartOfAccounts } from '@agentbook/jurisdictions/ca/chart-of-accounts';
import { auChartOfAccounts } from '@agentbook/jurisdictions/au/chart-of-accounts';
import type { ChartOfAccountsTemplate } from '@agentbook/jurisdictions/interfaces';

const CHART_PROVIDERS: Record<string, ChartOfAccountsTemplate> = {
  us: usChartOfAccounts,
  ca: caChartOfAccounts,
  au: auChartOfAccounts,
};

/** Cash — every expense/payment journal credits or debits it. Its absence is what breaks posting. */
export const CASH_CODE = '1000';

/**
 * Suspense account for expenses recorded before their category is known.
 *
 * Posting used to be gated on a resolved category, so an expense with no
 * categoryId and no matching vendor pattern was created `status: 'confirmed'`
 * and posted NOTHING — missing from P&L, the trial balance and the tax
 * estimate, and missing from the review queue too (that filters on
 * `pending_review`, which such an expense never gets). The money left the
 * user's bank either way, so the books have to say so.
 */
export const UNCATEGORIZED_CODE = '6999';

/**
 * businessType='student' gets a separate set — tuition/scholarship/gig income
 * isn't a Schedule-C/T2125/BAS business in any jurisdiction, and there's no
 * per-jurisdiction student chart pack to consume.
 */
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
  { code: UNCATEGORIZED_CODE, name: 'Uncategorized Expenses', accountType: 'expense' },
];

/** The default accounts for a tenant, by businessType + jurisdiction. Pure. */
export async function defaultAccountsFor(
  tenantId: string,
): Promise<{ code: string; name: string; accountType: string; taxCategory?: string }[]> {
  const cfg = await db.abTenantConfig.findUnique({
    where: { userId: tenantId },
    select: { businessType: true, jurisdiction: true },
  });

  if (cfg?.businessType === 'student') return STUDENT_ACCOUNTS;

  const provider = CHART_PROVIDERS[cfg?.jurisdiction || 'us'] ?? usChartOfAccounts;
  return provider.getDefaultAccounts(cfg?.businessType ?? 'freelancer').map((a) => ({
    code: a.code,
    name: a.name,
    accountType: a.type,
    taxCategory: a.taxCategory,
  }));
}

/**
 * Guarantee the tenant has a chart of accounts, seeding it if absent.
 *
 * Idempotent (upsert by tenantId+code) and cheap on the hot path: when the Cash
 * account already exists it does one indexed lookup and returns. Pass
 * `force: true` to re-upsert the full chart regardless (used by the explicit
 * onboarding seed endpoint, which should refresh names/tax categories).
 */
export async function ensureChartOfAccounts(
  tenantId: string,
  opts?: { force?: boolean },
): Promise<{ seeded: boolean; count: number }> {
  if (!opts?.force) {
    // findUnique on the (tenantId, code) compound unique — a direct index hit,
    // so this guard stays cheap on every write path.
    const cash = await db.abAccount.findUnique({
      where: { tenantId_code: { tenantId, code: CASH_CODE } },
      select: { id: true },
    });
    if (cash) return { seeded: false, count: 0 };
  }

  const accounts = await defaultAccountsFor(tenantId);
  const written = await db.$transaction(
    accounts.map((a) =>
      db.abAccount.upsert({
        where: { tenantId_code: { tenantId, code: a.code } },
        update: { name: a.name, accountType: a.accountType, taxCategory: a.taxCategory },
        create: { tenantId, ...a },
      }),
    ),
  );

  return { seeded: true, count: written.length };
}

/**
 * Guarantee the suspense account exists and return it.
 *
 * Separate from `ensureChartOfAccounts` on purpose: that one short-circuits as
 * soon as Cash exists, so adding 6999 to the jurisdiction packs reaches NEW
 * tenants only — every already-seeded tenant would never get the account, and
 * the uncategorized-posting path would silently do nothing for exactly the
 * users who already have expenses. This upserts the single account by the
 * (tenantId, code) compound unique, so it is idempotent and correct for both.
 *
 * Only called when an expense fails to resolve a category, so it stays off the
 * hot path.
 */
export async function ensureUncategorizedAccount(tenantId: string): Promise<{ id: string }> {
  return db.abAccount.upsert({
    where: { tenantId_code: { tenantId, code: UNCATEGORIZED_CODE } },
    update: {},
    create: {
      tenantId,
      code: UNCATEGORIZED_CODE,
      name: 'Uncategorized Expenses',
      accountType: 'expense',
    },
    select: { id: true },
  });
}
