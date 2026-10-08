// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemDb, matchesWhere, type Row } from './mem-db';

const db = createMemDb();
const D = (s: string) => new Date(s);

beforeEach(() => {
  db.reset(
    {
      abExpense: [
        { id: 'a', tenantId: 't1', amountCents: 100, receiptStatus: null, date: D('2026-06-01'), vendor: { name: 'Shell' } },
        { id: 'b', tenantId: 't1', amountCents: 200, receiptStatus: 'skipped', date: D('2026-06-02'), vendor: null },
        { id: 'c', tenantId: 't2', amountCents: 300, receiptStatus: 'pending', date: D('2026-06-03'), vendor: { name: 'Bistro' } },
      ],
    },
    { unique: { abIdempotencyKey: [['key']] } },
  );
});

describe('mem-db applies where clauses like Postgres', () => {
  it('scopes by equality', async () => {
    expect((await (db.abExpense as never as { findMany: (a: unknown) => Promise<Row[]> }).findMany({ where: { tenantId: 't1' } })).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('uses SQL NULL semantics for `not` (NULL <> x is not true)', () => {
    const row = { receiptStatus: null };
    expect(matchesWhere(row, { receiptStatus: { not: 'skipped' } })).toBe(false);
    expect(matchesWhere(row, { OR: [{ receiptStatus: null }, { receiptStatus: { not: 'skipped' } }] })).toBe(true);
  });

  it('supports AND / OR / NOT, in, gt, gte, lt, dates and insensitive contains', () => {
    const r = { id: 'x', amountCents: 2600, date: D('2026-06-10'), description: 'Client LUNCH', status: 'confirmed' };
    expect(matchesWhere(r, { amountCents: { gt: 2500 }, date: { gte: D('2026-06-01'), lt: D('2026-07-01') } })).toBe(true);
    expect(matchesWhere(r, { status: { in: ['pending_review'] } })).toBe(false);
    expect(matchesWhere(r, { description: { contains: 'lunch', mode: 'insensitive' } })).toBe(true);
    expect(matchesWhere(r, { description: { contains: 'lunch' } })).toBe(false);
    expect(matchesWhere(r, { AND: [{ id: 'x' }, { NOT: { status: 'rejected' } }] })).toBe(true);
    expect(matchesWhere(r, { date: D('2026-06-10'), id: { lt: 'y' } })).toBe(true);
  });

  it('contains / startsWith / endsWith follow SQL LIKE: % and _ are wildcards unless backslash-escaped', () => {
    const r = { s: '100% off', t: 'a_b', u: 'axb' };
    expect(matchesWhere(r, { s: { contains: '%' } })).toBe(true);
    expect(matchesWhere(r, { u: { contains: '%' } })).toBe(true); // unescaped % matches anything, as in Postgres
    expect(matchesWhere(r, { u: { contains: 'a_b' } })).toBe(true);
    expect(matchesWhere(r, { u: { contains: 'a\\_b' } })).toBe(false);
    expect(matchesWhere(r, { t: { contains: 'a\\_b' } })).toBe(true);
    expect(matchesWhere(r, { u: { contains: '\\%' } })).toBe(false);
    expect(matchesWhere(r, { s: { contains: '100\\%' } })).toBe(true);
    expect(matchesWhere(r, { s: { startsWith: '100\\%' } })).toBe(true);
    expect(matchesWhere(r, { t: { endsWith: '\\_b' } })).toBe(true);
    expect(matchesWhere({ s: 'a\\b' }, { s: { contains: 'a\\\\b' } })).toBe(true);
    expect(matchesWhere({ s: 'A.B' }, { s: { contains: 'a.b', mode: 'insensitive' } })).toBe(true);
    expect(matchesWhere({ s: 'aXb' }, { s: { contains: 'a.b', mode: 'insensitive' } })).toBe(false); // regex dot is not a wildcard
  });

  it('follows embedded relations and `some`', () => {
    expect(matchesWhere({ vendor: { name: 'Shell' } }, { vendor: { name: { contains: 'she', mode: 'insensitive' } } })).toBe(true);
    expect(matchesWhere({ vendor: null }, { vendor: { name: { contains: 'x' } } })).toBe(false);
    const line = { entry: { tenantId: 't1', lines: [{ accountId: 'cash', creditCents: 5 }] } };
    expect(matchesWhere(line, { entry: { tenantId: 't1', lines: { some: { accountId: 'cash', creditCents: { gt: 0 } } } } })).toBe(true);
  });

  it('resolves compound unique selectors', () => {
    expect(matchesWhere({ tenantId: 't1', key: 'k' }, { tenantId_key: { tenantId: 't1', key: 'k' } })).toBe(true);
    expect(matchesWhere({ tenantId: 't2', key: 'k' }, { tenantId_key: { tenantId: 't1', key: 'k' } })).toBe(false);
  });

  it('orders, pages, counts and aggregates', async () => {
    const t = db.table('abExpense');
    const rows = await t.findMany({ orderBy: [{ date: 'desc' }, { id: 'desc' }], take: 2, skip: 1 });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(await t.count({ where: { tenantId: 't1' } })).toBe(2);
    expect(await t.aggregate({ where: { tenantId: 't1' }, _sum: { amountCents: true } })).toEqual({ _sum: { amountCents: 300 } });
    expect(await t.aggregate({ where: { tenantId: 'nobody' }, _sum: { amountCents: true } })).toEqual({ _sum: { amountCents: null } });
  });

  it('writes: increment, P2025 on a missing row, P2002 on a unique clash, logs every write', async () => {
    const t = db.table('abExpense');
    await t.update({ where: { id: 'a' }, data: { amountCents: { increment: 5 } } });
    expect((await t.findFirst({ where: { id: 'a' } }))?.amountCents).toBe(105);
    await expect(t.update({ where: { id: 'zzz' }, data: { amountCents: 1 } })).rejects.toMatchObject({ code: 'P2025' });
    await db.table('abIdempotencyKey').create({ data: { key: 'k1', tenantId: 't1' } });
    await expect(db.table('abIdempotencyKey').create({ data: { key: 'k1', tenantId: 't1' } })).rejects.toMatchObject({ code: 'P2002' });
    expect(t.writes.map((w) => w.op)).toEqual(['update', 'update']);
  });

  it('runs interactive transactions against the same tables', async () => {
    const id = await db.$transaction(async (tx: typeof db) => {
      const row = await (tx.abExpense as never as { create: (a: unknown) => Promise<Row> }).create({ data: { tenantId: 't1', amountCents: 1 } });
      return row.id;
    });
    expect(await db.table('abExpense').count({ where: { id } })).toBe(1);
  });

  it('returns clones, so callers cannot mutate stored rows', async () => {
    const [row] = await db.table('abExpense').findMany({ where: { id: 'a' } });
    row.amountCents = 999;
    expect((await db.table('abExpense').findFirst({ where: { id: 'a' } }))?.amountCents).toBe(100);
  });
});

describe('unsupported operators fail loudly (never a silent false / match-all)', () => {
  it('throws on an unknown operator on a scalar column', () => {
    expect(() => matchesWhere({ a: 1 }, { a: { bogus: 1 } })).toThrow(/unsupported operator/);
  });

  it('throws on a typo mixed with a real operator, including the case-insensitive mode typo', () => {
    expect(() => matchesWhere({ a: 'xx' }, { a: { contains: 'x', bogus: 1 } })).toThrow(/unsupported operator bogus/);
    expect(() => matchesWhere({ a: 'xx' }, { a: { contains: 'x', mode: 'insensitive', moed: 1 } })).toThrow(/unsupported operator moed/);
  });

  it('throws on named-but-unimplemented operators instead of treating them as relation filters', () => {
    expect(() => matchesWhere({ tags: ['x'] }, { tags: { has: 'x' } })).toThrow(/unsupported operator has/);
    expect(() => matchesWhere({}, { tags: { hasSome: ['x'] } })).toThrow(/unsupported operator hasSome/);
    expect(() => matchesWhere({ n: 1 }, { n: { multiply: 2 } })).toThrow(/unsupported operator multiply/);
    expect(() => matchesWhere({ body: 'x' }, { body: { search: 'x' } })).toThrow(/unsupported operator search/);
  });

  it('does not let NOT invert an unsupported operator into match-all', () => {
    expect(() => matchesWhere({ tags: ['x'] }, { NOT: { tags: { has: 'x' } } })).toThrow(/unsupported operator has/);
    expect(() => matchesWhere({}, { NOT: { tags: { has: 'x' } } })).toThrow(/unsupported operator has/);
    expect(() => matchesWhere({ a: 1 }, { a: { not: { bogus: 1 } } })).toThrow(/unsupported operator/);
  });

  it('still supports relation filters and nested embedded relations', () => {
    const acct = { id: 'a1', type: 'asset', journalLines: [{ debitCents: 5 }, { debitCents: 0 }] };
    expect(matchesWhere(acct, { journalLines: { some: { debitCents: { gt: 0 } } } })).toBe(true);
    expect(matchesWhere(acct, { journalLines: { every: { debitCents: { gt: 0 } } } })).toBe(false);
    expect(matchesWhere(acct, { journalLines: { none: { debitCents: { gt: 9 } } } })).toBe(true);
    const exp = { vendor: { name: 'Shell' }, entry: null };
    expect(matchesWhere(exp, { vendor: { is: { name: 'Shell' } } })).toBe(true);
    expect(matchesWhere(exp, { vendor: { isNot: { name: 'Shell' } } })).toBe(false);
    expect(matchesWhere(exp, { entry: { is: null } })).toBe(true);
    const line = { entry: { tenantId: 't1', account: { type: 'cash' } } };
    expect(matchesWhere(line, { entry: { account: { type: 'cash' } } })).toBe(true);
    expect(matchesWhere(line, { entry: { account: { type: 'bank' } } })).toBe(false);
  });

  it('treats a lone `mode` key as a field name in a relation filter, not an operator', () => {
    expect(matchesWhere({ entry: { mode: 'x' } }, { entry: { mode: 'x' } })).toBe(true);
    expect(matchesWhere({ entry: { mode: 'y' } }, { entry: { mode: 'x' } })).toBe(false);
  });
});

describe('three-valued NOT / AND / OR (SQL NULL semantics)', () => {
  const nullRow = { id: 'a', receiptStatus: null };
  const skipped = { id: 'b', receiptStatus: 'skipped' };
  const pending = { id: 'c', receiptStatus: 'pending' };

  it('NOT of an equality on a NULL column is UNKNOWN, so the row is excluded (Prisma NOT (col = x))', () => {
    const where = { NOT: { receiptStatus: 'skipped' } };
    expect(matchesWhere(nullRow, where)).toBe(false);
    expect(matchesWhere(skipped, where)).toBe(false);
    expect(matchesWhere(pending, where)).toBe(true);
  });

  it('agrees with the `{ not: x }` field form on every row', () => {
    for (const r of [nullRow, skipped, pending]) {
      expect(matchesWhere(r, { NOT: { receiptStatus: 'skipped' } })).toBe(matchesWhere(r, { receiptStatus: { not: 'skipped' } }));
    }
  });

  it('NOT of an explicit null equality is NOT (col IS NULL): two-valued', () => {
    const where = { NOT: { receiptStatus: null } };
    expect(matchesWhere(nullRow, where)).toBe(false);
    expect(matchesWhere(skipped, where)).toBe(true);
    expect(matchesWhere(pending, where)).toBe(true);
  });

  it('the null-inclusive idiom OR [null, NOT x] still includes NULL rows', () => {
    const where = { OR: [{ receiptStatus: null }, { NOT: { receiptStatus: 'skipped' } }] };
    expect(matchesWhere(nullRow, where)).toBe(true);
    expect(matchesWhere(skipped, where)).toBe(false);
    expect(matchesWhere(pending, where)).toBe(true);
  });

  it('AND/OR follow SQL three-valued rules', () => {
    // UNKNOWN AND FALSE = FALSE, so NOT(...) = TRUE.
    expect(matchesWhere(nullRow, { NOT: { AND: [{ receiptStatus: 'skipped' }, { id: 'zzz' }] } })).toBe(true);
    // UNKNOWN AND TRUE = UNKNOWN, so NOT(...) is not true.
    expect(matchesWhere(nullRow, { NOT: { AND: [{ receiptStatus: 'skipped' }, { id: 'a' }] } })).toBe(false);
    // UNKNOWN OR TRUE = TRUE; UNKNOWN OR FALSE = UNKNOWN.
    expect(matchesWhere(nullRow, { OR: [{ receiptStatus: 'skipped' }, { id: 'a' }] })).toBe(true);
    expect(matchesWhere(nullRow, { NOT: { OR: [{ receiptStatus: 'skipped' }, { id: 'zzz' }] } })).toBe(false);
  });

  it('comparison operators on NULL are UNKNOWN too (NOT gt excludes NULL rows)', () => {
    expect(matchesWhere({ n: null }, { NOT: { n: { gt: 5 } } })).toBe(false);
    expect(matchesWhere({ n: 3 }, { NOT: { n: { gt: 5 } } })).toBe(true);
    expect(matchesWhere({ n: null }, { NOT: { n: { in: ['a'] } } })).toBe(false);
  });

  it('array NOT means none of the conditions is true', () => {
    expect(matchesWhere(pending, { NOT: [{ receiptStatus: 'skipped' }, { id: 'x' }] })).toBe(true);
    expect(matchesWhere(pending, { NOT: [{ receiptStatus: 'skipped' }, { id: 'c' }] })).toBe(false);
  });

  it('applies through findMany', async () => {
    db.reset({ abExpense: [{ id: 'a', tenantId: 't1', receiptStatus: null }, { id: 'b', tenantId: 't1', receiptStatus: 'pending' }, { id: 'c', tenantId: 't1', receiptStatus: 'skipped' }] });
    const rows = await db.table('abExpense').findMany({ where: { tenantId: 't1', NOT: { receiptStatus: 'skipped' } } });
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });
});

describe('unsupported writes throw instead of being stored', () => {
  it('rejects non-set/increment/decrement operators and leaves the row untouched', async () => {
    const t = db.table('abExpense');
    await expect(t.update({ where: { id: 'a' }, data: { amountCents: { multiply: 2 } } })).rejects.toThrow(/unsupported write operator/);
    await expect(t.update({ where: { id: 'a' }, data: { tags: { push: 'x' } } })).rejects.toThrow(/unsupported write operator/);
    await expect(t.update({ where: { id: 'a' }, data: { amountCents: { increment: 1, bogus: 2 } } })).rejects.toThrow(/unsupported write operator/);
    // The valid field listed before the bad one must not have been applied.
    await expect(t.update({ where: { id: 'a' }, data: { vendorId: 'v', amountCents: { multiply: 2 } } })).rejects.toThrow();
    expect(await t.findFirst({ where: { id: 'a' } })).toMatchObject({ amountCents: 100 });
    expect((await t.findFirst({ where: { id: 'a' } }))?.vendorId).toBeUndefined();
  });

  it('rejects nested relation writes of every kind', async () => {
    const t = db.table('abExpense');
    for (const op of ['create', 'createMany', 'connect', 'connectOrCreate', 'disconnect', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      await expect(t.create({ data: { tenantId: 't1', lines: { [op]: [] } } })).rejects.toThrow(/nested writes unsupported/);
    }
    await expect(t.update({ where: { id: 'a' }, data: { vendor: { connect: { id: 'v' } } } })).rejects.toThrow(/nested writes unsupported/);
    await expect(t.upsert({ where: { id: 'zz' }, create: { tenantId: 't1', lines: { create: [] } }, update: {} })).rejects.toThrow(/nested writes unsupported/);
    expect(await t.count({ where: { tenantId: 't1' } })).toBe(2);
  });

  it('still supports set / increment / decrement and plain JSON object values', async () => {
    const t = db.table('abExpense');
    await t.update({ where: { id: 'a' }, data: { amountCents: { set: 7 } } });
    await t.update({ where: { id: 'a' }, data: { amountCents: { increment: 3 } } });
    await t.update({ where: { id: 'a' }, data: { amountCents: { decrement: 1 }, metadata: { source: 'mobile', n: { deep: 1 } } } });
    expect(await t.findFirst({ where: { id: 'a' } })).toMatchObject({ amountCents: 9, metadata: { source: 'mobile', n: { deep: 1 } } });
  });
});
