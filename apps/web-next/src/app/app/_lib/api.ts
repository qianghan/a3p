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
import { toMobileDoc } from '@/lib/mobile/doc-mapper';
import { RECEIPT_MAX_BYTES, IDEMPOTENCY_KEY_RE, MAX_AMOUNT_CENTS } from '@/lib/mobile/receipt-limits';

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
/**
 * Statuses whose meaning does not depend on the body: the tenant resolver's 401
 * says 'unauthorized' or a sentence ('invalid session'), and Vercel's own 413 /
 * 429 pages are not our JSON at all. Screens branch on these codes.
 */
const STATUS_CODES: Readonly<Record<number, string>> = { 401: 'unauthorized', 413: 'file_too_large', 429: 'rate_limited' };

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

  const fixedCode = STATUS_CODES[res.status];
  let body: Envelope<T> | null;
  try {
    body = (await res.json()) as Envelope<T> | null;
  } catch {
    // A platform error page (Vercel's plain-text 413, an HTML 502) is not JSON.
    // A 413 must still read as file_too_large: retrying it can never succeed.
    throw new ApiError(`HTTP ${res.status}`, res.status, fixedCode ?? 'bad_json', res.status === 429 ? retryAfterOf(null, res) : undefined);
  }

  if (!res.ok || !body || typeof body !== 'object' || Array.isArray(body) || body.success === false) {
    // Routes that send a sentence in `error` put the machine code in `code`
    // (from-receipt: in_progress / storage_unavailable / file_too_large …);
    // older routes put the code in `error` itself. Prefer the explicit one.
    const codeOf = (v: unknown) => (typeof v === 'string' && CODE_SHAPE.test(v) ? v : undefined);
    const serverCode = codeOf(body?.code) ?? codeOf(body?.error);
    const code = fixedCode ?? serverCode ?? `http_${res.status}`;
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
  /** Attached by the list and detail routes themselves (null once categorized); shape-checked before use. */
  suggestion?: unknown;
}

type Suggestion = NonNullable<MobileDoc['suggestion']>;

/** The route's `suggestion`, only if it has exactly the C1 shape — anything else is no suggestion. */
function suggestionOf(v: unknown): Suggestion | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.categoryId !== 'string' || !s.categoryId) return null;
  if (typeof s.categoryName !== 'string') return null;
  if (typeof s.confidence !== 'number' || !Number.isFinite(s.confidence)) return null;
  return { categoryId: s.categoryId, categoryName: s.categoryName, confidence: s.confidence };
}

const validDate = (v: unknown): v is string => typeof v === 'string' && v !== '' && !Number.isNaN(new Date(v).getTime());

/**
 * Raw expense row → MobileDoc through the server's own pure mapper
 * (lib/mobile/doc-mapper toMobileDoc), so status/receipt normalisation,
 * categorySource derivation, archivedAt, categoryName and `booked` follow ONE
 * set of rules. This wrapper only makes untrusted JSON safe to hand it
 * (toMobileDoc's `new Date(x).toISOString()` throws on a malformed date).
 *
 * `suggestion` defaults to the row's own shape-checked `suggestion`; pass one
 * (or null) explicitly to override it.
 */
export function rowToDoc(row: RawExpense, suggestion?: Suggestion | null): MobileDoc {
  const dateOk = validDate(row.date);
  const doc = toMobileDoc(
    {
      id: row.id,
      date: dateOk ? (row.date as string) : new Date(0),
      amountCents: typeof row.amountCents === 'number' && Number.isFinite(row.amountCents) ? row.amountCents : 0,
      vendorName: typeof row.vendorName === 'string' ? row.vendorName : null,
      vendor: typeof row.vendor?.name === 'string' ? { name: row.vendor.name } : null,
      description: typeof row.description === 'string' ? row.description : null,
      categoryId: typeof row.categoryId === 'string' && row.categoryId ? row.categoryId : null,
      categoryName: typeof row.categoryName === 'string' ? row.categoryName : null,
      confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence) ? row.confidence : null,
      status: typeof row.status === 'string' ? row.status : '',
      isPersonal: row.isPersonal === true,
      receiptUrl: typeof row.receiptUrl === 'string' ? row.receiptUrl : null,
      receiptStatus: typeof row.receiptStatus === 'string' ? row.receiptStatus : null,
      archivedAt: validDate(row.archivedAt) ? row.archivedAt : null,
      journalEntryId: row.journalEntryId ?? null,
    },
    suggestion === undefined ? suggestionOf(row.suggestion) : suggestion,
  );
  return {
    ...doc,
    date: dateOk ? doc.date : '',
    // A server that ever sends `booked` explicitly is authoritative over the derivation.
    booked: typeof row.booked === 'boolean' ? row.booked : doc.booked,
  };
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

  // One request: the list route attaches each uncategorized row's pending suggestion itself.
  const env = await call<RawExpense[]>(`${EXPENSE}/expenses?${qs.toString()}`);
  const rows = (Array.isArray(env.data) ? env.data : []).filter((r): r is RawExpense => !!r && typeof r.id === 'string');
  const meta = env.meta ?? {};
  return {
    items: rows.map((r) => rowToDoc(r)),
    nextCursor: typeof meta.nextCursor === 'string' && meta.nextCursor ? meta.nextCursor : null,
    counts: isCounts(meta.counts) ? meta.counts : null,
  };
}

