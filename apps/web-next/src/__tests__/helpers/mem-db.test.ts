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
