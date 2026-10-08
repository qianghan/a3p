/**
 * Query parsing for GET /api/v1/agentbook-expense/expenses.
 *
 * Legacy params (startDate, endDate, isPersonal, vendorId, limit, offset) keep
 * their meaning. Mobile PR 1 adds status, hasReceipt, categoryId ('none' =
 * uncategorized), archived ('false' default | 'true' | 'all'), q, cursor and
 * withCounts. The DocCounts below are derived from DOC_FILTER_PARAMS through
 * this same parser, so a chip's count can never disagree with its list.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import type { Prisma } from '@naap/database';
import { DOC_FILTER_PARAMS } from '@/lib/mobile/doc-filters';
import type { DocCounts, DocFilter } from '@/lib/mobile/types';

export const DEFAULT_LIST_LIMIT = 50;
/** Cap whenever the caller uses any mobile param (C3: "limit capped 100"). */
export const MOBILE_MAX_LIMIT = 100;
/**
 * Hard ceiling for legacy callers. The desktop ExpenseList asks for 200 rows
 * and has no pagination, so 100 would silently halve it; before this there
 * was no ceiling at all.
 */
export const LEGACY_MAX_LIMIT = 500;
export const NEW_LIST_PARAMS = ['status', 'hasReceipt', 'categoryId', 'archived', 'q', 'cursor', 'withCounts'] as const;
const STATUSES = ['confirmed', 'pending_review', 'rejected'];
const Q_MAX = 100;

export interface ExpenseCursor {
  date: Date;
  id: string;
}

export function encodeCursor(row: { date: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ d: row.date.toISOString(), i: row.id })).toString('base64url');
}

export function decodeCursor(raw: string): ExpenseCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { d?: unknown; i?: unknown };
    if (typeof parsed?.d !== 'string' || typeof parsed?.i !== 'string') return null;
    const date = new Date(parsed.d);
    if (isNaN(date.getTime())) return null;
    return { date, id: parsed.i };
  } catch {
    return null;
  }
}

/** No receipt attached and not explicitly skipped (NULL receiptStatus counts as not skipped). */
export function noReceiptWhere(): Prisma.AbExpenseWhereInput {
  return { receiptUrl: null, OR: [{ receiptStatus: null }, { receiptStatus: { not: 'skipped' } }] };
}

export type ParsedListQuery =
  | {
      ok: true;
      where: Prisma.AbExpenseWhereInput;
      limit: number;
      offset: number;
      cursor: ExpenseCursor | null;
      withCounts: boolean;
    }
  | { ok: false; error: string };

export function parseExpenseListQuery(params: URLSearchParams, tenantId: string): ParsedListQuery {
  const usesNewParams = NEW_LIST_PARAMS.some((p) => params.has(p));
  const where: Prisma.AbExpenseWhereInput = { tenantId };
  const and: Prisma.AbExpenseWhereInput[] = [];

  // ── legacy filters (unchanged semantics) ──
  const startDate = params.get('startDate');
  const endDate = params.get('endDate');
  if (startDate || endDate) {
    const date: { gte?: Date; lte?: Date } = {};
    if (startDate) date.gte = new Date(startDate);
    if (endDate) date.lte = new Date(endDate);
    where.date = date;
  }
  const isPersonal = params.get('isPersonal');
  if (isPersonal !== null) where.isPersonal = isPersonal === 'true';
  const vendorId = params.get('vendorId');
  if (vendorId) where.vendorId = vendorId;

  // ── mobile filters ──
  const status = params.get('status');
  if (status !== null) {
    if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
    where.status = status;
  }

  const hasReceipt = params.get('hasReceipt');
  if (hasReceipt === 'true') where.receiptUrl = { not: null };
  else if (hasReceipt === 'false') and.push(noReceiptWhere());
  else if (hasReceipt !== null) return { ok: false, error: 'hasReceipt must be true or false' };

  const categoryId = params.get('categoryId');
  if (categoryId === 'none') where.categoryId = null;
  else if (categoryId) where.categoryId = categoryId;

  const archived = params.get('archived') ?? 'false';
  if (archived === 'false') where.archivedAt = null;
  else if (archived === 'true') where.archivedAt = { not: null };
  else if (archived !== 'all') return { ok: false, error: 'archived must be true, false or all' };

  const q = (params.get('q') ?? '').trim().slice(0, Q_MAX);
  if (q) {
    and.push({
      OR: [
        { description: { contains: q, mode: 'insensitive' } },
        { notes: { contains: q, mode: 'insensitive' } },
        { vendor: { name: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }

  let cursor: ExpenseCursor | null = null;
  const rawCursor = params.get('cursor');
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return { ok: false, error: 'invalid cursor' };
    // Keyset on (date desc, id desc) — matches the route's orderBy.
    and.push({ OR: [{ date: { lt: cursor.date } }, { date: cursor.date, id: { lt: cursor.id } }] });
  }

  if (and.length > 0) where.AND = and;

  const requested = parseInt(params.get('limit') || String(DEFAULT_LIST_LIMIT), 10);
  const max = usesNewParams ? MOBILE_MAX_LIMIT : LEGACY_MAX_LIMIT;
  const limit = Math.min(max, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIST_LIMIT);
  const requestedOffset = parseInt(params.get('offset') || '0', 10);
  const offset = cursor ? 0 : Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

  return { ok: true, where, limit, offset, cursor, withCounts: params.get('withCounts') === '1' };
}

/** The where-clause behind a Docs chip (live rows only). Used by counts AND home alerts. */
export function docFilterWhere(tenantId: string, filter: DocFilter): Prisma.AbExpenseWhereInput {
  const parsed = parseExpenseListQuery(new URLSearchParams(DOC_FILTER_PARAMS[filter]), tenantId);
  if (!parsed.ok) throw new Error(`DOC_FILTER_PARAMS['${filter}'] is invalid: ${parsed.error}`);
  return { ...parsed.where, deletedAt: null };
}

export async function countDocFilters(tenantId: string): Promise<DocCounts> {
  const [needsReview, noCategory, noReceipt, archived] = await Promise.all([
    db.abExpense.count({ where: docFilterWhere(tenantId, 'needs-review') }),
    db.abExpense.count({ where: docFilterWhere(tenantId, 'no-category') }),
    db.abExpense.count({ where: docFilterWhere(tenantId, 'no-receipt') }),
    db.abExpense.count({ where: docFilterWhere(tenantId, 'archived') }),
  ]);
  return { needsReview, noCategory, noReceipt, archived };
}
