/**
 * Stateful in-memory stand-in for the slice of Prisma the expense ledger uses.
 *
 * Not a vi.fn() script: it STORES rows, APPLIES the `where` clause, enforces the
 * G-021 `@@unique([tenantId, sourceType, sourceId])` constraint (P2002), and
 * rolls a `$transaction` back when its callback throws. A fixed-array mock can't
 * fail on a bug whose cause is the filter, and a mock that ignores the unique
 * constraint can't catch a reversal that would be rejected in production.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    // Operators / relation filters are not modelled: fail loudly rather than
    // silently evaluate `row[k] === { in: [...] }` as false.
    if (v !== null && typeof v === 'object') throw new Error(`fake-ledger-db: unsupported filter on ${k}`);
    return row[k] === v;
  });
}

export function createFakeLedgerDb() {
  const state = {
    expenses: [] as Row[],
    entries: [] as Row[],
    lines: [] as Row[],
    periods: [] as Row[],
    vendors: [] as Row[],
    // Chart of accounts the helpers validate against (tenant, type, active).
    accounts: [
      { id: 'acct-cash', tenantId: 't1', code: '1000', accountType: 'asset', isActive: true },
      { id: 'acct-meals', tenantId: 't1', code: '5200', accountType: 'expense', isActive: true },
      { id: 'acct-travel', tenantId: 't1', code: '5300', accountType: 'expense', isActive: true },
      { id: 'acct-tax', tenantId: 't1', code: '2200', accountType: 'liability', isActive: true },
      { id: 'acct-old', tenantId: 't1', code: '5400', accountType: 'expense', isActive: false },
      { id: 'acct-revenue', tenantId: 't1', code: '4000', accountType: 'revenue', isActive: true },
      { id: 'acct-suspense', tenantId: 't1', code: '6999', accountType: 'expense', isActive: true },
      { id: 'acct-t2-meals', tenantId: 't2', code: '5200', accountType: 'expense', isActive: true },
    ] as Row[],
    seq: 0,
  };
  const nextId = (p: string) => `${p}-${++state.seq}`;

  const entryWithLines = (e: Row | undefined, include?: Row) =>
    e ? (include?.lines ? { ...e, lines: state.lines.filter((l) => l.entryId === e.id) } : { ...e }) : null;

  const api: Row = {
    abExpense: {
      findFirst: async ({ where }: Row = {}) => {
        const r = state.expenses.find((e) => matches(e, where));
        return r ? { ...r } : null;
      },
      update: async ({ where, data }: Row) => {
        const r = state.expenses.find((e) => matches(e, where));
        if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = state.expenses.filter((e) => matches(e, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
    abJournalEntry: {
      findFirst: async ({ where, include }: Row = {}) =>
        entryWithLines(state.entries.find((e) => matches(e, where)), include),
      findUnique: async ({ where, include }: Row = {}) =>
        entryWithLines(state.entries.find((e) => matches(e, where)), include),
      findMany: async ({ where }: Row = {}) => state.entries.filter((e) => matches(e, where)).map((e) => ({ ...e })),
      create: async ({ data }: Row) => {
        const { lines, ...rest } = data;
        if (
          rest.sourceId != null &&
          state.entries.some(
            (e) => e.tenantId === rest.tenantId && e.sourceType === rest.sourceType && e.sourceId === rest.sourceId,
          )
        ) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const entry = { id: nextId('je'), createdAt: new Date(), ...rest };
        state.entries.push(entry);
        for (const l of lines?.create ?? []) {
          state.lines.push({ id: nextId('jl'), entryId: entry.id, ...l });
        }
        return { ...entry };
      },
    },
    abJournalLine: {
      findMany: async ({ where }: Row = {}) => state.lines.filter((l) => matches(l, where)).map((l) => ({ ...l })),
      create: async ({ data }: Row) => {
        if (!state.entries.some((e) => e.id === data.entryId)) throw new Error('FK: entry not found');
        const line = { id: nextId('jl'), ...data };
        state.lines.push(line);
        return { ...line };
      },
      update: async ({ where, data }: Row) => {
        const l = state.lines.find((x) => matches(x, where));
        if (!l) throw new Error('line not found');
        Object.assign(l, data);
        return { ...l };
      },
    },
    abFiscalPeriod: {
      findUnique: async ({ where }: Row) => {
        const k = where.tenantId_year_month;
        return state.periods.find((p) => p.tenantId === k.tenantId && p.year === k.year && p.month === k.month) ?? null;
      },
    },
    abAccount: {
      findFirst: async ({ where }: Row = {}) => {
        const r = state.accounts.find((a) => matches(a, where));
        return r ? { ...r } : null;
      },
    },
    abVendor: {
      findFirst: async ({ where }: Row = {}) => {
        const r = state.vendors.find((v) => matches(v, where));
        return r ? { ...r } : null;
      },
      upsert: async ({ where, create, update }: Row) => {
        const k = where.tenantId_normalizedName;
        const r = state.vendors.find((v) => v.tenantId === k.tenantId && v.normalizedName === k.normalizedName);
        if (r) {
          Object.assign(r, update);
          return { ...r };
        }
        const row = { id: nextId('v'), ...create };
        state.vendors.push(row);
        return { ...row };
      },
    },
    $transaction: async (fn: (tx: Row) => Promise<unknown>) => {
      const copy = (rows: Row[]) => rows.map((r) => ({ ...r }));
      const saved = {
        expenses: copy(state.expenses),
        entries: copy(state.entries),
        lines: copy(state.lines),
        vendors: copy(state.vendors),
        seq: state.seq,
      };
      try {
        return await fn(api);
      } catch (err) {
        state.expenses = saved.expenses;
        state.entries = saved.entries;
        state.lines = saved.lines;
        state.vendors = saved.vendors;
        state.seq = saved.seq;
        throw err;
      }
    },
  };

  /** Seed an expense booked DR `debitAccount` / CR cash, the way create posts it. */
  function seedBookedExpense(opts: {
    id?: string; tenantId?: string; amountCents: number; date: Date;
    debitAccountId?: string; description?: string; status?: string;
    categoryId?: string | null; isPersonal?: boolean;
  }) {
    const id = opts.id ?? 'exp-1';
    const tenantId = opts.tenantId ?? 't1';
    const entry = {
      id: nextId('je'), tenantId, date: opts.date, memo: `Expense: ${opts.description ?? 'Coffee'}`,
      sourceType: 'expense', sourceId: id, verified: true, createdAt: new Date(),
    };
    state.entries.push(entry);
    state.lines.push(
      { id: nextId('jl'), tenantId, entryId: entry.id, accountId: opts.debitAccountId ?? 'acct-meals', debitCents: opts.amountCents, creditCents: 0, description: 'Coffee' },
      { id: nextId('jl'), tenantId, entryId: entry.id, accountId: 'acct-cash', debitCents: 0, creditCents: opts.amountCents, description: 'Payment' },
    );
    state.expenses.push({
      id, tenantId, amountCents: opts.amountCents, date: opts.date,
      description: opts.description ?? 'Coffee', status: opts.status ?? 'confirmed',
      categoryId: opts.categoryId === undefined ? (opts.debitAccountId ?? 'acct-meals') : opts.categoryId,
      isPersonal: opts.isPersonal ?? false, journalEntryId: entry.id, deletedAt: null,
      vendorId: null,
    });
    return { entryId: entry.id };
  }

  /**
   * What POST /agentbook-core/restore/expense/:id does today: clear deletedAt
   * and nothing else — it does NOT re-book, so journalEntryId still points at
   * the entry DELETE reversed.
   */
  function restoreExpense(id = 'exp-1') {
    const r = state.expenses.find((e) => e.id === id);
    if (r) r.deletedAt = null;
  }

  /** Net debit per account across EVERY entry — what P&L / trial balance sum. */
  function netByAccount(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of state.lines) out[l.accountId] = (out[l.accountId] ?? 0) + l.debitCents - l.creditCents;
    for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
    return out;
  }

  /** Net debit per account for entries dated within [from, to). */
  function netByAccountInRange(from: Date, to: Date): Record<string, number> {
    const ids = new Set(state.entries.filter((e) => e.date >= from && e.date < to).map((e) => e.id));
    const out: Record<string, number> = {};
    for (const l of state.lines) {
      if (!ids.has(l.entryId)) continue;
      out[l.accountId] = (out[l.accountId] ?? 0) + l.debitCents - l.creditCents;
    }
    for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
    return out;
  }

  return { db: api, state, seedBookedExpense, restoreExpense, netByAccount, netByAccountInRange };
}
