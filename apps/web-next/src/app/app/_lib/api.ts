/**
 * Typed client for every endpoint the /app PWA calls (contract C4).
 *
 * One function per endpoint, one error type. Every failure — non-2xx, a body
 * that is not JSON, a network drop, the service worker's synthetic offline
 * 503, a 429 — becomes an ApiError with a numeric `status` (0 = no
 * connectivity), a machine `code`, and `retryAfterMs` for rate limits. Screens
 * branch on those, never on message text.
 *
 * PRs 3-7 consume this file; they do not edit it.
 */
import type {
  MobileHome,
  UpcomingItem,
  DocFilter,
  MobileDoc,
  DocList,
  DocCounts,
  ExpenseCategory,
  ReviewItem,
  ReviewResult,
  FromReceiptResult,
} from '@/lib/mobile/types';
import { DOC_FILTER_PARAMS } from '@/lib/mobile/doc-filters';

export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: unknown;
  code?: unknown;
  message?: unknown;
  retryAfterMs?: unknown;
  meta?: Record<string, unknown>;
}

const CORE = '/api/v1/agentbook-core';
const EXPENSE = '/api/v1/agentbook-expense';
const JSON_HEADERS = { 'content-type': 'application/json' };
/** A server `code` / `error` that looks like a machine code (e.g. 'rate_limited'), not a sentence. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,40}$/;

function retryAfterOf(body: Envelope<unknown> | null, res: Response): number | undefined {
  if (body && typeof body.retryAfterMs === 'number' && body.retryAfterMs > 0) return body.retryAfterMs;
  const header = Number(res.headers?.get?.('Retry-After'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
}

async function call<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('network', 0, 'network');
  }
  // sw.js answers a failed network GET/POST with a synthetic 503 carrying this
  // header; fetch() does not throw for it, so it must be recognised here.
  if (res.headers?.get?.('X-Agentbook-Offline') === '1') throw new ApiError('offline', 0, 'offline');

  let body: Envelope<T> | null;
  try {
    body = (await res.json()) as Envelope<T> | null;
  } catch {
    throw new ApiError(`HTTP ${res.status}`, res.status, 'bad_json', res.status === 429 ? retryAfterOf(null, res) : undefined);
  }

  if (!res.ok || !body || typeof body !== 'object' || Array.isArray(body) || body.success === false) {
    // Routes that send a sentence in `error` put the machine code in `code`
    // (from-receipt: in_progress / storage_unavailable / file_too_large …);
    // older routes put the code in `error` itself. Prefer the explicit one.
    const codeOf = (v: unknown) => (typeof v === 'string' && CODE_SHAPE.test(v) ? v : undefined);
    const serverCode = codeOf(body?.code) ?? codeOf(body?.error);
    const code = res.status === 429 ? 'rate_limited' : serverCode ?? `http_${res.status}`;
    const message =
      typeof body?.message === 'string' && body.message
        ? body.message
        : typeof body?.error === 'string' && body.error
          ? body.error
          : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, code, res.status === 429 ? retryAfterOf(body, res) : undefined);
  }
  return body;
}

async function dataOf<T>(path: string, init?: RequestInit): Promise<T> {
  return (await call<T>(path, init)).data as T;
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

const enc = encodeURIComponent;

// ── Home ─────────────────────────────────────────────────────────────────────

let homeInFlight: Promise<MobileHome> | null = null;

/**
 * GET mobile/home. Concurrent callers share one request: the shell's tab
 * badges and the Home screen both ask on first paint, and that must cost one
 * round trip, not two.
 */
export function getHome(): Promise<MobileHome> {
  if (homeInFlight) return homeInFlight;
  const request: Promise<MobileHome> = dataOf<MobileHome>(`${CORE}/mobile/home`).finally(() => {
    if (homeInFlight === request) homeInFlight = null;
  });
  homeInFlight = request;
  return request;
}

export async function getUpcoming(days = 30): Promise<UpcomingItem[]> {
  const n = Math.round(Number.isFinite(days) ? days : 30);
  const clamped = Math.min(90, Math.max(1, n));
  const out = await dataOf<{ items?: UpcomingItem[] }>(`${CORE}/calendar/upcoming?days=${clamped}`);
  return Array.isArray(out?.items) ? out.items : [];
}

// ── Documents ────────────────────────────────────────────────────────────────

/** Docs filter → query params of the extended GET /expenses (C3). The only place this mapping lives. */
export const FILTER_PARAMS: Record<DocFilter, Readonly<Record<string, string>>> = DOC_FILTER_PARAMS;