export async function getDoc(id: string): Promise<MobileDoc> {
  // One request: the detail route attaches the pending suggestion itself.
  const row = await dataOf<RawExpense>(`${EXPENSE}/expenses/${enc(id)}`);
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') throw new ApiError('not_found', 404, 'not_found');
  return rowToDoc(row);
}

/**
 * The only fields patchDoc may send. NOT categoryId: PUT /expenses/[id] writes
 * it as given — no tenant/expense-account check, no journal repost, no vendor
 * learning — which would split the ledger from the document. Category changes
 * go through categorizeDoc only.
 */
const PATCHABLE = ['amountCents', 'vendor', 'date', 'description', 'isPersonal'] as const;
type PatchBody = Partial<{ amountCents: number; vendor: string; date: string; description: string; isPersonal: boolean }>;

/** PATCH then re-read: the PATCH route returns the bare row without vendor/category names. */
export async function patchDoc(id: string, body: PatchBody): Promise<MobileDoc> {
  // Allow-list at runtime too, so a cast (or a spread of a wider object) cannot smuggle categoryId through.
  const src = body as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const k of PATCHABLE) if (src[k] !== undefined) safe[k] = src[k];
  await call(`${EXPENSE}/expenses/${enc(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(safe) });
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

/**
 * Accept/reject pending AI suggestions (1-50 items); one result per item.
 *
 * `no_suggestion` is ambiguous and must not be read as success: it means
 * EITHER the expense is already categorized (e.g. a retried accept — done) OR
 * its suggestion is gone while it is still uncategorized (not done). Callers
 * must re-read the list (listDocs) after a review rather than assume the
 * outcome from the result codes.
 */
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
  // Pre-flight with the server's own limits (lib/mobile/receipt-limits): refuse
  // here rather than spend a multi-MB upload on a request that cannot succeed.
  if (file.size > RECEIPT_MAX_BYTES) {
    throw new ApiError(`file must be at most ${RECEIPT_MAX_BYTES} bytes`, 413, 'file_too_large');
  }
  if (typeof fields.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(fields.idempotencyKey)) {
    throw new ApiError('idempotencyKey must be 8-128 letters, digits, - or _', 400, 'bad_request');
  }
  let amount: number | undefined;
  if (fields.amountCents !== undefined) {
    amount = Math.round(fields.amountCents);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
      throw new ApiError('amountCents must be a positive integer', 400, 'bad_request');
    }
  }
  const form = new FormData();
  const name = typeof File !== 'undefined' && file instanceof File && file.name ? file.name : 'receipt.jpg';
  form.append('file', file, name);
  form.append('idempotencyKey', fields.idempotencyKey);
  if (amount !== undefined) form.append('amountCents', String(amount));
  if (fields.vendor !== undefined) form.append('vendor', fields.vendor);
  if (fields.date !== undefined) form.append('date', fields.date);
  if (fields.categoryId !== undefined) form.append('categoryId', fields.categoryId);
  if (fields.isPersonal !== undefined) form.append('isPersonal', fields.isPersonal ? 'true' : 'false');
  // No content-type header: the browser must write the multipart boundary.
  return dataOf<FromReceiptResult>(`${EXPENSE}/expenses/from-receipt`, { method: 'POST', body: form });
}

// ── Alert actions ────────────────────────────────────────────────────────────

/**
 * The endpoint comes from server data (MobileAlert.action), so it must not be
 * steerable: only the invoice-remind route of one invoice id, same-origin, with
 * no query, fragment, traversal or extra segments.
 */
const REMIND_ENDPOINT = /^\/api\/v1\/agentbook-invoice\/invoices\/[A-Za-z0-9_-]+\/remind$/;

export async function remindInvoice(endpoint: string): Promise<void> {
  if (typeof endpoint !== 'string' || !REMIND_ENDPOINT.test(endpoint)) {
    throw new ApiError('invalid_endpoint', 400, 'invalid_endpoint');
  }
  await call(endpoint, { method: 'POST' });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatPlanStep {
  id: string;
  description: string;
  status?: string;
}

export interface ChatReply {
  message: string;
  plan?: { steps: ChatPlanStep[]; requiresConfirmation: boolean };
  suggestions?: string[];
  undoAvailable?: boolean;
  sessionId?: string;
}

export interface ChatTurn {
  role: 'user' | 'bot';
  text: string;
  at: string;
  /** Brain intent of a bot turn (e.g. 'planner'); lets Chat rebuild a pending-plan card after a reload. */
  intent?: string;
}

interface RawBrainData {
  message?: unknown;
  plan?: { steps?: Array<{ id?: unknown; description?: unknown; status?: unknown }>; requiresConfirmation?: unknown } | null;
  suggestions?: unknown;
  undoAvailable?: unknown;
  sessionId?: unknown;
}

function toChatReply(d: RawBrainData | undefined | null): ChatReply {
  const reply: ChatReply = { message: typeof d?.message === 'string' ? d.message : '' };
  if (d?.plan && Array.isArray(d.plan.steps)) {
    reply.plan = {
      requiresConfirmation: d.plan.requiresConfirmation === true,
      steps: d.plan.steps.map((s, i) => ({
        id: typeof s.id === 'string' ? s.id : String(i),
        description: typeof s.description === 'string' ? s.description : '',
        ...(typeof s.status === 'string' ? { status: s.status } : {}),
      })),
    };
  }
  if (Array.isArray(d?.suggestions)) reply.suggestions = d.suggestions.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (typeof d?.undoAvailable === 'boolean') reply.undoAvailable = d.undoAvailable;
  if (typeof d?.sessionId === 'string') reply.sessionId = d.sessionId;
  return reply;
}

/**
 * POST agent/message (channel 'web'). Session actions are exempt from the
 * server's rate limit, so Proceed/Cancel still work at the ceiling. A 429
 * rejects with ApiError{ status:429, retryAfterMs, message } — `message` is
 * already localized by the server from Accept-Language.
 */
export async function sendChat(p: {
  text?: string;
  sessionAction?: 'confirm' | 'cancel' | 'skip' | 'undo' | 'status';
  attachments?: { type: 'photo'; url: string }[];
}): Promise<ChatReply> {
  const text = p.text?.trim();
  if (!text && !p.sessionAction) throw new ApiError('invalid_request', 400, 'invalid_request');
  const body: Record<string, unknown> = {};
  if (text) body.text = text;
  if (p.sessionAction) body.sessionAction = p.sessionAction;
  if (p.attachments && p.attachments.length > 0) body.attachments = p.attachments;
  const data = await dataOf<RawBrainData>(`${CORE}/agent/message`, postJson(body));
  return toChatReply(data);
}

interface RawThread {
  id?: unknown;
  lastActiveAt?: unknown;
}

interface RawTurn {
  role?: unknown;
  text?: unknown;
  at?: unknown;
  intent?: unknown;
}

const time = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

/**
 * The active web thread's turns, OLDEST-FIRST BY TIMESTAMP.
 *
 * Never by index: `conversation[]` ordering differs by producer in this
 * codebase (oldest-first from pairTurns, newest-first from the fallback
 * fetch), so the only stable order is the `at` field. Likewise the thread is
 * chosen by the newest `lastActiveAt`, not by being first in the list.
 */
export async function loadChatHistory(): Promise<ChatTurn[]> {
  const threads = await dataOf<RawThread[]>(`${CORE}/threads?channel=web&status=active`);
  const candidates = (Array.isArray(threads) ? threads : []).filter((t) => typeof t.id === 'string' && !Number.isNaN(time(t.lastActiveAt)));
  if (candidates.length === 0) return [];
  const latest = candidates.reduce((a, b) => (time(b.lastActiveAt) > time(a.lastActiveAt) ? b : a));
  const turns = await dataOf<RawTurn[]>(`${CORE}/threads/${enc(latest.id as string)}/turns`);
  return (Array.isArray(turns) ? turns : [])
    .filter((t) => typeof t.text === 'string' && t.text.trim() !== '' && !Number.isNaN(time(t.at)))
    .map((t): ChatTurn => ({ role: t.role === 'user' ? 'user' : 'bot', text: t.text as string, at: t.at as string, ...(typeof t.intent === 'string' ? { intent: t.intent } : {}) }))
    .sort((a, b) => time(a.at) - time(b.at));
}
