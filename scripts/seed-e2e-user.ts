/**
 * Idempotent seed for the dedicated nightly e2e user.
 *
 * Usage (from CI or locally):
 *   npm run seed:e2e
 *
 * Or invoke via internal endpoint (used by the GHA workflow):
 *   POST /api/v1/e2e-test/reset-e2e-user
 *   Header: x-e2e-reset-token: <E2E_RESET_TOKEN>
 *
 * NOTE: The plan/spec docs reference the path as `/api/v1/__test/reset-e2e-user`,
 * but Next.js excludes any folder starting with `_` from App Router routing
 * (see https://nextjs.org/docs — "private folders"). The folder is therefore
 * named `e2e-test` so the route is actually reachable.
 *
 * Always operates on the fixed E2E_USER_ID UUID. Production users untouched.
 */

import { prisma as db } from '@naap/database';

const E2E_USER_ID = 'b9a80acd-fa14-4209-83a9-03231513fa8f';
const E2E_USER_EMAIL = 'e2e@agentbook.test';

interface ResetResult {
  userId: string;
  expensesCreated: number;
  invoicesCreated: number;
  clientsCreated: number;
  /** CA and AU tenants — see seedRegionalTenants. */
  regionalTenants: RegionalTenant[];
}

/**
 * @param opts.password Password to set, supplied by the caller.
 *
 * The nightly workflow passes the exact secret it is about to log in WITH,
 * which makes that one GitHub secret the single source of truth. Reading the
 * server's own `E2E_USER_PASSWORD` is what broke the suite originally: CI
 * authenticated with the GitHub secret while the server hashed a different
 * Vercel env var, so login could never succeed and no amount of correct product
 * code would have turned the suite green. Two independently-editable copies of
 * one value will always drift, so this removes the second copy instead of
 * asking a human to keep them in sync. The env fallback remains for local
 * `npm run seed:e2e`, where there is only ever one copy.
 */
