/**
 * Basiq API client. Basiq is a CDR-accredited (Consumer Data Right)
 * Australian open-banking data provider, added as a new, parallel bank-sync
 * path alongside Plaid (Plaid does not support AU banks). All AgentBook
 * Basiq access — business-side and personal-finance — goes through here.
 *
 * Auth model (different from Plaid's long-lived `access_token`):
 *   - SERVER_ACCESS token: server-to-server bearer token, expires every
 *     60 minutes. Cached in-process and refetched only within 5 minutes of
 *     expiry (never fetched fresh per-request) — see `getBasiqServerToken`.
 *   - CLIENT_ACCESS token: short-lived, scoped to one Basiq user, handed to
 *     the browser so it can load Basiq's *hosted* Consent UI
 *     (`consent.basiq.io`) — there is no client-embeddable widget like
 *     Plaid Link.
 *   - There is no Basiq analogue of Plaid's `access_token` to encrypt at
 *     rest: every call after consent is made server-side with the
 *     SERVER_ACCESS token against `users/{basiqUserId}/...`. The only
 *     durable identifiers persisted are `basiqUserId` (tenant-level) and
 *     `basiqAccountId` / `basiqConnectionId` (account-level) — plain ids,
 *     not secrets, so `agentbook-bank-token.ts`'s encryption helper is not
 *     needed here.
 *
 * API surface verified against Basiq's live v3/v2.1 docs as of 2026-07-22
 * (api.basiq.io/reference, api.basiq.io/v2.1/reference/*, and Basiq's
 * published job/transaction/account JSON examples). Notable corrections
 * versus a naive reading of the original integration plan, confirmed via
 * live docs:
 *   - A job's `verify-credentials` step result is `{ type: "link", url:
 *     "/users/{userId}/connections/{connectionId}" }` — the connection id
 *     is the last path segment of `result.url`, there is no `result.id`.
 *   - `BasiqAccount.institution` and `BasiqAccount.connection` are plain
 *     string resource ids, not `{ id }` objects.
 *   - `BasiqTransaction.account` is a plain string account id, not an
 *     `{ id }` object. Basiq also exposes a `direction` field
 *     ("debit" | "credit") alongside `amount`, which callers should prefer
 *     over sign-sniffing `amount` where available.
 *   - Confirmed: `amount` is a decimal string, negative for a debit/outflow
 *     (e.g. `"-139.98"` with `direction: "debit"`) — matches this file's
 *     sign-convention assumption used by Task 2's sync logic.
 *   - Confirmed: the `Authorization: Basic <BASIQ_API_KEY>` header uses the
 *     API key verbatim — it is NOT base64-re-encoded (Basiq's basic-auth
 *     variant deviates from the RFC 7617 standard here; encoding it again
 *     produces a 400).
 *   - Confirmed: `DELETE /users/{userId}/connections/{connectionId}` is the
 *     real path (not a bare `/connections/{connectionId}`).
 *   - NOT independently re-confirmed against a live sandbox call (no Basiq
 *     API key available in this environment): the exact `filter=` query
 *     string escaping for `listTransactions`'s `since` param, and the
 *     `POST /users/{userId}/connections` request body used by Task 2/3's
 *     hosted-Consent-UI flow (Basiq's docs show this endpoint normally
 *     taking `loginId`/`password`/`institution` or a `userToken`, which is
 *     hard to reconcile with a body-less call ahead of a redirect-based
 *     consent flow — Task 2's implementer should re-verify this specific
 *     request shape against a live sandbox call before wiring the route).
 */

import 'server-only';

const BASIQ_BASE = 'https://au-api.basiq.io';

let cachedToken: { token: string; expiresAt: number } | null = null;

function requireApiKey(): string {
  const key = process.env.BASIQ_API_KEY;
  if (!key) throw new Error('[basiq] BASIQ_API_KEY not set');
  return key;
}

/**
 * Fetch (and cache) a SERVER_ACCESS bearer token. Basiq tokens expire every
 * 60 minutes; we refetch only once we're within 5 minutes of that expiry so
 * normal request traffic never pays the extra round-trip.
 */
