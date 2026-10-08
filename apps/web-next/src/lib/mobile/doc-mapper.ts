import type { MobileDoc } from './types';

/**
 * Row → MobileDoc. Pure (no server-only, no Prisma) so the client can map
 * /expenses rows with the exact same rules the server uses.
 */
export interface ExpenseRowLike {
  id: string;
  date: Date | string;
  amountCents: number;
  vendorName?: string | null;
  vendor?: { name: string } | null;
  description?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  confidence?: number | null;
  status: string;
  isPersonal: boolean;
  receiptUrl?: string | null;
  receiptStatus?: string | null;
  archivedAt?: Date | string | null;
}

export interface PendingSuggestionLike {
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  confidence: number;
}

/**
 * At or above this, a categorization is a human's: the categorize route writes
 * 1.0, Telegram's accept writes 0.95, a learned user pattern carries 0.95.
 * The auto-categorizer is capped below it (AUTO_PATTERN_CAP 0.92 / its own
 * model confidence < 0.95 in practice), so anything lower is labelled 'ai'.
 * There is no categorySource column; 'rule' is never derived.
 */
export const HUMAN_CATEGORY_CONFIDENCE = 0.95;

export function deriveCategorySource(
  row: { categoryId?: string | null; confidence?: number | null },
): MobileDoc['categorySource'] {
  if (!row.categoryId) return null;
  if (row.confidence === null || row.confidence === undefined) return 'user';
  return row.confidence >= HUMAN_CATEGORY_CONFIDENCE ? 'user' : 'ai';
}

export function suggestionFromPending(p: PendingSuggestionLike | null | undefined): MobileDoc['suggestion'] {
  if (!p) return null;
  return { categoryId: p.suggestedCategoryId, categoryName: p.suggestedCategoryName, confidence: p.confidence };
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

function normalizeStatus(s: string): MobileDoc['status'] {
  return s === 'pending_review' || s === 'rejected' ? s : 'confirmed';
}

function normalizeReceiptStatus(s: string | null | undefined): MobileDoc['receiptStatus'] {
  return s === 'pending' || s === 'attached' || s === 'skipped' ? s : null;
}

export function toMobileDoc(row: ExpenseRowLike, suggestion: MobileDoc['suggestion'] = null): MobileDoc {
  const categoryId = row.categoryId ?? null;
  return {
    id: row.id,
    date: toDate(row.date).toISOString().slice(0, 10),
    amountCents: row.amountCents,
    vendorName: row.vendorName ?? row.vendor?.name ?? null,
    description: row.description ?? null,
    categoryId,
    categoryName: categoryId ? row.categoryName ?? null : null,
    categorySource: deriveCategorySource({ categoryId, confidence: row.confidence ?? null }),
    confidence: row.confidence ?? null,
    status: normalizeStatus(row.status),
    isPersonal: row.isPersonal,
    receiptUrl: row.receiptUrl ?? null,
    receiptStatus: normalizeReceiptStatus(row.receiptStatus),
    archivedAt: row.archivedAt ? toDate(row.archivedAt).toISOString() : null,
    suggestion: categoryId ? null : suggestion,
  };
}
