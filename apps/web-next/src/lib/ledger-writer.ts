/**
 * The one journal writer.
 *
 * Every posting goes through `appendBalancedEntry`: it refuses anything that
 * does not balance, and the G-021 key `@@unique([tenantId, sourceType, sourceId])`
 * makes it idempotent — a replay of the SAME payload returns the existing
 * entry, a different payload under the same key throws `LedgerKeyConflict`.
 * `assertPeriodOpen` is the closed-period gate (`AbFiscalPeriod`), with the
 * month derived in UTC so a UTC-midnight document on the 1st is not checked
 * against the previous month.
 *
 * Callers inside an interactive Postgres transaction: after a unique violation
 * the transaction is aborted, so the replay lookup cannot run there. In that
 * case the writer rethrows a `LedgerKeyConflict` (code 'P2002') and the
 * transaction rolls back, exactly as the raw P2002 did before.
 */
import 'server-only';
import type { prisma } from '@naap/database';

export type LedgerWriterClient = Pick<typeof prisma, 'abJournalEntry' | 'abJournalLine' | 'abFiscalPeriod'>;

export interface LedgerLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  description: string | null;
}

export interface LedgerEntryHeader {
  date: Date;
  memo: string;
  sourceType: string;
  sourceId: string | null;
}

/** The entry does not balance (or has fewer than two lines / zero value). */
export class LedgerUnbalancedError extends Error {
  constructor() {
    super('Journal entry does not balance');
    this.name = 'LedgerUnbalancedError';
  }
}

/** The posting date falls in a closed fiscal period. */
export class LedgerPeriodClosedError extends Error {
  constructor(public readonly year: number, public readonly month: number) {
    super(`Fiscal period ${year}-${String(month).padStart(2, '0')} is closed`);
    this.name = 'ExpenseLedgerPeriodClosedError'; // historical name, kept for log continuity
  }
}

/**
 * The (tenantId, sourceType, sourceId) key already holds a DIFFERENT entry.
 * Carries code 'P2002' so existing handlers that map a unique violation to a
 * 409 / "already done" keep working unchanged.
 */
export class LedgerKeyConflict extends Error {
  readonly code = 'P2002';
  constructor(
    public readonly sourceType: string,
    public readonly sourceId: string,
    public readonly existingEntryId: string | null,
  ) {
    super(`A different journal entry already exists for ${sourceType}:${sourceId}`);
    this.name = 'LedgerKeyConflict';
  }
}

export async function assertPeriodOpen(client: Pick<LedgerWriterClient, 'abFiscalPeriod'>, tenantId: string, date: Date): Promise<void> {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const period = await client.abFiscalPeriod.findUnique({
    where: { tenantId_year_month: { tenantId, year, month } },
  });
  if (period && period.status === 'closed') throw new LedgerPeriodClosedError(year, month);
}

const lineKey = (l: Pick<LedgerLine, 'accountId' | 'debitCents' | 'creditCents'>) =>
  `${l.accountId}|${l.debitCents}|${l.creditCents}`;

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

/**
 * Append one entry and its lines. Must be called with the transaction client
 * when the caller has one: header and lines commit (or roll back) together.
 */
export async function appendBalancedEntry(
  client: LedgerWriterClient,
  tenantId: string,
  header: LedgerEntryHeader,
  lines: LedgerLine[],
): Promise<string> {
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);
  if (lines.length < 2 || debits <= 0 || debits !== credits) throw new LedgerUnbalancedError();

  let entry: { id: string };
  try {
    entry = await client.abJournalEntry.create({ data: { tenantId, ...header, verified: true } });
  } catch (err) {
    if (!isUniqueViolation(err) || header.sourceId == null) throw err;
    let existing: { id: string; date: Date } | null = null;
    let existingKeys: string[] = [];
    try {
      existing = await client.abJournalEntry.findFirst({
        where: { tenantId, sourceType: header.sourceType, sourceId: header.sourceId },
      });
      if (existing) {
        existingKeys = ((await client.abJournalLine.findMany({ where: { entryId: existing.id } })) || []).map(lineKey).sort();
      }
    } catch {
      // Aborted transaction: the lookup cannot run. Fall through to a conflict.
      existing = null;
    }
    const wanted = lines.map(lineKey).sort();
    if (
      existing &&
      existing.date.getTime() === header.date.getTime() &&
      existingKeys.length === wanted.length &&
      existingKeys.every((k, i) => k === wanted[i])
    ) {
      return existing.id; // idempotent replay
    }
    throw new LedgerKeyConflict(header.sourceType, header.sourceId, existing?.id ?? null);
  }
  for (const l of lines) {
    await client.abJournalLine.create({ data: { tenantId, entryId: entry.id, ...l } }); // G-009
  }
  return entry.id;
}