export async function getBasiqServerToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cachedToken.token;
  }
  const res = await fetch(`${BASIQ_BASE}/token`, {
    method: 'POST',
    headers: {
      // Verbatim API key, not base64-encoded — see file header note.
      Authorization: `Basic ${requireApiKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0',
    },
    body: 'scope=SERVER_ACCESS',
  });
  if (!res.ok) throw new Error(`[basiq] token request failed: ${res.status}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function basiqFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getBasiqServerToken();
  return fetch(`${BASIQ_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'basiq-version': '3.0',
      ...init.headers,
    },
  });
}

export async function createBasiqUser(
  _tenantId: string,
  email: string,
): Promise<{ basiqUserId: string }> {
  const res = await basiqFetch('/users', { method: 'POST', body: JSON.stringify({ email }) });
  if (!res.ok) throw new Error(`[basiq] createUser failed: ${res.status}`);
  const data = await res.json();
  return { basiqUserId: data.id };
}

export async function getBasiqClientToken(basiqUserId: string): Promise<string> {
  const token = await getBasiqServerToken();
  const res = await fetch(`${BASIQ_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0',
    },
    body: `scope=CLIENT_ACCESS&userId=${encodeURIComponent(basiqUserId)}`,
  });
  if (!res.ok) throw new Error(`[basiq] client token failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

/**
 * Kick off a connection job for a Basiq user. NOTE: per the file-header
 * caveat, Basiq's documented `POST /users/{userId}/connections` body
 * usually carries `loginId`/`password`/`institution` (or a `userToken`) —
 * an empty body is a defensive placeholder for this hosted-Consent-UI flow
 * and must be re-verified against a live sandbox call in Task 2, which
 * actually wires this into the connect UI.
 */
export async function createConnectionJob(basiqUserId: string): Promise<{ jobId: string }> {
  const res = await basiqFetch(`/users/${encodeURIComponent(basiqUserId)}/connections`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`[basiq] createConnectionJob failed: ${res.status}`);
  const data = await res.json();
  return { jobId: data.id ?? data.jobId };
}

export interface BasiqJobStatus {
  status: 'in-progress' | 'success' | 'failed';
  connectionId?: string;
  error?: string;
}

interface BasiqJobStep {
  title: string;
  status: string;
  result?: { type?: string; url?: string; id?: string } | null;
  error?: unknown;
}

/**
 * Parse a Basiq connection id out of a step's `result.url`, e.g.
 * `"/users/ea3a81/connections/8fce3b"` -> `"8fce3b"`. Falls back to
 * `result.id` defensively in case Basiq ever returns the id directly
 * (undocumented today, but cheap to tolerate).
 */
function connectionIdFromStepResult(result: BasiqJobStep['result']): string | undefined {
  if (!result) return undefined;
  if (result.id) return result.id;
  if (result.url) {
    const segments = result.url.split('/').filter(Boolean);
    return segments[segments.length - 1];
  }
  return undefined;
}

export async function pollJob(jobId: string): Promise<BasiqJobStatus> {
  const res = await basiqFetch(`/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`[basiq] pollJob failed: ${res.status}`);
  const data = await res.json();
  const steps: BasiqJobStep[] = data.steps ?? [];

  const failedStep = steps.find((s) => s.status === 'failed');
  if (failedStep) {
    return { status: 'failed', error: JSON.stringify(failedStep.error) };
  }

  const verify = steps.find((s) => s.title === 'verify-credentials');
  const allSucceeded = steps.length > 0 && steps.every((s) => s.status === 'success');
  return {
    status: allSucceeded ? 'success' : 'in-progress',
    connectionId: connectionIdFromStepResult(verify?.result),
  };
}

export interface BasiqAccount {
  id: string;
  accountNo?: string;
  name: string;
  accountHolder?: string;
  balance: string; // decimal string, e.g. "1234.56"
  currency: string;
  class?: { type?: string; product?: string };
  // Plain string resource ids per Basiq's live docs (not `{ id }` objects).
  institution?: string;
  connection?: string;
}

export async function listAccounts(basiqUserId: string): Promise<BasiqAccount[]> {
  const res = await basiqFetch(`/users/${encodeURIComponent(basiqUserId)}/accounts`);
  if (!res.ok) throw new Error(`[basiq] listAccounts failed: ${res.status}`);
  const data = await res.json();
  return data.data ?? [];
}

export interface BasiqTransaction {
  id: string;
  description: string;
  // Decimal string; negative = outflow/debit, positive = inflow/credit
  // (confirmed against Basiq's published examples, e.g. `"-139.98"` paired
  // with `direction: "debit"`).
  amount: string;
  // Present alongside `amount` — prefer this over sign-sniffing when
  // available, since it's an explicit enum rather than an inferred sign.
  direction?: 'debit' | 'credit';
  postDate: string;
  transactionDate?: string;
  // Plain string account resource id per Basiq's live docs (not `{ id }`).
  account: string;
  status: 'pending' | 'posted';
  class?: string;
}

export async function listTransactions(
  basiqUserId: string,
  opts: { since?: string } = {},
): Promise<BasiqTransaction[]> {
  // Filter query syntax per Basiq's SDK examples (`transaction.postDate.gt(...)`).
  // The exact raw HTTP escaping was not independently confirmed against a
  // live sandbox call in this environment — re-verify against real sandbox
  // responses before relying on `since` filtering in production (Task 2).
  const filter = opts.since
    ? `?filter=${encodeURIComponent(`transaction.postDate.gt('${opts.since}')`)}`
    : '';
  const res = await basiqFetch(`/users/${encodeURIComponent(basiqUserId)}/transactions${filter}`);
  if (!res.ok) throw new Error(`[basiq] listTransactions failed: ${res.status}`);
  const data = await res.json();
  return data.data ?? [];
}

export async function removeConnection(basiqUserId: string, connectionId: string): Promise<void> {
  const res = await basiqFetch(
    `/users/${encodeURIComponent(basiqUserId)}/connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`[basiq] removeConnection failed: ${res.status}`);
  }
}

/**
 * Translate a Basiq error into a client-safe value. Never return the raw
 * error message to clients — it can carry the `Authorization: Basic
 * <BASIQ_API_KEY>` or `Bearer <token>` header value via a rejected
 * fetch/axios-shaped error message.
 */
export function sanitizeBasiqError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      message: err.message
        .replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic [redacted]')
        .replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [redacted]'),
    };
  }
  return { message: 'unknown basiq error' };
}