export async function resetE2eUser(opts?: { password?: string }): Promise<ResetResult> {
  await db.user.upsert({
    where: { id: E2E_USER_ID },
    create: { id: E2E_USER_ID, email: E2E_USER_EMAIL, displayName: 'E2E Nightly' },
    update: { displayName: 'E2E Nightly', email: E2E_USER_EMAIL },
  });

  await ensurePassword(
    E2E_USER_ID,
    opts?.password || process.env.E2E_USER_PASSWORD || 'e2e-nightly-2026',
  );

  await db.abTenantConfig.upsert({
    where: { userId: E2E_USER_ID },
    create: {
      userId: E2E_USER_ID,
      jurisdiction: 'us',
      timezone: 'America/New_York',
      currency: 'USD',
      dailyDigestEnabled: true,
    },
    update: { dailyDigestEnabled: true },
  });

  const tenantId = E2E_USER_ID;

  // Wipe in FK-safe order: leaf rows first.
  //
  // Every delete used to end in `.catch(() => {})`, and that swallowing took the
  // whole suite down. A nightly test created a credit note; AbCreditNote.invoice
  // has NO `onDelete: Cascade`, so the invoice delete failed with a foreign-key
  // violation — silently discarded. The invoices survived the wipe, and the seed
  // then died creating them again with
  //   Unique constraint failed on the fields: (tenantId, number)
  // and every phase was skipped. The error named the CREATE, not the DELETE that
  // actually failed: the worst kind of error to be handed at 3am.
  //
  // So: no swallowing. A wipe that cannot complete says so, at the point of
  // failure, naming the table. If someone adds a child table later and misses
  // this list, that is exactly the behaviour we want.
  const wipe: [string, () => Promise<unknown>][] = [
    // Invoice children first. AbCreditNote, AbDeferredRevenue, AbPayment and
    // AbTimeEntry do NOT cascade, so they genuinely must precede AbInvoice.
    // AbInvoiceLine does cascade, but is listed anyway to keep the order
    // self-documenting rather than relying on the reader knowing which is which.
    ['abCreditNote', () => db.abCreditNote.deleteMany({ where: { tenantId } })],
    ['abDeferredRevenue', () => db.abDeferredRevenue.deleteMany({ where: { tenantId } })],
    ['abTimeEntry', () => db.abTimeEntry.deleteMany({ where: { tenantId } })],
    ['abInvoiceLine', () => db.abInvoiceLine.deleteMany({ where: { invoice: { tenantId } } })],
    ['abPayment', () => db.abPayment.deleteMany({ where: { tenantId } })],
    ['abInvoice', () => db.abInvoice.deleteMany({ where: { tenantId } })],
    // AbEstimate declares the only real FK to AbClient (no cascade), and the
    // phase4 estimate test creates one. AbRecurringInvoice has no declared
    // relation, but its rows accumulate from the same phase with no teardown,
    // so it goes too. Found by the loud wipe added moments earlier: it reported
    // `seed wipe failed at abClient` instead of leaving a half-wiped tenant and
    // surfacing later as an unrelated unique-constraint error. That is the whole
    // argument for not swallowing.
    ['abEstimate', () => db.abEstimate.deleteMany({ where: { tenantId } })],
    ['abRecurringInvoice', () => db.abRecurringInvoice.deleteMany({ where: { tenantId } })],
    ['abClient', () => db.abClient.deleteMany({ where: { tenantId } })],
    ['abExpense', () => db.abExpense.deleteMany({ where: { tenantId } })],
    ['abJournalLine', () => db.abJournalLine.deleteMany({ where: { entry: { tenantId } } })],
    ['abJournalEntry', () => db.abJournalEntry.deleteMany({ where: { tenantId } })],
    // These name an AbAccount id but have no relation to it, so the database
    // will happily let them outlive the account. The wipe recreates accounts
    // with fresh uuids every run, so anything left here points at nothing.
    //
    // That is not cosmetic: AbJournalLine.accountId DOES have a real foreign
    // key, so a surviving AbPattern made the next matching expense fail to
    // record at all with a raw Prisma FK error. Latent until #416 started
    // learning vendor→category patterns, at which point three expense
    // recordings broke in one eval run.
    ['abPattern', () => db.abPattern.deleteMany({ where: { tenantId } })],
    ['abExpenseSplit', () => db.abExpenseSplit.deleteMany({ where: { tenantId } })],
    ['abBudget', () => db.abBudget.deleteMany({ where: { tenantId } })],
    ['abAccount', () => db.abAccount.deleteMany({ where: { tenantId } })],
    // LEARNED AND CONVERSATIONAL STATE.
    //
    // None of this was being wiped, so every eval run inherited the previous
    // one's learning and the suite was not reproducible. That is not abstract:
    // AbUserMemory shortcuts are consulted at STAGE 1 of classification, before
    // triggerPatterns are even considered, and the loop breaks on the first
    // match. So a shortcut learned in an earlier run silently outranks the
    // routing config in this one.
    //
    // That is what made "and meals?" flip between runs on identical code — and
    // why adding a trigger pattern for it (#424) was necessary but not
    // sufficient. A guard on selectSkillByPatterns cannot govern a path that
    // never reaches selectSkillByPatterns.
    //
    // AbVendor goes after abExpense: AbExpense.vendorId references it with no
    // cascade.
    ['abUserMemory', () => db.abUserMemory.deleteMany({ where: { tenantId } })],
    ['abLearningEvent', () => db.abLearningEvent.deleteMany({ where: { tenantId } })],
    ['abConvThread', () => db.abConvThread.deleteMany({ where: { tenantId } })],
    ['abVendor', () => db.abVendor.deleteMany({ where: { tenantId } })],
    ['abConversation', () => db.abConversation.deleteMany({ where: { tenantId } })],
    ['abAgentSession', () => db.abAgentSession.deleteMany({ where: { tenantId } })],
  ];
  for (const [table, run] of wipe) {
    try {
      await run();
    } catch (err) {
      throw new Error(
        `seed wipe failed at ${table}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Usually a child row in a table missing from this list — add it ABOVE ${table}.`,
      );
    }
  }

  // Default chart of accounts.
  //
  // Codes must be the CANONICAL ones (1000 = Cash, 1100 = A/R). This used to
  // seed 1010 and 1200, which no other part of the system looks for: the tax
  // estimate resolves Cash by `code: '1000'` and found nothing, so it reported
  // grossRevenueCents = 0 for a tenant with four invoices. Every report keyed
  // off the standard chart was quietly empty for the e2e tenant.
  const accounts = await Promise.all([
    db.abAccount.create({ data: { tenantId, code: '1000', name: 'Cash',                accountType: 'asset',   isActive: true } }),
    db.abAccount.create({ data: { tenantId, code: '1100', name: 'Accounts Receivable', accountType: 'asset',   isActive: true } }),
    db.abAccount.create({ data: { tenantId, code: '4000', name: 'Revenue',             accountType: 'revenue', isActive: true } }),
    db.abAccount.create({ data: { tenantId, code: '5000', name: 'General Expense',     accountType: 'expense', isActive: true } }),
    db.abAccount.create({ data: { tenantId, code: '5100', name: 'Travel',              accountType: 'expense', isActive: true } }),
    db.abAccount.create({ data: { tenantId, code: '3000', name: 'Equity',              accountType: 'equity',  isActive: true } }),
  ]);
  const cashAccount    = accounts.find(a => a.code === '1000')!;
  const arAccount      = accounts.find(a => a.code === '1100')!;
  const revenueAccount = accounts.find(a => a.code === '4000')!;
  const equityAccount  = accounts.find(a => a.code === '3000')!;
  const expenseAccount = accounts.find(a => a.code === '5000')!;
  const travelAccount  = accounts.find(a => a.code === '5100')!;

  // Opening journal entry: $5,000 cash → equity
  await db.abJournalEntry.create({
    data: {
      tenantId,
      date: daysAgo(45),
      memo: 'Opening balance',
      sourceType: 'manual',
      lines: { create: [
        { tenantId, accountId: cashAccount.id,   debitCents: 500000, creditCents: 0 }, // G-009
        { tenantId, accountId: equityAccount.id, debitCents: 0,      creditCents: 500000 }, // G-009
      ] },
    },
  });

  // Three clients
  const acme  = await db.abClient.create({ data: { tenantId, name: 'Acme Corp', email: 'billing@acme.test', defaultTerms: 'net-30' } });
  const beta  = await db.abClient.create({ data: { tenantId, name: 'Beta Inc',  email: 'finance@beta.test', defaultTerms: 'net-30' } });
  const gamma = await db.abClient.create({ data: { tenantId, name: 'Gamma LLC', email: 'ap@gamma.test',     defaultTerms: 'net-15' } });
  // BigCo exists so "got $7500 payment from BigCo" has something to pay.
  // The canonical eval sends that utterance BEFORE the thread that invoices
  // BigCo, so without a seeded receivable the agent correctly answered "I need a
  // client or invoice reference" and the case failed on the fixture's own
  // incoherence rather than on the product.
  const bigco = await db.abClient.create({ data: { tenantId, name: 'BigCo',      email: 'ap@bigco.test',     defaultTerms: 'net-30' } });

  // Five expenses (one missing receipt)
  const expensesData = [
    { date: daysAgo(2),  amountCents: 2800,  description: 'Uber to client meeting',    categoryId: travelAccount.id, receiptUrl: 'https://e2e.test/r/1.jpg' },
    { date: daysAgo(7),  amountCents: 4500,  description: 'AWS October bill',          categoryId: expenseAccount.id, receiptUrl: 'https://e2e.test/r/2.pdf' },
    { date: daysAgo(12), amountCents: 12000, description: 'Co-working space monthly',  categoryId: expenseAccount.id, receiptUrl: 'https://e2e.test/r/3.pdf' },
    { date: daysAgo(20), amountCents: 6800,  description: 'Conference ticket',         categoryId: travelAccount.id, receiptUrl: null as string | null },
    { date: daysAgo(25), amountCents: 1500,  description: 'Client lunch',              categoryId: expenseAccount.id, receiptUrl: 'https://e2e.test/r/5.jpg' },
  ];
  for (const e of expensesData) {
    const expense = await db.abExpense.create({
      data: {
        tenantId,
        date: e.date,
        amountCents: e.amountCents,
        description: e.description,
        categoryId: e.categoryId,
        isPersonal: false,
        receiptUrl: e.receiptUrl,
        source: 'manual',
      },
    });
    // Mirror what POST /expenses does. Writing AbExpense rows straight to the
    // database skips the route that posts the ledger entry, which left the e2e
    // tenant with expenses that appear in lists but never in the P&L, trial
    // balance or tax estimate — books that disagree with themselves, and a
    // tenant unable to exercise the reporting surface the tests are aimed at.
    await db.abJournalEntry.create({
      data: {
        tenantId,
        date: e.date,
        memo: e.description,
        sourceType: 'expense',
        sourceId: expense.id,
        lines: { create: [
          { tenantId, accountId: e.categoryId, debitCents: e.amountCents, creditCents: 0 }, // G-009
          { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: e.amountCents }, // G-009
        ] },
      },
    });
  }

  // Four invoices: draft / sent (due 7d) / sent overdue (due 30d ago) / paid
  await db.abInvoice.create({
    data: { tenantId, clientId: acme.id, number: 'INV-E2E-DRAFT', status: 'draft', amountCents: 80000, currency: 'USD', issuedDate: new Date(), dueDate: daysFromNow(30) },
  });
  await db.abInvoice.create({
    data: { tenantId, clientId: beta.id, number: 'INV-E2E-SENT', status: 'sent', amountCents: 120000, currency: 'USD', issuedDate: daysAgo(23), dueDate: daysFromNow(7) },
  });
  await db.abInvoice.create({
    data: { tenantId, clientId: gamma.id, number: 'INV-E2E-OVERDUE', status: 'sent', amountCents: 95000, currency: 'USD', issuedDate: daysAgo(60), dueDate: daysAgo(30) },
  });
  await db.abInvoice.create({
    data: { tenantId, clientId: bigco.id, number: 'INV-E2E-BIGCO', status: 'sent', amountCents: 750000, currency: 'USD', issuedDate: daysAgo(15), dueDate: daysFromNow(15) },
  });
  const paid = await db.abInvoice.create({
    data: { tenantId, clientId: acme.id, number: 'INV-E2E-PAID', status: 'paid', amountCents: 60000, currency: 'USD', issuedDate: daysAgo(40), dueDate: daysAgo(10) },
  });
  await db.abPayment.create({
    data: { tenantId, invoiceId: paid.id, amountCents: 60000, date: daysAgo(5), method: 'bank_transfer' },
  });

  // Book the invoices, as the invoice routes would. Without this the tenant has
  // four invoices and an empty revenue account, so the tax estimate reported
  // grossRevenueCents = 0 and every revenue-derived report was blank — the
  // books disagreed with the records they were supposedly derived from.
  //
  // Draft is deliberately NOT booked: an unissued invoice is not revenue, and
  // booking it would make the seed teach the wrong accounting.
  for (const inv of [
    { id: 'INV-E2E-SENT', amountCents: 120000, date: daysAgo(23) },
    { id: 'INV-E2E-OVERDUE', amountCents: 95000, date: daysAgo(60) },
    { id: 'INV-E2E-BIGCO', amountCents: 750000, date: daysAgo(15) },
    { id: 'INV-E2E-PAID', amountCents: 60000, date: daysAgo(40) },
  ]) {
    const row = await db.abInvoice.findFirst({ where: { tenantId, number: inv.id } });
    if (!row) continue;
    await db.abJournalEntry.create({
      data: {
        tenantId,
        date: inv.date,
        memo: `Invoice ${inv.id}`,
        sourceType: 'invoice',
        sourceId: row.id,
        lines: { create: [
          { tenantId, accountId: arAccount.id, debitCents: inv.amountCents, creditCents: 0 }, // G-009
          { tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: inv.amountCents }, // G-009
        ] },
      },
    });
  }

  // Settling the paid invoice moves A/R to Cash.
  await db.abJournalEntry.create({
    data: {
      tenantId,
      date: daysAgo(5),
      memo: 'Payment for INV-E2E-PAID',
      sourceType: 'payment',
      sourceId: paid.id,
      lines: { create: [
        { tenantId, accountId: cashAccount.id, debitCents: 60000, creditCents: 0 }, // G-009
        { tenantId, accountId: arAccount.id, debitCents: 0, creditCents: 60000 }, // G-009
      ] },
    },
  });

  const regional = await seedRegionalTenants(
    opts?.password || process.env.E2E_USER_PASSWORD || 'e2e-nightly-2026',
  );

  return {
    userId: E2E_USER_ID,
    expensesCreated: expensesData.length,
    invoicesCreated: 5,
    clientsCreated: 4,
    regionalTenants: regional,
  };
}

