# AU-1: Basiq Bank-Sync Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Australian tenants real, automated bank-sync — currently declined entirely because Plaid doesn't support AU banks — using Basiq, a CDR-accredited (Consumer Data Right) Australian data provider, at full feature parity with what Plaid already gives US/CA tenants: connect a bank, see accounts + transactions, auto-match against invoices/expenses, daily cron sync, disconnect.

**Architecture:** Basiq is added as a **new, parallel, additive implementation** alongside Plaid — not a refactor of Plaid into a shared "adapter" abstraction. Existing Plaid code (business-side dual Express+Next.js routes, personal-finance Next.js routes, both crons, both frontends) is untouched. New Basiq lib/routes/frontend branches are gated by `jurisdiction === 'au'` at the exact 3 call sites that already do this gating today (chat's `agent-brain.ts`, web's `personal/page.tsx`, and a currently-missing gate in the expense plugin's `BankConnection.tsx` that this plan adds). This is deliberate: refactoring already-shipped, working Plaid code into a shared interface is extra regression risk with no functional payoff for the stated goal (AU parity), so it's explicitly out of scope.

"As a plugin" is interpreted as: bank-sync isn't a freestanding plugin in this codebase today — Plaid's business-side UI lives inside the `agentbook-expense` plugin's frontend, while its personal-finance UI is a plain Next.js page, not a plugin at all. True parity means Basiq occupies the exact same two surfaces Plaid already does, using new Basiq-specific modules — not a third, separate `plugins/agentbook-bank-au` plugin, which would be *inconsistent* with how Plaid itself is built. If a literal standalone plugin was intended instead, flag it before starting Task 1 — the schema/lib work is shared either way, but routes/frontend wiring (Tasks 2–4) would move.

**Tech Stack:** Next.js 15 API routes (Node runtime), Prisma (multiSchema), Basiq REST API v3 (SERVER_ACCESS/CLIENT_ACCESS token model, async Job-based connection flow, hosted Consent UI — no client-embeddable widget like Plaid Link), existing AES-256-GCM token-encryption module, existing `processAll` cron-batching helper, vitest + Playwright.

## Global Constraints

- Every schema change is additive only (new nullable columns / new optional fields with defaults) — never alter or drop an existing Plaid-related column. Existing Plaid rows must be unaffected.
- Every new route mirrors the exact auth pattern of its Plaid sibling: business-side via `safeResolveAgentbookTenant`, personal-side via `requirePersonalInsightsAddon` (yes — Basiq bank sync is gated behind the same paid Personal Insights add-on Plaid is, for personal-finance; no bypass), crons via `CRON_SECRET` bearer + `safeCompareBearer`.
- Never log or persist the raw `BASIQ_API_KEY`. Reuse the existing `sanitizePlaidError`-style redaction pattern for Basiq errors (`sanitizeBasiqError`).
- Basiq's SERVER_ACCESS token expires every 60 minutes — cache it in-process and refetch when within 5 minutes of expiry; never fetch a fresh token per-request (mirrors the existing Plaid client singleton-cache pattern in spirit, adapted for token expiry that Plaid's own client doesn't have).
- Basiq has no long-lived secret analogous to Plaid's `access_token` — do not invent one. All calls after consent go through `users/{basiqUserId}/...` authenticated with the server-level token; the only durable per-tenant identifier to persist is `basiqUserId` (tenant-level) and `basiqAccountId`/`basiqConnectionId` (account-level).
- Chat (Telegram/WhatsApp/web-chat/MCP) cannot drive Basiq's Consent UI any more than it can drive Plaid Link — it's a hosted, redirect-based flow. Chat continues to redirect users to the web app for the actual connect step, for every jurisdiction, once this plan ships.
- All 3 existing AU bank-decline call sites (`agent-brain.ts`, `personal/page.tsx`, and the newly-added gate in `BankConnection.tsx`) must be updated together in the PR that removes the decline message — an inconsistent partial update reintroduces exactly the bug AU-7/PARITY-4 fixed.
- Every new test mocks the Basiq SDK/HTTP calls entirely (`vi.mock`) — never hits the real Basiq API in unit or route tests, matching the existing Plaid test convention. The real Consent UI round-trip is documented as a manual/e2e-skipped verification step, matching `tests/e2e/bank-plaid.spec.ts`'s precedent — Playwright cannot drive a redirected, bank-hosted OAuth-like login screen.
- Reuse existing shared code wherever the existing code is already provider-agnostic: `encryptToken`/`decryptToken` (`apps/web-next/src/lib/agentbook-bank-token.ts`), `processAll` batching helper, `runMatcherOnTransaction` (business-side matcher), `summarizeSyncRuns` (`apps/web-next/src/lib/plaid-sync-summary.ts` — genuinely generic despite its filename, do not duplicate it).

---

## Reference: exact Basiq API surface used in this plan

(Verified against Basiq's live API docs and web search as of 2026-07-19; **Task 1's first step is to re-confirm every path against the current sandbox docs before writing code**, since third-party API surfaces can shift.)

| Purpose | Method + path | Auth |
|---|---|---|
| Get SERVER_ACCESS token | `POST https://au-api.basiq.io/token` (body: `scope=SERVER_ACCESS`) | `Authorization: Basic <BASIQ_API_KEY>` (key passed verbatim, not base64-re-encoded) |
| Create a Basiq user | `POST https://au-api.basiq.io/users` | Bearer SERVER_ACCESS token |
| Get CLIENT_ACCESS token bound to a user | `POST https://au-api.basiq.io/token` (body: `scope=CLIENT_ACCESS&userId=<id>`) | Bearer SERVER_ACCESS token |
| Consent UI (hosted redirect) | `GET https://consent.basiq.io/home?token=<client_token>&redirectUrl=<app_callback>&state=<opaque>` | n/a — browser navigation. **Corrected during Task 1** (see below): the app never calls `POST /connections` itself for this flow — Basiq's hosted page collects the institution + credentials, creates the connection/job internally, then redirects the browser back to `redirectUrl` with the resulting `jobId` (and `state`) as query params. |
| ~~Create connection job~~ | ~~`POST https://au-api.basiq.io/users/{userId}/connections`~~ | **Not used by this plan.** This endpoint is the *alternative* "build your own UI" flow, where the app itself collects raw `loginId`/`password`/`institution` and submits them directly — deliberately avoided here in favor of the hosted Consent UI, which never requires the app to touch bank credentials at all. |
| Poll job status | `GET https://au-api.basiq.io/jobs/{jobId}` | Bearer SERVER_ACCESS token — steps: `verify-credentials` → `retrieve-accounts` → `retrieve-transactions`; the `verify-credentials` step's `result` is `{type:"link", url:"/users/{userId}/connections/{connectionId}"}` — parse the connection id off the last path segment of `result.url`, there is no `result.id`. |
| List accounts | `GET https://au-api.basiq.io/users/{userId}/accounts` | Bearer SERVER_ACCESS token |
| List transactions | `GET https://au-api.basiq.io/users/{userId}/transactions?filter=...` | Bearer SERVER_ACCESS token |
| Remove a connection | `DELETE https://au-api.basiq.io/users/{userId}/connections/{connectionId}` | Bearer SERVER_ACCESS token |

---

## Task 1: Schema migration + Basiq server lib (business-side) + unit tests

**Files:**
- Modify: `packages/database/prisma/schema.prisma` — `AbTenantConfig` (add `basiqUserId`), `AbBankAccount` (add `provider`, `basiqAccountId`, `basiqConnectionId`), `AbBankTransaction` (add `basiqTransactionId`)
- Create: `packages/database/prisma/migrations/<timestamp>_add_basiq_fields/migration.sql`
- Create: `apps/web-next/src/lib/agentbook-basiq.ts`
- Create: `apps/web-next/src/lib/agentbook-basiq.test.ts`
- Modify: `.env.example` (add `BASIQ_API_KEY`, `BASIQ_ENV`)

**Interfaces:**
- Produces: `getBasiqServerToken(): Promise<string>`, `createBasiqUser(tenantId: string, email: string): Promise<{basiqUserId: string}>`, `getBasiqClientToken(basiqUserId: string): Promise<string>`, `createConnectionJob(basiqUserId: string): Promise<{jobId: string}>`, `pollJob(jobId: string): Promise<{status: 'in-progress'|'success'|'failed'; connectionId?: string; error?: string}>`, `listAccounts(basiqUserId: string): Promise<BasiqAccount[]>`, `listTransactions(basiqUserId: string, opts?: {since?: string}): Promise<BasiqTransaction[]>`, `removeConnection(basiqUserId: string, connectionId: string): Promise<void>`, `sanitizeBasiqError(err: unknown): unknown` — all in `apps/web-next/src/lib/agentbook-basiq.ts`.
- Consumes: `encryptToken`/`decryptToken` from `apps/web-next/src/lib/agentbook-bank-token.ts` (not needed for the token itself since Basiq has none to encrypt, but reused if any future field needs it — see Task 1 step 4 note).

- [ ] **Step 1: Re-verify the Basiq API reference table above against the live docs**

  Before writing any code, open `https://api.basiq.io/reference/developer-hub` (or the current sandbox quickstart) and confirm every path/method in the "Reference" table above still matches, especially the job success-payload shape (where exactly `connectionId` appears) and the transactions-list filter syntax. Note any drift inline as a code comment where it affects Step 3below.

- [ ] **Step 2: Add schema fields (additive only)**

  ```prisma
  model AbTenantConfig {
    // ... existing fields unchanged ...
    basiqUserId String? // Basiq's tenant-level user resource id, created lazily on first AU bank-connect attempt
  }

  model AbBankAccount {
    // ... existing fields unchanged ...
    provider          String  @default("plaid") // "plaid" | "basiq"
    basiqAccountId    String? @unique
    basiqConnectionId String?
  }

  model AbBankTransaction {
    // ... existing fields unchanged ...
    basiqTransactionId String? @unique
  }
  ```
  Do the identical additive change to `AbPersonalAccount` and `AbPersonalTransaction` in the same migration (both need `provider`/`basiqAccountId`/`basiqConnectionId` and `basiqTransactionId` respectively) — Task 4 will consume them.

- [ ] **Step 3: Generate and review the migration**

  ```bash
  cd packages/database
  npx prisma migrate dev --name add_basiq_fields --create-only
  ```
  Confirm the generated SQL is pure `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements with defaults — no `NOT NULL` without a default, no column drops, no constraint changes to existing Plaid columns. This is the same shape as the existing `20260521260000_add_plaid_access_token_enc` migration — mirror its idempotent style.

- [ ] **Step 4: Write `agentbook-basiq.ts`**

  ```typescript
  import 'server-only';

  const BASIQ_BASE = 'https://au-api.basiq.io';
  let cachedToken: { token: string; expiresAt: number } | null = null;

  function requireApiKey(): string {
    const key = process.env.BASIQ_API_KEY;
    if (!key) throw new Error('[basiq] BASIQ_API_KEY not set');
    return key;
  }

  export async function getBasiqServerToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) {
      return cachedToken.token;
    }
    const res = await fetch(`${BASIQ_BASE}/token`, {
      method: 'POST',
      headers: {
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

  export async function createBasiqUser(tenantId: string, email: string): Promise<{ basiqUserId: string }> {
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
      body: `scope=CLIENT_ACCESS&userId=${basiqUserId}`,
    });
    if (!res.ok) throw new Error(`[basiq] client token failed: ${res.status}`);
    const data = await res.json();
    return data.access_token;
  }

  export async function createConnectionJob(basiqUserId: string): Promise<{ jobId: string }> {
    const res = await basiqFetch(`/users/${basiqUserId}/connections`, { method: 'POST', body: JSON.stringify({}) });
    if (!res.ok) throw new Error(`[basiq] createConnectionJob failed: ${res.status}`);
    const data = await res.json();
    return { jobId: data.id ?? data.jobId };
  }

  export interface BasiqJobStatus {
    status: 'in-progress' | 'success' | 'failed';
    connectionId?: string;
    error?: string;
  }

  export async function pollJob(jobId: string): Promise<BasiqJobStatus> {
    const res = await basiqFetch(`/jobs/${jobId}`);
    if (!res.ok) throw new Error(`[basiq] pollJob failed: ${res.status}`);
    const data = await res.json();
    const steps: Array<{ title: string; status: string; result?: { id?: string }; error?: unknown }> = data.steps ?? [];
    if (steps.some((s) => s.status === 'failed')) {
      return { status: 'failed', error: JSON.stringify(steps.find((s) => s.status === 'failed')?.error) };
    }
    const verify = steps.find((s) => s.title === 'verify-credentials');
    const allSucceeded = steps.length > 0 && steps.every((s) => s.status === 'success');
    return {
      status: allSucceeded ? 'success' : 'in-progress',
      connectionId: verify?.result?.id,
    };
  }

  export interface BasiqAccount {
    id: string;
    accountNo?: string;
    name: string;
    accountHolder?: string;
    balance: string; // Basiq returns balances as decimal strings, e.g. "1234.56"
    currency: string;
    class?: { type?: string; product?: string };
    institution?: { id?: string };
    connection?: { id?: string };
  }

  export async function listAccounts(basiqUserId: string): Promise<BasiqAccount[]> {
    const res = await basiqFetch(`/users/${basiqUserId}/accounts`);
    if (!res.ok) throw new Error(`[basiq] listAccounts failed: ${res.status}`);
    const data = await res.json();
    return data.data ?? [];
  }

  export interface BasiqTransaction {
    id: string;
    description: string;
    amount: string; // decimal string; negative = outflow, matching Plaid's own-account-outflow-positive is NOT the same sign convention — verify against sandbox data in Task 1 Step 1 and adjust the sign-normalization in Task 2's sync logic accordingly
    postDate: string;
    transactionDate?: string;
    account: { id: string };
    status: 'pending' | 'posted';
    class?: string;
  }

  export async function listTransactions(basiqUserId: string, opts: { since?: string } = {}): Promise<BasiqTransaction[]> {
    const filter = opts.since ? `?filter=transaction.postDate.gt('${opts.since}')` : '';
    const res = await basiqFetch(`/users/${basiqUserId}/transactions${filter}`);
    if (!res.ok) throw new Error(`[basiq] listTransactions failed: ${res.status}`);
    const data = await res.json();
    return data.data ?? [];
  }

  export async function removeConnection(basiqUserId: string, connectionId: string): Promise<void> {
    const res = await basiqFetch(`/users/${basiqUserId}/connections/${connectionId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`[basiq] removeConnection failed: ${res.status}`);
  }

  export function sanitizeBasiqError(err: unknown): unknown {
    if (err instanceof Error) {
      return { message: err.message.replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic [redacted]').replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [redacted]') };
    }
    return { message: 'unknown basiq error' };
  }
  ```

  Note the `amount` sign-convention TODO left inline — Basiq's own docs are the authority here, confirm in Step 1 before Task 2 writes the sync/matcher-feeding logic, since getting an outflow/inflow sign backwards would silently corrupt every AU expense-match.

  **Superseded during Task 1's implementation** (this code block is left as originally drafted for historical context; the actually-merged `agentbook-basiq.ts` differs in 3 ways, confirmed against Basiq's live docs):
  1. **`createConnectionJob` does not exist and must not be added.** `POST /users/{userId}/connections` with `loginId`/`password`/`institution` is the *alternative* "build your own UI" flow where the app collects raw bank credentials directly — not used here. The hosted Consent UI flow this plan actually uses never calls that endpoint: the consent URL itself must carry a `redirectUrl` (and optional `state`) parameter, e.g. `https://consent.basiq.io/home?token=<client_token>&redirectUrl=<app_callback>&state=<opaque>`. Basiq's own hosted page handles the institution + credentials and creates the connection/job internally, then redirects the browser back to `redirectUrl` with the resulting `jobId` (and `state`) as query parameters. **Task 2 needs a new callback route to receive that redirect and read `jobId` off its query string** — this route is in addition to, not instead of, the `status/route.ts` polling route described in Task 2 below (the callback route's only job is to read `jobId` from the redirect and hand the browser back to the app's UI, e.g. by redirecting again to `/agentbook/bank?jobId=...` so the frontend's existing poll logic can take over).
  2. `BasiqAccount.institution`, `BasiqAccount.connection`, and `BasiqTransaction.account` are plain string resource ids, not `{id}` objects — the interfaces above are stale on this point.
  3. A job's `verify-credentials` step result is `{type:"link", url:"/users/{userId}/connections/{connectionId}"}` — parse the connection id off the last path segment of `result.url`; there is no `result.id`. `BasiqTransaction` also carries a `direction: 'debit'|'credit'` field alongside `amount`, which Task 2 should prefer over sign-sniffing where available.

  The real, current `agentbook-basiq.ts` (merged in Task 1's PR) is the source of truth — read it directly rather than this historical snippet before writing Task 2's routes.

- [ ] **Step 5: Unit tests mirroring `agentbook-plaid.test.ts`'s pattern**

  ```typescript
  // apps/web-next/src/lib/agentbook-basiq.test.ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  vi.mock('server-only', () => ({}));

  describe('sanitizeBasiqError', () => {
    it('redacts Basic and Bearer credentials from error messages', async () => {
      const { sanitizeBasiqError } = await import('./agentbook-basiq');
      const err = new Error('failed with Authorization: Basic abc123XYZ==');
      expect(JSON.stringify(sanitizeBasiqError(err))).not.toContain('abc123XYZ');
    });
  });

  describe('getBasiqServerToken caching', () => {
    beforeEach(() => vi.resetModules());
    it('does not refetch a token that is not close to expiry', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) });
      vi.stubGlobal('fetch', fetchMock);
      const { getBasiqServerToken } = await import('./agentbook-basiq');
      await getBasiqServerToken();
      await getBasiqServerToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
  ```
  Run: `cd apps/web-next && npx vitest run src/lib/agentbook-basiq.test.ts` — expect both tests passing, no network calls made.

- [ ] **Step 6: Document env vars**

  Add to `.env.example` near the existing Plaid block:
  ```
  # Basiq (AU bank sync — CDR-accredited alternative to Plaid for Australian banks)
  BASIQ_API_KEY=          # from Basiq dashboard, sandbox key for local dev
  BASIQ_ENV=sandbox       # sandbox | production — informational only today (base URL is fixed to au-api.basiq.io for both; Basiq uses key-scoping, not a separate host, to distinguish sandbox/production)
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add packages/database/prisma/schema.prisma packages/database/prisma/migrations apps/web-next/src/lib/agentbook-basiq.ts apps/web-next/src/lib/agentbook-basiq.test.ts .env.example
  git commit -m "feat(agentbook): Basiq schema fields + server-side API lib (AU-1 task 1)"
  ```

---

## Task 2: Business-side Basiq Next.js routes + sync logic

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/consent-url/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/callback/route.ts` (**new vs. original draft** — receives Basiq's post-consent redirect; see Task 1's superseded-code note above)
- Create: `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/status/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/sync/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/disconnect/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: everything from Task 1's `agentbook-basiq.ts` (read the real merged file, not this section's original draft code — see the superseded-code note in Task 1) — note there is no `createConnectionJob` export; `safeResolveAgentbookTenant` from `apps/web-next/src/lib/agentbook-tenant.ts`; `runMatcherOnTransaction` from `apps/web-next/src/lib/agentbook-payment-matcher.ts` (existing, provider-agnostic); `encryptToken`/`decryptToken` not needed here (no Basiq secret to encrypt).
- Produces: 5 routes consumed by Task 3's frontend.

- [ ] **Step 1: `consent-url/route.ts` — `POST`, no body**

  Builds the hosted Consent UI redirect URL. Does **not** call `createConnectionJob` (it doesn't exist) — Basiq's own hosted page creates the connection/job when the user completes consent, then redirects the browser to this route's sibling `callback/route.ts` with the resulting `jobId`.

  ```typescript
  import { NextRequest, NextResponse } from 'next/server';
  import { prisma } from '@naap/database';
  import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
  import { createBasiqUser, getBasiqClientToken } from '@/lib/agentbook-basiq';

  export const runtime = 'nodejs';

  export async function POST(request: NextRequest): Promise<NextResponse> {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;

    let config = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
    let basiqUserId = config?.basiqUserId;
    if (!basiqUserId) {
      const user = await prisma.user.findUnique({ where: { id: tenantId } });
      const { basiqUserId: newId } = await createBasiqUser(tenantId, user?.email ?? `${tenantId}@agentbook.local`);
      basiqUserId = newId;
      await prisma.abTenantConfig.upsert({
        where: { userId: tenantId },
        create: { userId: tenantId, basiqUserId },
        update: { basiqUserId },
      });
    }

    const clientToken = await getBasiqClientToken(basiqUserId);
    // state carries the tenant id through Basiq's redirect round-trip so the
    // callback route can resolve the tenant without relying solely on a
    // cookie surviving the third-party navigation.
    const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
    const redirectUrl = `${appOrigin}/api/v1/agentbook-expense/bank/basiq/callback`;
    const consentUrl = `https://consent.basiq.io/home?token=${encodeURIComponent(clientToken)}&redirectUrl=${encodeURIComponent(redirectUrl)}&state=${encodeURIComponent(tenantId)}`;
    return NextResponse.json({ consentUrl });
  }
  ```

- [ ] **Step 1b: `callback/route.ts` — `GET`, receives Basiq's post-consent redirect**

  Basiq redirects the browser here with `?jobId=...&state=<tenantId>` (and possibly other params — read Basiq's actual redirect query shape from a live sandbox test before finalizing, since the plan's Step 1 in Task 1 flagged this as one of the two details not independently re-verified). This route's only job is to hand control back to the frontend popup — it should render a minimal page (or redirect once more to a static confirmation path the popup-poll logic in Task 3 recognizes) carrying `jobId` forward so `status/route.ts` can be polled from the parent window. Do not attempt to finalize account creation here — that stays in `status/route.ts`, which the frontend polls after this callback fires, exactly as originally planned.

  ```typescript
  import { NextRequest, NextResponse } from 'next/server';

  export const runtime = 'nodejs';

  // Basiq job ids are opaque alphanumeric resource identifiers. Validate
  // against this allowlist before the value is ever embedded in the HTML
  // response below — CodeQL flagged the unvalidated version of this exact
  // route as a high-severity reflected-XSS finding during Task 2's
  // implementation (a crafted `jobId` containing `</script>` could break out
  // of the inline script tag). Both fixed instances (business- and
  // personal-side) apply this same allowlist plus a `<`-escape on the
  // JSON-stringified value as defense in depth.
  const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

  export async function GET(request: NextRequest): Promise<NextResponse> {
    const rawJobId = request.nextUrl.searchParams.get('jobId');
    const jobId = rawJobId && SAFE_JOB_ID.test(rawJobId) ? rawJobId : null;
    const safeJobIdLiteral = JSON.stringify(jobId).replace(/</g, '\\u003c');
    // Render a tiny static HTML page whose only job is to let window.opener
    // (the popup's parent — Task 3's BankConnection.tsx) read `jobId` via
    // postMessage, then close itself. Keeps the actual job-polling logic in
    // one place (status/route.ts + the frontend's existing poll loop) rather
    // than duplicating it here.
    const html = `<!doctype html><script>
      if (window.opener) { window.opener.postMessage({ basiqJobId: ${safeJobIdLiteral} }, window.location.origin); }
      window.close();
    </script>`;
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } });
  }
  ```
  Task 3's popup-poll logic (originally a `setInterval` calling `status/route.ts` directly) should additionally listen for this `postMessage` as the trigger to start polling, rather than polling blindly from the moment the popup opens — revise Task 3's Step 2 accordingly when implementing it.

- [ ] **Step 2: `status/route.ts` — `GET ?jobId=`**

  On success, creates one `AbBankAccount` row per account returned by `listAccounts` that doesn't already exist (matched on `basiqAccountId`):
  ```typescript
  import { NextRequest, NextResponse } from 'next/server';
  import { prisma } from '@naap/database';
  import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
  import { pollJob, listAccounts } from '@/lib/agentbook-basiq';

  export const runtime = 'nodejs';

  export async function GET(request: NextRequest): Promise<NextResponse> {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;

    const jobId = request.nextUrl.searchParams.get('jobId');
    if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

    const config = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config?.basiqUserId) return NextResponse.json({ error: 'no basiq user for tenant' }, { status: 400 });

    const job = await pollJob(jobId);
    if (job.status !== 'success') return NextResponse.json({ status: job.status, error: job.error });

    const accounts = await listAccounts(config.basiqUserId);
    for (const acct of accounts) {
      await prisma.abBankAccount.upsert({
        where: { basiqAccountId: acct.id },
        create: {
          tenantId,
          provider: 'basiq',
          basiqAccountId: acct.id,
          basiqConnectionId: acct.connection?.id ?? job.connectionId,
          name: acct.name,
          type: (acct.class?.type ?? 'checking').toLowerCase(),
          balanceCents: Math.round(parseFloat(acct.balance) * 100),
          currency: acct.currency,
          institution: acct.institution?.id,
          connected: true,
          lastSynced: new Date(),
        },
        update: { connected: true, balanceCents: Math.round(parseFloat(acct.balance) * 100), lastSynced: new Date() },
      });
    }
    return NextResponse.json({ status: 'success', accountsLinked: accounts.length });
  }
  ```

- [ ] **Step 3: `sync/route.ts` — `POST`, no body — mirrors `plaid/sync/route.ts` exactly**

  Loop `prisma.abBankAccount.findMany({ where: { tenantId, provider: 'basiq', connected: true } })`, for each call `listTransactions(config.basiqUserId, { since: account.lastSynced?.toISOString() })`, upsert `AbBankTransaction` keyed on `basiqTransactionId`, **do not overwrite `category` on existing rows** (same rule as Plaid sync — preserves user re-categorization), then call `runMatcherOnTransaction` on newly-inserted rows exactly as the Plaid route does. Write an `abEvent` row `bank.basiq_sync_completed` after the loop, matching `bank.sync_completed`'s existing shape.

  ```typescript
  for (const acct of accounts) {
    const txns = await listTransactions(config.basiqUserId, { since: acct.lastSynced?.toISOString() });
    for (const t of txns) {
      const amountCents = Math.round(parseFloat(t.amount) * -100); // Basiq: negative=outflow; AbBankTransaction: positive=debit/outflow — negate to align, PER STEP 1's re-verified sign convention
      const created = await prisma.abBankTransaction.upsert({
        where: { basiqTransactionId: t.id },
        create: {
          tenantId, bankAccountId: acct.id, basiqTransactionId: t.id,
          amount: amountCents, date: new Date(t.postDate), name: t.description,
          pending: t.status === 'pending', matchStatus: 'pending',
        },
        update: { pending: t.status === 'pending' }, // category intentionally not touched
      });
      if (created) await runMatcherOnTransaction(created.id);
    }
    await prisma.abBankAccount.update({ where: { id: acct.id }, data: { lastSynced: new Date() } });
  }
  ```

- [ ] **Step 4: `disconnect/route.ts` — `POST {accountId}`**

  Mirrors `plaid/disconnect/route.ts`: look up the account, call `removeConnection(config.basiqUserId, account.basiqConnectionId)`, set `connected: false`.

- [ ] **Step 5: Route tests**

  Mirror the personal-side route-test pattern (`apps/web-next/src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts` is the closest precedent for this level of mocking, even though it's personal-side — same technique applies): `vi.mock('@/lib/agentbook-tenant')`, `vi.mock('@/lib/agentbook-basiq')`, `vi.mock('@naap/database')`, dynamically import each route's handler per test, assert status codes and the exact upsert calls made. Cover: happy path (job success → accounts created), job still in-progress (returns 200 with `status:'in-progress'`, no accounts created), job failed (returns the error), sync with zero accounts (no-op, no crash), disconnect removes connection and flips `connected:false`.

  Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-expense/bank/basiq` — expect all passing.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq
  git commit -m "feat(agentbook-expense): Basiq bank-sync routes for AU (AU-1 task 2)"
  ```

---

## Task 3: Business-side frontend — `BankConnection.tsx` AU branch (+ wire up the missing disconnect button for both providers)

**Files:**
- Modify: `plugins/agentbook-expense/frontend/src/pages/BankConnection.tsx`
- Modify: `plugins/agentbook-expense/frontend/src/__tests__/BankConnection.test.tsx` (create if it doesn't exist yet — check first)

**Interfaces:**
- Consumes: Task 2's 4 routes; tenant jurisdiction (fetch from `/api/v1/agentbook-core/tenant-config` the same way `personal/page.tsx` already does — read that file's existing jurisdiction-fetch `useEffect` and copy the pattern, don't reinvent it).

- [ ] **Step 1: Fetch jurisdiction on mount**

  Add a `jurisdiction` state var, populated the same way `personal/page.tsx` does (existing `GET /api/v1/agentbook-core/tenant-config` call already used elsewhere in this plugin's other pages — check `TaxDashboard.tsx`'s `SettingsTab` for the exact fetch, it's the most recently-touched precedent this session).

- [ ] **Step 2: Branch `handleStartConnect` on jurisdiction**

  **Revised vs. the original draft** (Task 2's `consent-url` route no longer returns a `jobId` up front — Basiq only produces one once the user completes consent inside the hosted popup, delivered via the `callback/route.ts` page's `postMessage`). Wait for that message before starting to poll, instead of polling blindly from the moment the popup opens:

  ```typescript
  const handleStartConnect = async () => {
    if (jurisdiction === 'au') {
      const res = await fetch('/api/v1/agentbook-expense/bank/basiq/consent-url', { method: 'POST' });
      const { consentUrl } = await res.json();
      const popup = window.open(consentUrl, 'basiq-consent', 'width=480,height=720');
      const BASIQ_TIMEOUT_MS = 5 * 60 * 1000; // Basiq's own consent flow can involve MFA/2FA steps — allow materially longer than Plaid's 45s Link-freeze watchdog, which is a different failure mode (a frozen iframe, not a legitimately slow multi-step login)
      const BASIQ_POLL_MS = 3000;

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || !event.data?.basiqJobId) return;
        window.removeEventListener('message', onMessage);
        const jobId = event.data.basiqJobId as string;
        const startedAt = Date.now();
        const poll = setInterval(async () => {
          if (Date.now() - startedAt > BASIQ_TIMEOUT_MS) {
            clearInterval(poll);
            setError('Bank connection timed out — please try again.');
            return;
          }
          const statusRes = await fetch(`/api/v1/agentbook-expense/bank/basiq/status?jobId=${jobId}`);
          const status = await statusRes.json();
          if (status.status === 'success') {
            clearInterval(poll);
            await loadAccounts(); // existing function that refreshes the account list — reuse it
          } else if (status.status === 'failed') {
            clearInterval(poll);
            setError(`Bank connection failed: ${status.error ?? 'unknown error'}`);
          }
        }, BASIQ_POLL_MS);
      };
      window.addEventListener('message', onMessage);
      // Fallback: if the popup is closed without ever posting a message (user
      // cancelled inside Basiq's UI before completing consent), stop waiting.
      const closeWatch = setInterval(() => {
        if (popup?.closed) {
          clearInterval(closeWatch);
          window.removeEventListener('message', onMessage);
        }
      }, 1000);
      return;
    }
    // ... existing Plaid Link flow, unchanged ...
  };
  ```

- [ ] **Step 3: Add a disconnect button to the connected-accounts list (currently missing for Plaid too — fix for both providers while touching this file)**

  Per the architecture-map, this page renders a connected-accounts list with no disconnect UI at all today (the route exists, just isn't wired to a button). Add one per-account row:
  ```tsx
  <button onClick={() => handleDisconnect(account.id, account.provider)}>Disconnect</button>
  ```
  ```typescript
  const handleDisconnect = async (accountId: string, provider: string) => {
    if (!window.confirm('Disconnect this bank account? Historical transactions are kept.')) return;
    const path = provider === 'basiq' ? '/api/v1/agentbook-expense/bank/basiq/disconnect' : '/api/v1/agentbook-expense/plaid/disconnect';
    await fetch(path, { method: 'POST', body: JSON.stringify({ accountId }), headers: { 'Content-Type': 'application/json' } });
    await loadAccounts();
  };
  ```
  This one small addition means AU parity work also closes a pre-existing UX gap on the Plaid side of this exact page — flag it in the PR description as an intentional, small scope addition, not scope creep, since it's required for genuine "parity" (an AU user with a working disconnect button while US/CA users on the same page don't have one would be worse, not equal).

- [ ] **Step 4: Component test**

  Test: jurisdiction `'au'` renders the Basiq-branch button and never calls `usePlaidLink`; jurisdiction `'us'`/`'ca'` renders the existing Plaid flow unchanged; disconnect button calls the correct provider-specific route. Mock `window.open`, `fetch`, and `usePlaidLink` (existing tests likely already mock the latter — reuse that mock setup).

  Run: `cd plugins/agentbook-expense/frontend && npx vitest run src/__tests__/BankConnection.test.tsx`

- [ ] **Step 5: Rebuild + copy the plugin CDN bundle**

  ```bash
  cd plugins/agentbook-expense/frontend && npm run build
  cp dist/production/agentbook-expense.js ../../../apps/web-next/public/cdn/plugins/agentbook-expense/agentbook-expense.js
  cp dist/production/agentbook-expense.js ../../../apps/web-next/public/cdn/plugins/agentbook-expense/1.0.0/agentbook-expense.js
  cp dist/production/*.css ../../../apps/web-next/public/cdn/plugins/agentbook-expense/1.0.0/
  cp dist/production/manifest.json ../../../apps/web-next/public/cdn/plugins/agentbook-expense/1.0.0/manifest.json
  ```
  (Per this repo's established convention — the bundle must be rebuilt and the CDN copy committed, or production silently keeps serving the old bundle regardless of source changes; this was independently confirmed as a real, live problem earlier in this project's history.)

- [ ] **Step 6: Commit**

  ```bash
  git add plugins/agentbook-expense/frontend apps/web-next/public/cdn/plugins/agentbook-expense
  git commit -m "feat(agentbook-expense): Basiq connect flow + disconnect button in BankConnection UI (AU-1 task 3)"
  ```

---

## Task 4: Personal-finance Basiq routes + frontend

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/consent-url/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/callback/route.ts` (mirrors Task 2's `callback/route.ts` — see that task's Step 1b)
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/status/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/sync/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/disconnect/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/__tests__/routes.test.ts`
- Modify: `apps/web-next/src/app/(dashboard)/personal/page.tsx`

**Interfaces:**
- Consumes: Task 1's `agentbook-basiq.ts`; `requirePersonalInsightsAddon` from `apps/web-next/src/lib/agentbook-personal-insights/guard.ts` (link-token/exchange/sync routes gated; disconnect is not, matching Plaid's exact precedent); `AbPersonalAccount`/`AbPersonalTransaction` from Task 1's schema additions.

- [ ] **Step 1–4: Same 4 routes as Task 2, targeting `AbPersonalAccount`/`AbPersonalTransaction`**

  Identical logic to Task 2's routes with two deliberate differences, both matching Plaid's existing personal-side precedent exactly: (a) `consent-url`/`status`/`sync` wrapped in `requirePersonalInsightsAddon` instead of plain `safeResolveAgentbookTenant`; `disconnect` uses plain `safeResolveAgentbookTenant` (no addon gate) — copy this asymmetry from `apps/web-next/src/app/api/v1/agentbook-personal/plaid/disconnect/route.ts` exactly. (b) Transaction amount sign is **inverted again** relative to Task 2's business-side convention, matching `agentbook-personal-plaid.ts`'s documented divergence (`AbPersonalTransaction.amountCents`: positive=inflow) — do not copy Task 2's sign formula verbatim, flip it.

- [ ] **Step 5: `personal/page.tsx` — replace the AU decline branch**

  Current code (lines ~232–244, per the architecture map) sets `bankResult` to the decline string when `jurisdiction === 'au'`. Replace with the same consent-url + popup-poll pattern from Task 3 Step 2, calling the `agentbook-personal` routes instead. Reuse the exact popup/poll constants (`BASIQ_POLL_MS`, `BASIQ_TIMEOUT_MS`) — define them once in a small shared helper (`apps/web-next/src/lib/use-basiq-connect.ts`, a tiny hook) that both `BankConnection.tsx` (Task 3) and `personal/page.tsx` import, instead of duplicating the polling loop twice. (This is the one piece of intentional DRY-ing across Tasks 3 and 4 — everything else in this plan is deliberately kept parallel/separate per the architecture note.)

  Extend the existing per-account `handleBankDisconnect` to branch on `account.provider` exactly as Task 3 Step 3 does for the business side.

- [ ] **Step 6: Route + component tests**

  Route tests mirror `apps/web-next/src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts` exactly (same mocking of the addon guard, tenant resolver, and the new `agentbook-basiq` lib) — additionally assert the 402 response when `requirePersonalInsightsAddon` denies, using the exact same message string Plaid's routes return, so AU users see identical upsell copy.

  Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-personal/bank/basiq src/lib/use-basiq-connect.test.ts`

- [ ] **Step 7: Commit**

  ```bash
  git add apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq apps/web-next/src/app/\(dashboard\)/personal/page.tsx apps/web-next/src/lib/use-basiq-connect.ts
  git commit -m "feat(agentbook): Basiq bank-sync for Personal Finance, AU tenants (AU-1 task 4)"
  ```

---

## Task 5: Daily cron sync (both surfaces)

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook/cron/basiq-sync/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook/cron/personal-basiq-sync/route.ts`
- Create matching `__tests__` files mirroring the existing Plaid cron tests
- Modify: `vercel.json` (crons array)

**Interfaces:**
- Consumes: `processAll` batching helper (existing, generic — find its current location via the Plaid cron routes and import from there, don't duplicate it), Task 2/4's route logic refactored into a shared `syncAllBasiqAccounts()`/`syncAllPersonalBasiqAccounts()` function each cron calls (extract this function during Task 2/4 if not already factored out, so the cron and the manual `/sync` route share one implementation — matching how the Plaid cron and Plaid manual-sync route already share `syncTransactionsForAccount`).

- [ ] **Step 1: Extract shared sync functions (retroactive small refactor of Tasks 2 & 4)**

  If Task 2/4's route handlers inlined the sync loop directly in the route file, extract it now to `apps/web-next/src/lib/agentbook-basiq-sync.ts` exporting `syncBasiqAccount(accountId: string): Promise<SyncRun>` (business) and an equivalent in a personal-side file — matching the exact `SyncRun` shape `plaid-sync-summary.ts`'s `summarizeSyncRuns` already expects, so that function is reused as-is for the AU cron's response summary.

- [ ] **Step 2: `basiq-sync/route.ts`**

  ```typescript
  import { NextRequest, NextResponse } from 'next/server';
  import { prisma } from '@naap/database';
  import { isCronAuthenticated } from '@/lib/agentbook-tenant'; // exact helper name per the architecture map's item 2c — confirm export name before use
  import { processAll } from '@/lib/process-all'; // confirm exact existing path from the Plaid cron route
  import { syncBasiqAccount } from '@/lib/agentbook-basiq-sync';
  import { summarizeSyncRuns } from '@/lib/plaid-sync-summary'; // reused as-is, genuinely provider-agnostic

  export const runtime = 'nodejs';

  export async function GET(request: NextRequest): Promise<NextResponse> {
    if (!isCronAuthenticated(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const accounts = await prisma.abBankAccount.findMany({ where: { provider: 'basiq', connected: true } });
    const byTenant = new Map<string, typeof accounts>();
    for (const a of accounts) byTenant.set(a.tenantId, [...(byTenant.get(a.tenantId) ?? []), a]);

    const results = await processAll([...byTenant.entries()], 5, async ([tenantId, tenantAccounts]) => {
      const runs = await Promise.allSettled(tenantAccounts.map((a) => syncBasiqAccount(a.id)));
      await prisma.abEvent.create({ data: { tenantId, type: 'bank.basiq_cron_sync_completed', metadata: { accountCount: tenantAccounts.length } } });
      return runs;
    });
    return NextResponse.json({ summary: summarizeSyncRuns(results.flat().filter((r) => r.status === 'fulfilled').map((r: any) => r.value)) });
  }
  ```
  `personal-basiq-sync/route.ts` is the same shape against `AbPersonalAccount`/`syncPersonalBasiqAccount` and event type `personal.basiq_cron_sync_completed`.

- [ ] **Step 3: Register in `vercel.json`**

  ```json
  { "path": "/api/v1/agentbook/cron/basiq-sync", "schedule": "15 6 * * *" },
  { "path": "/api/v1/agentbook/cron/personal-basiq-sync", "schedule": "20 6 * * *" }
  ```
  Offset by 5 and 10 minutes from the existing Plaid crons' `0 6 * * *` — purely so all four don't hit the DB in the same minute; not a functional requirement, just good hygiene.

- [ ] **Step 4: Cron auth + fan-out tests**

  Mirror `apps/web-next/src/__tests__/api/v1/agentbook/cron/personal-plaid-sync-route.test.ts` exactly: missing/wrong bearer → 401; one account's sync rejecting doesn't stop others (assert via a mocked `syncBasiqAccount` that rejects for one tenant and resolves for another, confirm both tenants got an `abEvent` row / the surviving tenant's result is present in the summary).

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web-next/src/app/api/v1/agentbook/cron/basiq-sync apps/web-next/src/app/api/v1/agentbook/cron/personal-basiq-sync apps/web-next/src/lib/agentbook-basiq-sync.ts vercel.json
  git commit -m "feat(agentbook): daily Basiq sync crons, business + personal (AU-1 task 5)"
  ```

---

## Task 6: Chat/MCP — remove the AU decline, unify the redirect message

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts`
- Modify: `plugins/agentbook-core/backend/src/__tests__/plaid-connect-redirect.test.ts`
- Modify: `plugins/agentbook-core/backend/src/server.ts` (onboarding-step copy strings, ~6 sites per the architecture map)

**Interfaces:**
- No new interfaces — this task deletes special-casing.

- [ ] **Step 1: Delete the AU-specific branch in `handleAgentMessage`'s Step 1d**

  Once Basiq ships, there is no functional reason for chat to say anything different to an AU tenant than to a US/CA tenant — both get redirected to the web app because chat can't drive either provider's hosted UI. Replace:
  ```typescript
  if (PLAID_CONNECT_BANK_RE.test(text.trim())) {
    const tenantConfig = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
    if (tenantConfig?.jurisdiction?.toLowerCase() === 'au') {
      return buildResponse({ message: "Bank sync isn't available for Australian accounts yet...", ... });
    }
    return buildResponse({ message: "I can't connect a bank account directly in chat...", ... });
  }
  ```
  with:
  ```typescript
  if (PLAID_CONNECT_BANK_RE.test(text.trim())) {
    return buildResponse({
      message: "I can't connect a bank account directly in chat — that needs an interactive widget. Open Personal Finance (/personal) in the app and tap \"Connect bank\".",
      skillUsed: 'bank-connect-redirect', // renamed from 'plaid-connect-redirect' since it's no longer Plaid-specific — update every reference to the old skill name in telemetry/evaluation code
      confidence: 1, latencyMs: Date.now() - startTime,
    });
  }
  ```
  Note the tenant-config lookup is now dead code and removed entirely — one less DB round-trip on this path too.

- [ ] **Step 2: Rename `skillUsed: 'plaid-connect-redirect'` everywhere it's referenced**

  Grep the whole `plugins/agentbook-core/backend/src` tree for the literal string `plaid-connect-redirect` and rename to `bank-connect-redirect` at every site (evaluator/telemetry code likely references it by string for skill-usage stats — check `agent-evaluator.ts`).

- [ ] **Step 3: Update onboarding-copy strings**

  The ~6 sites noted in the architecture map (`server.ts` lines ~199, 854, 911, 1905, 1944, 5769) say things like `"Connect your bank — Link via Plaid for auto-import"`. Change to provider-neutral copy: `"Connect your bank — automatic import for supported countries"` (or similar — keep it short, this is onboarding-checklist copy, not a place for a jurisdiction essay).

- [ ] **Step 4: Update the test**

  `plaid-connect-redirect.test.ts` currently asserts AU gets the decline message and non-AU gets the redirect message. Change to assert **AU and non-AU now get the identical redirect message** — this is the whole point of the parity work landing, make the test say so explicitly (a comment like `// AU-1 shipped: AU tenants no longer get a special decline path` makes the intent obvious to future readers). Consider renaming the test file to `bank-connect-redirect.test.ts` to match Step 2's rename.

- [ ] **Step 5: Commit**

  ```bash
  git add plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/
  git commit -m "feat(agentbook-core): remove AU bank-sync decline now that Basiq ships parity (AU-1 task 6)"
  ```

---

## Task 7: CSP, production env, docs, e2e — final production-readiness sweep

**Files:**
- Modify: `apps/web-next/src/middleware.ts` (CSP)
- Modify: `agentbook/PRODUCTION-ENV.md` (or whichever file currently tracks required prod env vars — confirm exact filename first)
- Modify: `apps/web-next/src/content/docs/regions/australia.mdx` (flip the "Bank sync — Not available yet" section written earlier this session)
- Create: `tests/e2e/bank-basiq.spec.ts` (mirrors `tests/e2e/bank-plaid.spec.ts` — `test.skip`, documents manual sandbox verification, seeds DB directly to test the matcher)
- Create: `tests/e2e/personal-bank-basiq.spec.ts` (mirrors `tests/e2e/personal-bank-plaid.spec.ts` — live route-shape + 402-gate checks against a deployed environment)

- [ ] **Step 1: CSP**

  In `apps/web-next/src/middleware.ts`'s CSP builder, alongside the existing `https://*.plaid.com` allowances, add:
  ```
  frame-src ... https://consent.basiq.io;
  connect-src ... https://consent.basiq.io;
  ```
  (No `au-api.basiq.io` entry needed — all direct API calls happen server-side in Next.js route handlers, never from the browser; only the hosted Consent UI is loaded client-side.)

- [ ] **Step 2: Production env var**

  Set `BASIQ_API_KEY` in Vercel production (and preview, with a separate sandbox key) via `vercel env add BASIQ_API_KEY production`, following this repo's established one-off env-provisioning convention. Update whichever doc currently tracks "what's set in prod" (confirm the exact file — it was named `agentbook/PRODUCTION-ENV.md` as of this plan's writing) with a new row for `BASIQ_API_KEY`.

- [ ] **Step 3: Flip the AU docs page**

  `apps/web-next/src/content/docs/regions/australia.mdx` currently says (written this session, before Basiq was decided):
  > "**Not available yet.** Our bank-connection provider (Plaid) doesn't support Australian banks. Log expenses manually, or from a receipt photo — everything else ... works normally without a connected bank."

  Replace with something accurate to what Task 1–6 actually shipped, e.g.:
  > "Bank sync works via Basiq, a CDR-accredited Australian data provider — connect your bank the same way as US/Canada tenants, from Business Profile or Personal Finance."

  Also update `apps/web-next/src/content/docs/regions/overview.mdx` if it lists bank sync in a supported-countries comparison table (it likely does, based on this session's earlier docs work).

- [ ] **Step 4: e2e specs**

  `bank-basiq.spec.ts`: `test.skip(true, 'Basiq Consent UI is a redirected/popup third-party flow — see manual verification steps in this file's comments')`; document manual sandbox credentials/institution once available from the Basiq dashboard. Seed an `AbBankAccount{provider:'basiq'}` + `AbBankTransaction` directly via Prisma in a `beforeAll`, then exercise `runMatcherOnTransaction` exactly as `bank-plaid.spec.ts` does for Plaid — this is the part that's actually automatable and valuable.

  `personal-bank-basiq.spec.ts`: NOT skipped, mirrors `personal-bank-plaid.spec.ts` — hits the deployed `agentbook-personal/bank/basiq/*` routes to verify shape + the 402 add-on gate, using `E2E_BASE_URL`.

- [ ] **Step 5: Manual verification checklist (run once, in a real browser, against a Basiq sandbox key, before calling this plan done)**

  - [ ] AU test tenant (`sydney@agentbook.test` — already seeded per this project's existing AU test account) → Business Profile → confirm no more "Not available yet" message anywhere.
  - [ ] Expense plugin → Bank page → "Connect bank" → Basiq sandbox consent popup opens → complete sandbox bank login → popup closes → account appears in the list with correct name/balance/currency.
  - [ ] Manually trigger `/api/v1/agentbook-expense/bank/basiq/sync` → confirm transactions appear, at least one auto-matches against a seeded test invoice/expense.
  - [ ] Disconnect the account → confirm it disappears/flips `connected:false`, historical transactions remain queryable.
  - [ ] Repeat the same 4 checks on Personal Finance (`/personal`), confirming the 402 upsell gate fires correctly for a tenant without the Personal Insights add-on.
  - [ ] Ask the Telegram/WhatsApp/web-chat bot "connect my bank" as an AU tenant → confirm it gives the same web-redirect message a US/CA tenant gets (no more AU-specific decline).
  - [ ] Confirm the two new cron routes return 401 without the bearer and 200 with it, via a manual `curl`.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web-next/src/middleware.ts agentbook/PRODUCTION-ENV.md apps/web-next/src/content/docs/regions tests/e2e/bank-basiq.spec.ts tests/e2e/personal-bank-basiq.spec.ts
  git commit -m "chore(agentbook): CSP, prod env, docs, e2e for Basiq bank-sync (AU-1 task 7)"
  ```

---

## Appendix: other known open items, tracked here per request

These are not part of AU-1 — they're the other real, known gaps surfaced during this project's launch-readiness review, consolidated here as a follow-up task list so nothing gets lost. Tasks 8–11 already have investigation/fix work started in separate sessions as of 2026-07-19; Task 12 (French/Quebec UI) has no prior work and gets a real, scoped implementation plan below.

### Task 8: Fix UK jurisdiction silently falling through to US tax rules

**Problem:** `apps/web-next/src/lib/jurisdiction-currency.ts`'s `JURISDICTION_OPTIONS` includes a selectable `🇬🇧 United Kingdom` option in Business Profile's country dropdown, but `packages/agentbook-jurisdictions/src/tax-questionnaire-loader.ts` explicitly does not register a UK pack, and `plugins/agentbook-core/backend/src/server.ts` documents UK falling through to the US-labeled rules branch — a UK tenant gets silently wrong (US-shaped) tax numbers with no warning.

**Status:** Investigation started in a separate session as of 2026-07-19 — first checking whether `packages/agentbook-jurisdictions/src/uk/` (a full 10-file pack already exists there: tax-brackets, mileage-rate, self-employment-tax, sales-tax, deductions, chart-of-accounts, contractor-report, installment-schedule, calendar-deadlines, index) is complete enough to wire in properly, vs. the smaller fix of removing "UK" from the selector until it's ready.

**Definition of done:** Either (a) UK is fully wired into `tax-questionnaire-loader.ts` and every route that currently falls through to US rules, with tests proving UK tenants get real UK numbers, or (b) UK is removed from `JURISDICTION_OPTIONS` until (a) is done — either way, `grep -rn "uk" packages/agentbook-jurisdictions/src/tax-questionnaire-loader.ts` and the AgentBook tax/payroll routes show no silent US fallback for a UK-selected tenant.

- [ ] Confirm which of the two directions the in-progress session took and merge its PR.
- [ ] If descoped (UK removed from selector): update `docs/regions/overview.mdx`'s supported-countries list to not imply UK readiness anywhere.
- [ ] If wired in: add UK to the docs Regions section (new `docs/regions/united-kingdom.mdx`, matching the existing US/CA/AU guide format) and to the marketing page's country-support line.

### Task 9: Fix stale US Social Security wage-base mismatch

**Problem:** `apps/web-next/src/lib/payroll-engine.ts` defines `US_SS_WAGE_BASE = 168_600_00` (2024 figure) for payroll withholding, while `packages/agentbook-jurisdictions/src/us/self-employment-tax.ts` uses `17610000` (correct 2025 figure) for self-employment tax — two calculations for the same real number disagree, a genuine money-correctness bug for high earners.

**Status:** Fix in progress in a separate session as of 2026-07-19.

**Definition of done:** Both files use the same, currently-correct wage-base figure (re-verify against the IRS-published number active at merge time, since this file can go stale again by the time this ships), with a regression test in whichever of `payroll-engine.test.ts` / `__tests__/lib/payroll-engine.test.ts` is canonical (confirm which — two test files appear to exist for this module) pinning the value so it can't silently drift again.

- [ ] Confirm the fix landed with a passing regression test, not just a hardcoded number swap.
- [ ] Spot-check one other stale-constant candidate while in this file: search `payroll-engine.ts` and `self-employment-tax.ts` for any other hardcoded-by-year figures that could have the same two-files-disagree problem (mileage rates, standard deduction, etc.) — not required to fix now, just worth a `grep` before closing this task so it isn't rediscovered piecemeal.

### Task 10: Clean up orphaned duplicate tax-package endpoint

**Problem:** `apps/web-next/src/app/api/v1/agentbook-core/tax-package/html/route.ts` appears to be an unreachable duplicate of the real, UI-linked export logic in `apps/web-next/src/lib/agentbook-tax-package.ts`, and still labels the Australian tax form "myTax individual tax return" — inaccurate terminology (the real reachable export correctly uses "ITR" labels).

**Status:** Investigation started in a separate session as of 2026-07-19 — confirming true reachability before deciding delete-vs-relabel.

**Definition of done:** Either the route and its test are deleted (confirmed unreferenced anywhere, including plugin frontends), or its AU label is corrected to match `agentbook-tax-package.ts`'s real "ITR" terminology if it turns out to still be used somewhere unexpected.

- [ ] Confirm the in-progress session's reachability finding and merge whichever fix it produced.

### Task 11: Fix mileage tier preview for mixed-unit tenants

**Problem:** `plugins/agentbook-expense/frontend/src/pages/Mileage.tsx`'s `ratePreview()` helper (added in PARITY-8) uses `summary.ytd.miles`, which sums distance across *all* logged units (mi and km) for the year, rather than the unit actually being previewed — a CA tenant who has logged mileage in both units in the same tax year could see the wrong CRA tier (72¢ vs 66¢) in the preview tooltip. Display-only; the real backend calculation at submission time is unaffected and correct.

**Status:** Fix in progress in a separate session as of 2026-07-19.

**Definition of done:** The preview's YTD sum is scoped to the same unit the backend uses for the real per-request calculation (mirroring whatever `ytdMilesOrKm` does server-side), with a test covering a mixed-unit tenant.

- [ ] Confirm the fix landed and covers the mixed-unit case with a real test, not just a visual sanity check.

### Task 12: French UI for Quebec — Phase 1 (bilingual foundation + tax-label accuracy + chat)

**Problem:** No competitor researched has strong bilingual (EN/FR) support for Quebec either, but AgentBook currently has none at all — a real, previously-untracked gap. Full application-wide translation is a large, separate effort; this task scopes a **Phase 1** that closes the highest-value, most Quebec-specific gaps without attempting to translate the entire product in one pass. Full i18n coverage beyond this phase is explicitly deferred to a later, separately-scoped Phase 2.

**Files:**
- Modify: `packages/database/prisma/schema.prisma` — `AbTenantConfig.locale String? @default("en")` (additive)
- Modify: `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx` — add a Language selector (English / Français) next to the existing Currency selector, gated to appear when jurisdiction === 'ca' (avoid cluttering the US/AU settings panel with a toggle that only matters for one region today)
- Create: `apps/web-next/src/lib/i18n/messages/en.json`, `apps/web-next/src/lib/i18n/messages/fr.json`
- Create: `apps/web-next/src/lib/i18n/index.ts` — a small, dependency-free `t(key, locale)` lookup helper rather than adopting a full framework like `next-intl` for Phase 1's deliberately narrow string set (avoids a large new dependency + App Router restructuring for what's initially a few dozen strings; revisit if Phase 2 needs full coverage)
- Modify: `packages/agentbook-jurisdictions/src/ca/tax-brackets.ts` (or wherever GST/HST/QST labels are rendered) — when `locale === 'fr' && province === 'QC'`, render `TPS`/`TVQ` instead of `GST`/`QST` (this was the single most-cited real pain point in the competitor research — QuickBooks Canada has documented bugs exactly here)
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts` — read `tenantConfig.locale`, inject a one-line instruction into the Gemini system prompt ("Respond in French.") when `locale === 'fr'`, so chat replies in French without needing every skill's response template translated by hand
- Modify: `apps/web-next/src/content/docs/regions/canada.mdx` — add a French translation, either as a sibling `canada.fr.mdx` or an inline toggle, matching whatever pattern the docs content loader (`apps/web-next/src/lib/docs/content.ts`) can support with the least structural change — check that file first before deciding the exact mechanism
- Create: `apps/web-next/src/lib/i18n/index.test.ts`

**Interfaces:**
- Produces: `t(key: string, locale: 'en'|'fr'): string`, `getTenantLocale(tenantId): Promise<'en'|'fr'>`
- Consumes: `AbTenantConfig.locale` (new field), existing jurisdiction/province resolution already used by the CA tax-bracket code

- [ ] **Step 1:** Add `locale` to `AbTenantConfig`, additive migration, default `'en'` for all existing rows.
- [ ] **Step 2:** Add the Language selector to Business Profile settings, wired to a `PATCH /tenant-config` call (extend the existing whitelist the same way `taxEntityType`/`currency` were added earlier this project).
- [ ] **Step 3:** Build the minimal `t()` helper + `en.json`/`fr.json` seeded with only the strings Steps 4–5 actually need — resist the urge to pre-populate hundreds of speculative keys; add keys as each surface is actually translated.
- [ ] **Step 4:** Wire `TPS`/`TVQ` label swap into the Quebec tax-estimate and invoice GST/QST display paths, with a test asserting a `locale:'fr', province:'QC'` tenant sees `TPS`/`TVQ` and every other locale/province combination is unchanged (regression-proof the existing English/other-province behavior explicitly, not just the new French path).
- [ ] **Step 5:** Wire the French system-prompt instruction into `agent-brain.ts`, gated on `tenantConfig.locale === 'fr'`, with a test asserting the instruction is present/absent correctly (mocking the Gemini call, not actually verifying French output — that's a manual verification step, since asserting on real LLM output text is inherently flaky).
- [ ] **Step 6:** Translate `regions/canada.mdx` to French, decide and document the URL/routing convention (e.g. `/docs/regions/canada?lang=fr` or a separate slug) so Phase 2 has a pattern to extend from.
- [ ] **Step 7:** Manual verification: switch a Quebec test tenant's locale to French in Settings, confirm the tax-estimate page shows TPS/TVQ, confirm a chat message gets a French reply, confirm the docs page's French version renders.
- [ ] **Step 8:** Commit as its own PR, explicitly scoped as "Phase 1" in the PR description so reviewers don't read it as claiming full bilingual coverage.

**Explicitly out of scope for Phase 1** (real, but deferred): translating the full web app UI chrome (buttons, nav, every page), translating every chat skill's response templates individually (Step 5's system-prompt approach is a deliberate shortcut, not a substitute for that deeper work if French UI becomes a bigger strategic priority later), French NETFILE/Revenu-Québec-specific terminology beyond the GST/QST label fix.

## Verification (final, after all 7 tasks)

- Full test suite (`apps/web-next`, `plugins/agentbook-expense/frontend`, `plugins/agentbook-core/backend`) — expect only the same pre-existing/unrelated failures already established as known-flaky in this project (dependency-audit CVEs, `DATABASE_URL`-unset shell-test gaps), zero new failures.
- `npx tsc --noEmit` clean on every touched file.
- Manual verification checklist from Task 7 Step 5, completed against a real Basiq sandbox key.
- Confirm the 3 AU-decline call sites (chat, personal web page, expense-plugin page) all now behave identically to their US/CA counterparts — no leftover special-casing anywhere (`grep -rn "isn't available for Australian" apps/ plugins/` should return zero results after Task 6/3).
- Deploy: PR-by-PR into `main` (one PR per task above, each independently mergeable and shippable — task order matters, Task 1 must land first since everything else depends on its schema/lib), local build + `vercel deploy --prebuilt --prod` per this project's established deploy convention, `BASIQ_API_KEY` set in production **before** Task 2's PR deploys (routes will 500 without it, same failure mode as a missing `PLAID_SECRET` would cause today).