/** The expense row as the expense routes return it (plus PR 1's added fields). */
export interface RawExpense {
  id: string;
  date?: string | null;
  amountCents?: number | null;
  vendorName?: string | null;
  vendor?: { name?: string | null } | null;
  description?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  categorySource?: string | null;
  confidence?: number | null;
  status?: string | null;
  isPersonal?: boolean | null;
  receiptUrl?: string | null;
  receiptStatus?: string | null;
  archivedAt?: string | null;
  /** The raw expense row carries the journal link; `booked` is derived from it (PR 1 final review). */
  journalEntryId?: string | null;
  booked?: boolean;
}

type Suggestion = NonNullable<MobileDoc['suggestion']>;

export function rowToDoc(row: RawExpense, suggestion: Suggestion | null): MobileDoc {
  const source = row.categorySource;
  const receipt = row.receiptStatus;
  return {
    id: row.id,
    date: String(row.date ?? '').slice(0, 10),
    amountCents: Number(row.amountCents) || 0,
    vendorName: row.vendorName ?? row.vendor?.name ?? null,
    description: row.description ?? null,
    categoryId: row.categoryId ?? null,
    categoryName: row.categoryName ?? null,
    categorySource: source === 'ai' || source === 'user' || source === 'rule' ? source : null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    status: row.status === 'pending_review' || row.status === 'rejected' ? row.status : 'confirmed',
    isPersonal: Boolean(row.isPersonal),
    receiptUrl: row.receiptUrl ?? null,
    receiptStatus: receipt === 'pending' || receipt === 'attached' || receipt === 'skipped' ? receipt : null,
    archivedAt: row.archivedAt ?? null,
    // Booked = posted to the ledger (journalEntryId set). NOT the same as status: pending_review rows get booked
    // by auto-categorize, the review route and from-receipt promotion failures. Amount/date/personal edits are
    // locked on this in the viewer because PUT does not repost the journal.
    booked: typeof row.booked === 'boolean' ? row.booked : row.journalEntryId != null,
    // A suggestion only means something while the document has no category.
    suggestion: row.categoryId ? null : suggestion,
  };
}

interface RawPending {
  expenseId?: string;
  suggestedCategoryId?: string;
  suggestedCategoryName?: string;
  confidence?: number;
}

async function pendingSuggestions(): Promise<Map<string, Suggestion>> {
  try {
    const out = await dataOf<{ items?: RawPending[] }>(`${CORE}/auto-categorize/pending`);
    const map = new Map<string, Suggestion>();
    for (const p of Array.isArray(out?.items) ? out.items : []) {
      if (!p.expenseId || !p.suggestedCategoryId) continue;
      map.set(p.expenseId, {
        categoryId: p.suggestedCategoryId,
        categoryName: p.suggestedCategoryName ?? '',
        confidence: typeof p.confidence === 'number' ? p.confidence : 0,
      });
    }
    return map;
  } catch {
    // Suggestions decorate a document; they never decide whether it loads.
    return new Map();
  }
}

function clampLimit(limit?: number): number {
  const n = Math.round(Number(limit ?? 30));
  return Math.min(100, Math.max(1, Number.isFinite(n) ? n : 30));
}

function isCounts(v: unknown): v is DocCounts {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return ['needsReview', 'noCategory', 'noReceipt', 'archived'].every((k) => typeof c[k] === 'number');
}

export async function listDocs(p: { filter?: DocFilter; q?: string; cursor?: string; limit?: number; withCounts?: boolean }): Promise<DocList> {
  const qs = new URLSearchParams(FILTER_PARAMS[p.filter ?? 'all']);
  const q = p.q?.trim();
  if (q) qs.set('q', q);
  if (p.cursor) qs.set('cursor', p.cursor);
  qs.set('limit', String(clampLimit(p.limit)));
  if (p.withCounts) qs.set('withCounts', '1');

  const [env, pending] = await Promise.all([call<RawExpense[]>(`${EXPENSE}/expenses?${qs.toString()}`), pendingSuggestions()]);
  const rows = Array.isArray(env.data) ? env.data : [];
  const meta = env.meta ?? {};
  return {
    items: rows.map((r) => rowToDoc(r, pending.get(r.id) ?? null)),
    nextCursor: typeof meta.nextCursor === 'string' && meta.nextCursor ? meta.nextCursor : null,
    counts: isCounts(meta.counts) ? meta.counts : null,
  };
}

export async function getDoc(id: string): Promise<MobileDoc> {
  const [row, pending] = await Promise.all([dataOf<RawExpense>(`${EXPENSE}/expenses/${enc(id)}`), pendingSuggestions()]);
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') throw new ApiError('not_found', 404, 'not_found');
  return rowToDoc(row, pending.get(row.id) ?? null);
}