/**
 * Canadian and Australian tenants, seeded alongside the US one.
 *
 * The launch assessment's stated reason for holding AU was "no e2e coverage of
 * the AU path", and the same was true of CA. That was not a hypothetical gap:
 * on 31 July, probing a real CA account found it being quoted the IRS meal rule
 * and shown US dollar signs, and an earlier audit found CA provincial tax
 * double-counted and AU chat answering with US self-employment maths. Every one
 * of those is invisible to a suite that only ever signs in as a US tenant.
 *
 * Deliberately thin — a config, a couple of expenses, one invoice. Enough for
 * the tax, GST/BAS and currency surfaces to have something to compute, and no
 * more. The point is to exercise the REGIONAL branches, not to re-test
 * bookkeeping that phases 3–5 already cover on the US tenant.
 *
 * They share the caller-supplied password, so one GitHub secret still governs
 * every account the suite uses — the same single-source rule as #403. Adding a
 * per-region password would recreate exactly the drift that kept this suite
 * dead for three months.
 */
export interface RegionalTenant {
  userId: string;
  email: string;
  jurisdiction: string;
  region: string;
  currency: string;
}

export const REGIONAL_TENANTS: RegionalTenant[] = [
  // Fixed ids so a rerun updates the same rows rather than accumulating
  // tenants. Ordinary v4-shaped UUIDs; the email is what identifies them.
  {
    userId: '0e2e00ca-0000-4000-8000-000000000ca1',
    email: 'e2e-ca@agentbook.test',
    jurisdiction: 'ca',
    region: 'ON',
    currency: 'CAD',
  },
  {
    userId: '0e2e00a0-0000-4000-8000-000000000a01',
    email: 'e2e-au@agentbook.test',
    jurisdiction: 'au',
    region: 'NSW',
    currency: 'AUD',
  },
];

