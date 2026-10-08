import type { MemDbSeed, Row } from './mem-db';

/** Frozen "now" for every fixture-based test: Sat 20 June 2026, 12:00 UTC. */
export const NOW = new Date('2026-06-20T12:00:00.000Z');
const D = (iso: string) => new Date(iso);
const day = (ymd: string) => D(`${ymd}T00:00:00.000Z`);

/** Mirrors the private constant in lib/agentbook-auto-categorize.ts. */
export const PENDING_KEY = 'telegram:ai_categorize_pending';

interface FixtureLine { accountId: string; debitCents: number; creditCents: number }
interface FixtureEntry { id: string; tenantId: string; date: string; lines: FixtureLine[] }

export const ACCOUNTS: Row[] = [
  { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'acc-rev', tenantId: 't1', code: '4000', name: 'Consulting revenue', accountType: 'revenue', isActive: true },
  { id: 'acc-meals', tenantId: 't1', code: '5200', name: 'Meals', accountType: 'expense', isActive: true },
  { id: 'acc-fuel', tenantId: 't1', code: '5300', name: 'Fuel', accountType: 'expense', isActive: true },
  { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
  { id: 'b-cash', tenantId: 't2', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'b-rev', tenantId: 't2', code: '4000', name: 'Revenue', accountType: 'revenue', isActive: true },
  { id: 'b-meals', tenantId: 't2', code: '5200', name: 'Meals', accountType: 'expense', isActive: true },
];

const expenseEntry = (id: string, tenantId: string, ymd: string, accountId: string, cents: number): FixtureEntry => ({
  id,
  tenantId,
  date: `${ymd}T00:00:00.000Z`,
  lines: [
    { accountId, debitCents: cents, creditCents: 0 },
    { accountId: 'acc-cash', debitCents: 0, creditCents: cents },
  ],
});

export const ENTRIES: FixtureEntry[] = [
  {
    id: 'je-rev', tenantId: 't1', date: '2026-03-01T00:00:00.000Z',
    lines: [{ accountId: 'acc-cash', debitCents: 500000, creditCents: 0 }, { accountId: 'acc-rev', debitCents: 0, creditCents: 500000 }],
  },
  expenseEntry('je-e1', 't1', '2026-06-05', 'acc-fuel', 4000),
  expenseEntry('je-e2', 't1', '2026-06-12', 'acc-meals', 12000),
  expenseEntry('je-e4', 't1', '2026-05-10', 'acc-fuel', 8000),
  expenseEntry('je-e6', 't1', '2026-06-15', 'acc-susp', 6000),
  expenseEntry('je-e7', 't1', '2026-06-02', 'acc-meals', 9900),
  {
    id: 'je-t2', tenantId: 't2', date: '2026-04-01T00:00:00.000Z',
    lines: [{ accountId: 'b-cash', debitCents: 999, creditCents: 0 }, { accountId: 'b-rev', debitCents: 0, creditCents: 999 }],
  },
];

/** Accounts embed journalLines (overview), lines embed entry (+ entry.lines) for estimate / P&L. */
export function ledgerSeed(): { abAccount: Row[]; abJournalEntry: Row[]; abJournalLine: Row[] } {
  const lineRows: Row[] = ENTRIES.flatMap((je) =>
    je.lines.map((l, i) => ({
      id: `${je.id}-l${i}`,
      tenantId: je.tenantId,
      entryId: je.id,
      accountId: l.accountId,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: null,
      entry: { id: je.id, tenantId: je.tenantId, date: D(je.date), lines: je.lines.map((x) => ({ ...x })) },
    })),
  );
  const accountRows = ACCOUNTS.map((a) => ({
    ...a,
    journalLines: lineRows
      .filter((l) => l.accountId === a.id)
      .map((l) => ({ debitCents: l.debitCents, creditCents: l.creditCents })),
  }));
  const entryRows = ENTRIES.map((je) => ({
    id: je.id, tenantId: je.tenantId, date: D(je.date), memo: `fixture ${je.id}`, sourceType: 'expense', sourceId: null, verified: true,
  }));
  return { abAccount: accountRows, abJournalEntry: entryRows, abJournalLine: lineRows };
}

const exp = (o: Row & { id: string; tenantId: string; ymd: string; amountCents: number }): Row => {
  const { ymd, ...rest } = o;
  return {
    vendorId: null, vendor: null, categoryId: null, description: null, notes: null,
    receiptUrl: null, receiptStatus: 'pending', status: 'confirmed', isPersonal: false,
    confidence: null, journalEntryId: null, deletedAt: null, archivedAt: null, idempotencyKey: null,
    taxAmountCents: 0, tipAmountCents: 0, currency: 'CAD', source: 'manual',
    date: day(ymd), createdAt: day(ymd),
    ...rest,
  };
};

const shell = { vendorId: 'v-shell', vendor: { id: 'v-shell', name: 'Shell' } };
const bistro = { vendorId: 'v-bistro', vendor: { id: 'v-bistro', name: 'Bistro' } };

export const EXPENSES: Row[] = [
  exp({ id: 'e1', tenantId: 't1', ymd: '2026-06-05', amountCents: 4000, ...shell, description: 'Gas', categoryId: 'acc-fuel', confidence: 1, journalEntryId: 'je-e1' }),
  exp({ id: 'e2', tenantId: 't1', ymd: '2026-06-12', amountCents: 12000, ...bistro, description: 'Client lunch', categoryId: 'acc-meals', confidence: 0.88, receiptUrl: 'https://blob.test/r2.jpg', receiptStatus: 'attached', journalEntryId: 'je-e2' }),
  exp({ id: 'e3', tenantId: 't1', ymd: '2026-06-03', amountCents: 999, isPersonal: true, description: 'Groceries' }),
  exp({ id: 'e4', tenantId: 't1', ymd: '2026-05-10', amountCents: 8000, ...shell, description: 'Gas', categoryId: 'acc-fuel', confidence: 1, receiptStatus: null, journalEntryId: 'je-e4' }),
  exp({ id: 'e5', tenantId: 't1', ymd: '2026-06-18', amountCents: 3500, vendorId: 'v-cafe', vendor: { id: 'v-cafe', name: 'Cafe' }, description: 'Coffee', status: 'pending_review', receiptUrl: 'https://blob.test/r5.jpg', receiptStatus: 'attached', source: 'telegram_photo' }),
  exp({ id: 'e6', tenantId: 't1', ymd: '2026-06-15', amountCents: 6000, description: 'Bank transfer', receiptStatus: 'skipped', journalEntryId: 'je-e6' }),
  exp({ id: 'e7', tenantId: 't1', ymd: '2026-06-02', amountCents: 9900, ...bistro, description: 'Team dinner', categoryId: 'acc-meals', confidence: 1, journalEntryId: 'je-e7', archivedAt: D('2026-06-19T09:00:00.000Z') }),
  exp({ id: 'x1', tenantId: 't2', ymd: '2026-06-06', amountCents: 777777, description: 'Other tenant', categoryId: 'b-meals', confidence: 1, currency: 'USD' }),
];

export const VENDORS: Row[] = [
  { id: 'v-shell', tenantId: 't1', name: 'Shell', normalizedName: 'shell', defaultCategoryId: 'acc-fuel', transactionCount: 2 },
  { id: 'v-bistro', tenantId: 't1', name: 'Bistro', normalizedName: 'bistro', defaultCategoryId: 'acc-meals', transactionCount: 2 },
  { id: 'v-cafe', tenantId: 't1', name: 'Cafe', normalizedName: 'cafe', defaultCategoryId: null, transactionCount: 1 },
];

export const INVOICES: Row[] = [
  { id: 'inv1', tenantId: 't1', clientId: 'c1', client: { id: 'c1', name: 'Acme' }, number: 'INV-1', amountCents: 180000, currency: 'CAD', status: 'sent', issuedDate: day('2026-05-01'), dueDate: day('2026-06-01'), payments: [{ id: 'pay1', amountCents: 30000 }], deletedAt: null, createdAt: day('2026-05-01') },
  { id: 'inv2', tenantId: 't1', clientId: 'c2', client: { id: 'c2', name: 'Beta' }, number: 'INV-2', amountCents: 50000, currency: 'CAD', status: 'sent', issuedDate: day('2026-06-05'), dueDate: day('2026-07-05'), payments: [], deletedAt: null, createdAt: D('2026-06-05T10:00:00.000Z') },
  { id: 'inv3', tenantId: 't1', clientId: 'c3', client: { id: 'c3', name: 'Gamma' }, number: 'INV-3', amountCents: 70000, currency: 'CAD', status: 'paid', issuedDate: day('2026-04-01'), dueDate: day('2026-05-01'), payments: [{ id: 'pay2', amountCents: 70000 }], deletedAt: null, createdAt: day('2026-04-01') },
  { id: 'inv-x', tenantId: 't2', clientId: 'cx', client: { id: 'cx', name: 'Other Co' }, number: 'INV-X', amountCents: 999000, currency: 'USD', status: 'overdue', issuedDate: day('2026-04-01'), dueDate: day('2026-05-01'), payments: [], deletedAt: null, createdAt: day('2026-04-01') },
];

export const PAYMENTS: Row[] = [
  { id: 'pay1', tenantId: 't1', invoiceId: 'inv1', invoice: { number: 'INV-1', client: { name: 'Acme' } }, amountCents: 30000, date: day('2026-06-10'), createdAt: day('2026-06-10') },
  { id: 'pay2', tenantId: 't1', invoiceId: 'inv3', invoice: { number: 'INV-3', client: { name: 'Gamma' } }, amountCents: 70000, date: day('2026-05-15'), createdAt: day('2026-05-15') },
  { id: 'pay-x', tenantId: 't2', invoiceId: 'inv-x', invoice: { number: 'INV-X', client: { name: 'Other Co' } }, amountCents: 999999, date: day('2026-06-10'), createdAt: day('2026-06-10') },
];

export const TENANT_CONFIGS: Row[] = [
  { id: 'cfg-1', userId: 't1', jurisdiction: 'ca', region: 'ON', currency: 'CAD', accountingBasis: 'accrual', taxEntityType: null, gstRegistered: null },
  { id: 'cfg-2', userId: 't2', jurisdiction: 'us', region: 'CA', currency: 'USD', accountingBasis: 'accrual', taxEntityType: null, gstRegistered: null },
];

export const BILLS: Row[] = [
  { id: 'b1', tenantId: 't1', vendorName: 'Rent Co', amountCents: 150000, status: 'open', dueDate: day('2026-06-24') },
  { id: 'b2', tenantId: 't1', vendorName: 'Old Vendor', amountCents: 5000, status: 'paid', dueDate: day('2026-06-21') },
  { id: 'bx', tenantId: 't2', vendorName: 'Other Rent', amountCents: 1, status: 'open', dueDate: day('2026-06-22') },
];

export const CALENDAR: Row[] = [
  { id: 'ce1', tenantId: 't1', eventType: 'renewal', titleKey: 'calendar.domain_renewal', date: day('2026-06-25'), status: 'upcoming' },
  { id: 'ce2', tenantId: 't1', eventType: 'renewal', titleKey: 'calendar.done', date: day('2026-06-26'), status: 'acted_on' },
  { id: 'cex', tenantId: 't2', eventType: 'renewal', titleKey: 'calendar.other', date: day('2026-06-23'), status: 'upcoming' },
];

export function pendingMemoryRow(tenantId: string, items: Row[]): Row {
  return { id: `mem-${tenantId}`, tenantId, key: PENDING_KEY, type: 'pending_action', confidence: 1, value: JSON.stringify({ items, builtAt: 0 }) };
}

export const E6_SUGGESTION: Row = {
  expenseId: 'e6', vendorName: null, amountCents: 6000, date: '2026-06-15T00:00:00.000Z', description: 'Bank transfer',
  suggestedCategoryId: 'acc-meals', suggestedCategoryName: 'Meals', confidence: 0.7, reason: 'fixture',
};

export function fullSeed(): MemDbSeed {
  return {
    ...ledgerSeed(),
    abExpense: EXPENSES,
    abVendor: VENDORS,
    abInvoice: INVOICES,
    abPayment: PAYMENTS,
    abTenantConfig: TENANT_CONFIGS,
    abBill: BILLS,
    abCalendarEvent: CALENDAR,
    abUserMemory: [pendingMemoryRow('t1', [E6_SUGGESTION])],
  };
}
