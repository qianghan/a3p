/**
 * Client calls the mobile screens need that are NOT in the C4 api.ts contract
 * (api.ts is owned by PR 2 and not edited by screen PRs). Each targets an
 * EXISTING production route. Fold these into api.ts when it is next revised.
 *
 * Errors are api.ts's own ApiError — same class, same codes — because
 * useMobileData's offline/stale handling is `instanceof ApiError`. A second
 * error class would make a dropped connection look like a hard failure here.
 * `HttpError` is kept as an alias of it for the C4-extension contract.
 */
import { defaultCurrencyFor } from '@/lib/jurisdiction-currency';
import { ApiError } from './api';

export { ApiError as HttpError };

const CORE = '/api/v1/agentbook-core';
const EXPENSE = '/api/v1/agentbook-expense';
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,40}$/;
/** Same status → code table as api.ts: these mean the same whatever the body says. */
const STATUS_CODES: Readonly<Record<number, string>> = { 401: 'unauthorized', 413: 'file_too_large', 429: 'rate_limited' };

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: unknown;
  code?: unknown;
  message?: unknown;
  retryAfterMs?: unknown;
}

function retryAfterOf(body: Envelope<unknown> | null, res: Response): number | undefined {
  if (body && typeof body.retryAfterMs === 'number' && body.retryAfterMs > 0) return body.retryAfterMs;
  const header = Number(res.headers?.get?.('Retry-After'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
}

/**
 * One fetch → the envelope's `data`, or an ApiError. Mirrors api.ts's private
 * `call` exactly (same-origin credentials, the service worker's offline 503,
 * non-JSON platform pages, machine codes, 429 retry-after); a parity test runs
 * both through the same responses so they cannot drift apart.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('network', 0, 'network');
  }
  // fetch() does not throw for the service worker's synthetic offline 503.
  if (res.headers?.get?.('X-Agentbook-Offline') === '1') throw new ApiError('offline', 0, 'offline');

  const fixedCode = STATUS_CODES[res.status];
  let body: Envelope<T> | null;
  try {
    body = (await res.json()) as Envelope<T> | null;
  } catch {
    throw new ApiError(`HTTP ${res.status}`, res.status, fixedCode ?? 'bad_json', res.status === 429 ? retryAfterOf(null, res) : undefined);
  }

  if (!res.ok || !body || typeof body !== 'object' || Array.isArray(body) || body.success === false) {
    const codeOf = (v: unknown) => (typeof v === 'string' && CODE_SHAPE.test(v) ? v : undefined);
    const code = fixedCode ?? codeOf(body?.code) ?? codeOf(body?.error) ?? `http_${res.status}`;
    const message =
      typeof body?.message === 'string' && body.message
        ? body.message
        : typeof body?.error === 'string' && body.error
          ? body.error
          : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, code, res.status === 429 ? retryAfterOf(body, res) : undefined);
  }
  return body.data as T;
}

export interface PendingSuggestion {
  expenseId: string;
  vendorName: string | null;
  amountCents: number;
  date: string;
  description: string | null;
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  confidence: number;
}

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function toSuggestion(raw: unknown): PendingSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.expenseId !== 'string' || !r.expenseId) return null;
  if (typeof r.suggestedCategoryId !== 'string' || !r.suggestedCategoryId) return null;
  if (typeof r.suggestedCategoryName !== 'string') return null;
  return {
    expenseId: r.expenseId,
    vendorName: typeof r.vendorName === 'string' ? r.vendorName : null,
    amountCents: finite(r.amountCents, 0),
    date: typeof r.date === 'string' && !Number.isNaN(Date.parse(r.date)) ? r.date : '',
    description: typeof r.description === 'string' ? r.description : null,
    suggestedCategoryId: r.suggestedCategoryId,
    suggestedCategoryName: r.suggestedCategoryName,
    confidence: finite(r.confidence, 0),
  };
}

/** The AI's pending category picks (already filtered server-side to still-uncategorized expenses). */
export async function getPendingSuggestions(): Promise<{ items: PendingSuggestion[]; uncategorizedCount: number }> {
  const data = await request<{ items?: unknown; uncategorizedCount?: unknown } | null>(`${CORE}/auto-categorize/pending`);
  const items = (Array.isArray(data?.items) ? data.items : []).map(toSuggestion).filter((s): s is PendingSuggestion => !!s);
  return { items, uncategorizedCount: finite(data?.uncategorizedCount, 0) };
}

/**
 * An explicit non-default currency wins. 'USD' is the AbTenantConfig schema
 * default, so on a non-US tenant it means "never set", not "bills in US
 * dollars": that falls back to the jurisdiction's currency. Never throws on a
 * malformed config.
 */
export function resolveTenantCurrency(cfg: { currency?: unknown; jurisdiction?: unknown } | null | undefined): string {
  const jurisdiction = typeof cfg?.jurisdiction === 'string' && cfg.jurisdiction.trim() ? cfg.jurisdiction.trim().toLowerCase() : 'us';
  const fallback = defaultCurrencyFor(jurisdiction);
  const currency = typeof cfg?.currency === 'string' ? cfg.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return fallback;
  if (currency === 'USD' && jurisdiction !== 'us') return fallback;
  return currency;
}

export async function getTenantCurrency(): Promise<string> {
  const cfg = await request<{ currency?: unknown; jurisdiction?: unknown } | null>(`${CORE}/tenant-config`);
  return resolveTenantCurrency(cfg && typeof cfg === 'object' ? cfg : null);
}

/**
 * Moves a pending_review expense to confirmed. Callers MUST only call this
 * when the expense has a category: the confirm route posts a journal entry
 * only when a category is known, so confirming an uncategorized business
 * expense would leave it "confirmed" but off the ledger.
 */
export async function confirmDoc(id: string): Promise<void> {
  if (typeof id !== 'string' || !id) throw new ApiError('invalid_request', 400, 'invalid_request');
  await request<unknown>(`${EXPENSE}/expenses/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}
