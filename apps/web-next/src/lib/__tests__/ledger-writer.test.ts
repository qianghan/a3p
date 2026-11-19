import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));

import {
  appendBalancedEntry,
  assertPeriodOpen,
  LedgerKeyConflict,
  LedgerPeriodClosedError,
  LedgerUnbalancedError,
} from '../ledger-writer';

let fake: ReturnType<typeof createFakeLedgerDb>;
beforeEach(() => { fake = createFakeLedgerDb(); });

const D = new Date('2026-03-10T12:00:00.000Z');
const LINES = [
  { accountId: 'acct-meals', debitCents: 10000, creditCents: 0, description: 'x' },
  { accountId: 'acct-gst', debitCents: 1000, creditCents: 0, description: 'GST' },
  { accountId: 'acct-cash', debitCents: 0, creditCents: 11000, description: 'Payment' },
];
const HEADER = { date: D, memo: 'Bill', sourceType: 'bill', sourceId: 'b1' };

describe('appendBalancedEntry', () => {
  it('writes a balanced 3-line entry and returns its id', async () => {
    const id = await appendBalancedEntry(fake.db as any, 't1', HEADER, LINES);
    expect(fake.state.entries.map((e) => e.id)).toEqual([id]);
    expect(fake.netByAccount()).toEqual({ 'acct-meals': 10000, 'acct-gst': 1000, 'acct-cash': -11000 });
  });

  it('refuses an unbalanced entry and writes nothing', async () => {
    await expect(
      appendBalancedEntry(fake.db as any, 't1', HEADER, [LINES[0], LINES[2]]),
    ).rejects.toBeInstanceOf(LedgerUnbalancedError);
    expect(fake.state.entries).toHaveLength(0);
  });

  it('replays an identical payload on P2002: returns the existing entry, writes nothing new', async () => {
    const first = await appendBalancedEntry(fake.db as any, 't1', HEADER, LINES);
    const again = await appendBalancedEntry(fake.db as any, 't1', HEADER, [...LINES].reverse());
    expect(again).toBe(first);
    expect(fake.state.entries).toHaveLength(1);
    expect(fake.state.lines).toHaveLength(3);
  });

  it('throws LedgerKeyConflict (code P2002) when the key exists with a different payload', async () => {
    await appendBalancedEntry(fake.db as any, 't1', HEADER, LINES);
    const other = LINES.map((l) => ({ ...l, debitCents: l.debitCents * 2, creditCents: l.creditCents * 2 }));
    const err = await appendBalancedEntry(fake.db as any, 't1', HEADER, other).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerKeyConflict);
    expect(err.code).toBe('P2002'); // existing route handlers map code P2002 to 409
    expect(fake.netByAccount()).toEqual({ 'acct-meals': 10000, 'acct-gst': 1000, 'acct-cash': -11000 });
  });

  it('treats a different date under the same key as a conflict, not a replay', async () => {
    await appendBalancedEntry(fake.db as any, 't1', HEADER, LINES);
    await expect(
      appendBalancedEntry(fake.db as any, 't1', { ...HEADER, date: new Date('2026-04-01T00:00:00Z') }, LINES),
    ).rejects.toBeInstanceOf(LedgerKeyConflict);
  });
});

describe('assertPeriodOpen — UTC month', () => {
  it('a UTC-midnight date on the 1st belongs to THAT month, whatever the server timezone', async () => {
    fake.state.periods.push({ tenantId: 't1', year: 2026, month: 2, status: 'closed' });
    // 2026-03-01T00:00Z is still Feb 28 in any western timezone; local-time
    // derivation would have checked (and been blocked by) February.
    await expect(assertPeriodOpen(fake.db as any, 't1', new Date('2026-03-01T00:00:00.000Z'))).resolves.toBeUndefined();
    const err = await assertPeriodOpen(fake.db as any, 't1', new Date('2026-02-28T23:30:00.000Z')).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerPeriodClosedError);
    expect([err.year, err.month]).toEqual([2026, 2]);
  });

  it('an open or missing period passes', async () => {
    fake.state.periods.push({ tenantId: 't1', year: 2026, month: 3, status: 'open' });
    await expect(assertPeriodOpen(fake.db as any, 't1', D)).resolves.toBeUndefined();
  });
});