async function seedRegionalTenants(password: string): Promise<RegionalTenant[]> {
  for (const t of REGIONAL_TENANTS) {
    await db.user.upsert({
      where: { id: t.userId },
      create: { id: t.userId, email: t.email, displayName: `E2E ${t.jurisdiction.toUpperCase()}` },
      update: { email: t.email, displayName: `E2E ${t.jurisdiction.toUpperCase()}` },
    });
    await ensurePassword(t.userId, password);

    await db.abTenantConfig.upsert({
      where: { userId: t.userId },
      create: {
        userId: t.userId,
        jurisdiction: t.jurisdiction,
        region: t.region,
        currency: t.currency,
        timezone: t.jurisdiction === 'ca' ? 'America/Toronto' : 'Australia/Sydney',
        businessType: 'sole_trader',
        dailyDigestEnabled: false,
      },
      // region and currency are the whole point of these tenants — if an
      // earlier run left them wrong, correct them rather than keeping stale
      // values, or the regional assertions would silently test the US path.
      update: {
        jurisdiction: t.jurisdiction,
        region: t.region,
        currency: t.currency,
      },
    });

    // Wipe and reseed the minimal financial data. Same named-throw discipline
    // as the US wipe above: a swallowed delete here would leave duplicate rows
    // and fail the NEXT run with a confusing unique-constraint error.
    const wipe: Array<[string, () => Promise<unknown>]> = [
      ['abJournalLine', () => db.abJournalLine.deleteMany({ where: { tenantId: t.userId } })],
      ['abJournalEntry', () => db.abJournalEntry.deleteMany({ where: { tenantId: t.userId } })],
      ['abExpense', () => db.abExpense.deleteMany({ where: { tenantId: t.userId } })],
      ['abTaxEstimate', () => db.abTaxEstimate.deleteMany({ where: { tenantId: t.userId } })],
    ];
    for (const [table, run] of wipe) {
      try {
        await run();
      } catch (err) {
        throw new Error(
          `regional seed wipe failed for ${t.jurisdiction} at ${table}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Usually a child row in a table missing from this list — add it ABOVE ${table}.`,
        );
      }
    }

    await db.abExpense.createMany({
      data: [
        {
          tenantId: t.userId, amountCents: 24000, currency: t.currency,
          description: `E2E ${t.jurisdiction} software subscription`,
          date: daysAgo(20), isPersonal: false, status: 'confirmed',
        },
        {
          tenantId: t.userId, amountCents: 8600, currency: t.currency,
          description: `E2E ${t.jurisdiction} client lunch`,
          date: daysAgo(9), isPersonal: false, status: 'confirmed',
        },
      ],
    });
  }
  return REGIONAL_TENANTS;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

async function ensurePassword(userId: string, password: string): Promise<void> {
  const crypto = await import('node:crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  const passwordHash = `${salt}:${hash}`;
  await db.user.update({ where: { id: userId }, data: { passwordHash } });
}

// CLI entry — fires when invoked via `tsx scripts/seed-e2e-user.ts`
const isCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  !!process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file://').href;

if (isCli) {
  resetE2eUser()
    .then((r) => {
      console.log('[seed-e2e-user] reset complete:', r);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed-e2e-user] failed:', err);
      process.exit(1);
    });
}
