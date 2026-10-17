/**
 * Stateful in-memory stand-in for the slice of Prisma the expense ledger uses.
 *
 * Not a vi.fn() script: it STORES rows, APPLIES the `where` clause, enforces the
 * G-021 `@@unique([tenantId, sourceType, sourceId])` constraint (P2002), and
 * rolls a `$transaction` back when its callback throws. A fixed-array mock can't
 * fail on a bug whose cause is the filter, and a mock that ignores the unique
 * constraint can't catch a reversal that would be rejected in production.
 *
 * It also models ONE Postgres behaviour that matters here: once a statement
 * inside a transaction fails (a P2002 unique violation included), the
 * transaction is ABORTED — every later statement errors (25P02) and the commit
 * becomes a rollback, even if the caller caught the first error. Code that
 * "swallows" a P2002 mid-transaction therefore fails here as it does in prod.
 * That is all this models: it is NOT a claim about isolation or atomicity
 * under concurrency, which an in-memory single-threaded store cannot show.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    // Only `in` and `startsWith` are modelled. Anything else fails loudly rather
    // than silently evaluating `row[k] === { gte: … }` as false.
    if (v !== null && typeof v === 'object') {
      const ops = Object.keys(v);
      if (ops.length === 1 && ops[0] === 'in') return (v as Row).in.includes(row[k]);
      if (ops.length === 1 && ops[0] === 'startsWith') return typeof row[k] === 'string' && row[k].startsWith((v as Row).startsWith);
      throw new Error(`fake-ledger-db: unsupported filter on ${k}`);
    }
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
    events: [] as Row[],
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
  const txState = { active: false, poisoned: false };
  const nextId = (p: string) => `${p}-${++state.seq}`;

  const entryWithLines = (e: Row | undefined, include?: Row) =>
    e ? (include?.lines ? { ...e, lines: state.lines.filter((l) => l.entryId === e.id) } : { ...e }) : null;

  const api: Row = {
    abExpense: {
      findFirst: async ({ where }: Row = {}) => {
        const r = state.expenses.find((e) => matches(e, where));
        return r ? { ...r } : null;
      },
      findMany: async ({ where }: Row = {}) => state.expenses.filter((e) => matches(e, where)).map((e) => ({ ...e })),
      findUnique: async ({ where, select }: Row = {}) => {
        const r = state.expenses.find((e) => matches(e, where));
        if (!r) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r };
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
      update: async ({ where, data }: Row) => {
        const e = state.entries.find((x) => matches(x, where));
        if (!e) throw Object.assign(new Error('not found'), { code: 'P2025' });
        const next = { ...e, ...data };
        if (
          next.sourceId != null &&
          state.entries.some(
            (o) => o !== e && o.tenantId === next.tenantId && o.sourceType === next.sourceType && o.sourceId === next.sourceId,
          )
        ) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        Object.assign(e, data);
        return { ...e };
      },
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
    abEvent: {
      create: async ({ data }: Row) => {
        const row = { id: nextId('ev'), ...data };
        state.events.push(row);
        return { ...row };
      },
    },
    abUserMemory: {
      deleteMany: async () => ({ count: 0 }),
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
      txState.active = true;
      txState.poisoned = false;
      try {
        const out = await fn(api);
        if (txState.poisoned) {
          throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
        }
        return out;
      } catch (err) {
        state.expenses = saved.expenses;
        state.entries = saved.entries;
        state.lines = saved.lines;
        state.vendors = saved.vendors;
        state.seq = saved.seq;
        throw err;
      } finally {
        txState.active = false;
        txState.poisoned = false;
      }
    },
  };

  // Postgres aborts a transaction after any failed statement. Wrap every
  // delegate method so a P2002 inside $transaction poisons it.
  for (const delegate of Object.values(api)) {
    if (typeof delegate !== 'object') continue;
    for (const [name, fn] of Object.entries(delegate as Row)) {
      (delegate as Row)[name] = async (...args: unknown[]) => {
        if (txState.active && txState.poisoned) {
          throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
        }
        try {
          return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
        } catch (err) {
          if (txState.active && (err as { code?: string })?.code === 'P2002') txState.poisoned = true;
          throw err;
        }
      };
    }
  }

  /** Seed an expense booked DR `debitAccount` / CR cash, the way create posts it. */
  function seedBookedExpense(opts: {
    id?: string; tenantId?: string; amountCents: number; date: Date;
    debitAccountId?: string; description?: string; status?: string;
    categoryId?: string | null; isPersonal?: boolean;
    /** The create route posts with NO source key (null); the Telegram confirm path keys it to the expense id (default). */
    sourceId?: string | null;
  }) {
    const id = opts.id ?? 'exp-1';
    const tenantId = opts.tenantId ?? 't1';
    const entry = {
      id: nextId('je'), tenantId, date: opts.date, memo: `Expense: ${opts.description ?? 'Coffee'}`,
      sourceType: 'expense', sourceId: opts.sourceId === undefined ? id : opts.sourceId, verified: true, createdAt: new Date(),
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
   * What POST /agentbook-core/restore/expense/:id did BEFORE it re-booked: clear
   * deletedAt and nothing else, so journalEntryId still points at the entry
   * DELETE reversed. Rows in this state exist in production from before the
   * fix; use this to seed them. (The route itself now re-books.)
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

  /**
   * Append a mirror (debit/credit swapped) of an existing entry under an
   * arbitrary key — how the PRE-FIX code wrote its reversals:
   *   legacy DELETE      → ('expense_delete', <expenseId>)
   *   legacy bot undo/fix → ('expense', <expenseId>), memo 'REVERSAL: …'
   */
  function appendMirror(entryId: string, header: { sourceType: string; sourceId: string | null; memo: string; date?: Date }) {
    const orig = state.entries.find((e) => e.id === entryId)!;
    const entry = {
      id: nextId('je'), tenantId: orig.tenantId, date: header.date ?? new Date(), memo: header.memo,
      sourceType: header.sourceType, sourceId: header.sourceId, verified: true, createdAt: new Date(),
    };
    state.entries.push(entry);
    for (const l of state.lines.filter((x) => x.entryId === entryId)) {
      state.lines.push({
        id: nextId('jl'), tenantId: l.tenantId, entryId: entry.id, accountId: l.accountId,
        debitCents: l.creditCents, creditCents: l.debitCents, description: `Reverse: ${l.description}`,
      });
    }
    return { entryId: entry.id };
  }

  return { db: api, state, seedBookedExpense, appendMirror, restoreExpense, netByAccount, netByAccountInRange };
}