/** PATCH then re-read: the PATCH route returns the bare row without vendor/category names. */
export async function patchDoc(
  id: string,
  body: Partial<{ amountCents: number; vendor: string; date: string; description: string; isPersonal: boolean; categoryId: string }>,
): Promise<MobileDoc> {
  await call(`${EXPENSE}/expenses/${enc(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
  return getDoc(id);
}

/** A human pick ('user' source → 1.0 confidence, vendor learning) via the existing categorize path. */
export async function categorizeDoc(id: string, categoryId: string): Promise<MobileDoc> {
  await call(`${EXPENSE}/expenses/${enc(id)}/categorize`, postJson({ categoryId, source: 'user' }));
  return getDoc(id);
}

export function archiveDoc(id: string): Promise<{ id: string; archivedAt: string }> {
  return dataOf(`${EXPENSE}/expenses/${enc(id)}/archive`, { method: 'POST' });
}

export function unarchiveDoc(id: string): Promise<{ id: string; archivedAt: null }> {
  return dataOf(`${EXPENSE}/expenses/${enc(id)}/unarchive`, { method: 'POST' });
}

export function deleteDoc(id: string): Promise<{ id: string }> {
  return dataOf(`${EXPENSE}/expenses/${enc(id)}`, { method: 'DELETE' });
}

export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const rows = await dataOf<Array<{ id?: unknown; name?: unknown; code?: unknown }>>(`${CORE}/accounts?type=expense`);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => typeof r.id === 'string' && typeof r.name === 'string')
    .map((r) => ({ id: r.id as string, name: r.name as string, code: typeof r.code === 'string' ? r.code : '' }));
}

export const MAX_REVIEW_ITEMS = 50;

export async function reviewSuggestions(items: ReviewItem[]): Promise<ReviewResult[]> {
  if (items.length === 0 || items.length > MAX_REVIEW_ITEMS) throw new ApiError('invalid_request', 400, 'invalid_request');
  const out = await dataOf<{ results?: ReviewResult[] }>(`${CORE}/auto-categorize/review`, postJson({ items }));
  return Array.isArray(out?.results) ? out.results : [];
}

export async function runAutoCategorize(): Promise<{ appliedCount: number; pendingCount: number; skippedCount: number }> {
  const out = await dataOf<Record<string, unknown>>(`${CORE}/auto-categorize/run`, { method: 'POST' });
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { appliedCount: n(out?.appliedCount), pendingCount: n(out?.pendingCount), skippedCount: n(out?.skippedCount) };
}

// ── Capture ──────────────────────────────────────────────────────────────────

export async function uploadReceipt(
  file: Blob,
  fields: { idempotencyKey: string; amountCents?: number; vendor?: string; date?: string; categoryId?: string; isPersonal?: boolean },
): Promise<FromReceiptResult> {
  if (!fields.idempotencyKey) throw new ApiError('invalid_request', 400, 'invalid_request');
  const form = new FormData();
  const name = typeof File !== 'undefined' && file instanceof File && file.name ? file.name : 'receipt.jpg';
  form.append('file', file, name);
  form.append('idempotencyKey', fields.idempotencyKey);
  if (fields.amountCents !== undefined) form.append('amountCents', String(Math.round(fields.amountCents)));
  if (fields.vendor !== undefined) form.append('vendor', fields.vendor);
  if (fields.date !== undefined) form.append('date', fields.date);
  if (fields.categoryId !== undefined) form.append('categoryId', fields.categoryId);
  if (fields.isPersonal !== undefined) form.append('isPersonal', fields.isPersonal ? 'true' : 'false');
  // No content-type header: the browser must write the multipart boundary.
  return dataOf<FromReceiptResult>(`${EXPENSE}/expenses/from-receipt`, { method: 'POST', body: form });
}

// ── Alert actions ────────────────────────────────────────────────────────────

/** Same-origin /api/v1 path only — the endpoint comes from server data and must not be steerable elsewhere. */
const SAFE_ENDPOINT = /^\/api\/v1\/[A-Za-z0-9_\-/]+$/;

export async function remindInvoice(endpoint: string): Promise<void> {
  if (typeof endpoint !== 'string' || !SAFE_ENDPOINT.test(endpoint) || endpoint.includes('//')) {
    throw new ApiError('invalid_endpoint', 400, 'invalid_endpoint');
  }
  await call(endpoint, { method: 'POST' });
}
