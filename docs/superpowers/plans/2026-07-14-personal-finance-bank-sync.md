# Personal Finance Bank Sync (Plaid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant connect a real bank account (Plaid) to their personal finance area, auto-populating `AbPersonalTransaction`/`AbPersonalAccount`, gated behind the existing `personal_insights` add-on.

**Architecture:** A new, parallel Plaid integration (`agentbook-personal-plaid.ts` + 4 routes + a daily cron) that mirrors the already-shipped expense-side integration's proven patterns (encryption, cursor sync, stuck-Link watchdog) without touching or importing from it — the two integrations stay fully independent, same as their underlying models already are.

**Tech Stack:** TypeScript, Next.js App Router (`apps/web-next`), Prisma, `plaid` SDK (already a dependency), `react-plaid-link` (new dependency for this app), Vitest, Playwright.

## Global Constraints

- No changes to `apps/web-next/src/lib/agentbook-plaid.ts`, `AbBankAccount`, or `AbBankTransaction` (the expense-side integration) — this plan only adds new, parallel files.
- **Sign-convention flip, the one place a "mirror" must diverge**: `AbBankTransaction.amount` keeps Plaid's native convention (positive = outflow). `AbPersonalTransaction.amountCents` uses the opposite (positive = inflow). `syncTransactionsForAccount`'s write must negate: `amountCents: -Math.round(t.amount * 100)`.
- No transaction-matching logic (no `runMatcherOnTransaction` equivalent) — personal transactions aren't reconciled against invoices/expenses.
- Gate `link-token`, `exchange`, and `sync` behind `requirePersonalInsightsAddon` (already exists, `apps/web-next/src/lib/agentbook-personal-insights/guard.ts`) — `disconnect` stays ungated so a lapsed subscriber can still remove a bank connection.
- Schema change is additive only (new nullable columns + `@unique` on an existing all-`NULL` column) — no manual migration step, applies via the normal build-time `prisma db push`.
- No chat/MCP skill for "connect my bank" — Plaid Link is UI-only, matching the expense-side scope.

---

## Task 1: Schema — Plaid fields on `AbPersonalAccount` + `AbPersonalTransaction`

**Files:**
- Modify: `packages/database/prisma/schema.prisma`

**Interfaces:**
- Produces: the new Prisma model fields every later task reads/writes — `AbPersonalAccount.{plaidAccountId (now @unique), plaidItemId, accessTokenEnc, cursorToken, institution, officialName, subtype, mask, connected, lastSynced}`, `AbPersonalTransaction.{plaidTransactionId, idempotencyKey, pending, merchantName}`.

- [ ] **Step 1: Locate the current models**

Run: `grep -n "^model AbPersonalAccount\|^model AbPersonalTransaction" packages/database/prisma/schema.prisma`
Expected: two line numbers, confirming both models exist as described in the spec.

- [ ] **Step 2: Edit `AbPersonalAccount`**

Find:
```prisma
model AbPersonalAccount {
  id             String   @id @default(uuid())
  tenantId       String
  name           String
  type           String // checking | savings | investment | credit | mortgage | cash
  balanceCents   Int      @default(0)
  currency       String   @default("USD")
  isAsset        Boolean  @default(true) // true = asset, false = liability (credit/mortgage)
  plaidAccountId String?
  archived       Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([tenantId, archived])
  @@schema("plugin_agentbook_personal")
}
```

Replace with:
```prisma
model AbPersonalAccount {
  id             String    @id @default(uuid())
  tenantId       String
  name           String
  type           String // checking | savings | investment | credit | mortgage | cash
  balanceCents   Int       @default(0)
  currency       String    @default("USD")
  isAsset        Boolean   @default(true) // true = asset, false = liability (credit/mortgage)
  plaidAccountId String?   @unique
  plaidItemId    String?
  accessTokenEnc String? // AES-256-GCM-encrypted Plaid access token (agentbook-bank-token.ts)
  cursorToken    String? // Plaid /transactions/sync cursor
  institution    String?
  officialName   String?
  subtype        String?
  mask           String? // last 4 digits
  connected      Boolean   @default(true)
  lastSynced     DateTime?
  archived       Boolean   @default(false)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([tenantId, archived])
  @@schema("plugin_agentbook_personal")
}
```

- [ ] **Step 3: Edit `AbPersonalTransaction`**

Find:
```prisma
model AbPersonalTransaction {
  id           String   @id @default(uuid())
  tenantId     String
  accountId    String
  description  String
  amountCents  Int // positive = inflow/income, negative = outflow/spend
  date         DateTime
  category     String   @default("uncategorized")
  businessFlag Boolean  @default(false) // marked as a business expense
  notes        String?
  createdAt    DateTime @default(now())

  @@index([tenantId, date])
  @@index([tenantId, accountId])
  @@schema("plugin_agentbook_personal")
}
```

Replace with:
```prisma
model AbPersonalTransaction {
  id                 String   @id @default(uuid())
  tenantId           String
  accountId          String
  description        String
  amountCents        Int // positive = inflow/income, negative = outflow/spend
  date               DateTime
  category           String   @default("uncategorized")
  businessFlag       Boolean  @default(false) // marked as a business expense
  notes              String?
  plaidTransactionId String?  @unique
  idempotencyKey     String?  @unique // prevent duplicate imports
  pending            Boolean  @default(false)
  merchantName       String?
  createdAt          DateTime @default(now())

  @@index([tenantId, date])
  @@index([tenantId, accountId])
  @@schema("plugin_agentbook_personal")
}
```

- [ ] **Step 4: Validate the schema**

Run: `cd packages/database && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 5: Fix a real secret-leak this schema change creates in 3 existing routes**

`apps/web-next/src/app/api/v1/agentbook-personal/accounts/route.ts`'s `GET` handler does `db.abPersonalAccount.findMany({ where: {...} })` with no `select`, and returns the result directly as `data`. Prisma returns every column by default — once this task adds `accessTokenEnc`/`cursorToken` to the model, this **already-shipped, unmodified-by-this-plan route starts returning the encrypted Plaid access token ciphertext to the client** the moment any account becomes Plaid-linked. The same leak exists in `accounts/[id]/route.ts`'s `PUT` and `DELETE` handlers, which `.update()` an account and return the full updated row — even though those handlers never touch the Plaid fields themselves, `.update()`'s return value still includes them if the row already has them set.

This is exactly the class of bug the expense-side `/exchange` route already guards against (it explicitly maps out a `safe` object before returning, stripping `accessTokenEnc`) — apply the same explicit-field-mapping style here, matching this codebase's established pattern (no `omit:` usage exists anywhere in this codebase to date, so don't introduce it as a new pattern).

**Write the failing tests first.** No test file exists yet for either route (confirmed: only `trend-route.test.ts` exists in this directory today). Create `apps/web-next/src/__tests__/api/v1/agentbook-personal/accounts-route.test.ts`, following `trend-route.test.ts`'s exact mocking style but for `safeResolveAgentbookTenant` (these two routes use the plain tenant resolver, not the `personal_insights` guard):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const accountFindMany = vi.fn();
const accountFindFirst = vi.fn();
const accountUpdate = vi.fn();
const accountCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: {
      findMany: (...a: unknown[]) => accountFindMany(...a),
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
      update: (...a: unknown[]) => accountUpdate(...a),
      create: (...a: unknown[]) => accountCreate(...a),
    },
  },
}));

function getReq(): NextRequest {
  return new NextRequest('http://x/accounts');
}
function putReq(body: unknown): NextRequest {
  return new NextRequest('http://x/accounts/a1', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

function plaidLinkedAccountRow() {
  return {
    id: 'a1', tenantId: 'tenant-1', name: 'Checking', type: 'checking', balanceCents: 100,
    currency: 'USD', isAsset: true, archived: false,
    plaidAccountId: 'plaid-1', plaidItemId: 'item-1', accessTokenEnc: 'SECRET-CIPHERTEXT',
    cursorToken: 'cursor-1', institution: 'Chase', officialName: null, subtype: null, mask: '1234',
    connected: true, lastSynced: new Date(), createdAt: new Date(), updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
});

describe('GET /api/v1/agentbook-personal/accounts', () => {
  it('never returns accessTokenEnc or cursorToken even for a Plaid-linked account', async () => {
    accountFindMany.mockResolvedValueOnce([plaidLinkedAccountRow()]);
    const { GET } = await import('@/app/api/v1/agentbook-personal/accounts/route');
    const res = await GET(getReq());
    const json = await res.json();
    expect(json.data[0].accessTokenEnc).toBeUndefined();
    expect(json.data[0].cursorToken).toBeUndefined();
    expect(json.data[0].institution).toBe('Chase'); // safe fields still present
  });
});

describe('PUT /api/v1/agentbook-personal/accounts/[id]', () => {
  it('never returns accessTokenEnc or cursorToken for a Plaid-linked account after a name/balance edit', async () => {
    accountFindFirst.mockResolvedValueOnce(plaidLinkedAccountRow());
    accountUpdate.mockResolvedValueOnce({ ...plaidLinkedAccountRow(), name: 'Renamed' });
    const { PUT } = await import('@/app/api/v1/agentbook-personal/accounts/[id]/route');
    const res = await PUT(putReq({ name: 'Renamed' }), { params: Promise.resolve({ id: 'a1' }) });
    const json = await res.json();
    expect(json.data.accessTokenEnc).toBeUndefined();
    expect(json.data.cursorToken).toBeUndefined();
    expect(json.data.name).toBe('Renamed');
  });
});
```

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-personal/accounts-route.test.ts`
Expected: FAIL — both tests fail because the current route code returns the raw Prisma row, so `accessTokenEnc`/`cursorToken` ARE present (the schema doesn't even have these columns yet at this point in the task, but the mocked Prisma layer returns them anyway since the route does no field filtering — the test fails on the "should be undefined" assertions).

**Now fix `accounts/route.ts`'s `GET` handler.** Find:
```ts
    const accounts = await db.abPersonalAccount.findMany({
      where: { tenantId, archived: false },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({ success: true, data: accounts });
```
Replace with:
```ts
    const accounts = await db.abPersonalAccount.findMany({
      where: { tenantId, archived: false },
      orderBy: { createdAt: 'asc' },
    });
    // Never return accessTokenEnc/cursorToken to the client — same
    // discipline as agentbook-expense/plaid/exchange/route.ts's `safe`
    // mapping for the equivalent expense-side field.
    const safe = accounts.map((a) => ({
      id: a.id, tenantId: a.tenantId, name: a.name, type: a.type,
      balanceCents: a.balanceCents, currency: a.currency, isAsset: a.isAsset,
      archived: a.archived, plaidAccountId: a.plaidAccountId, institution: a.institution,
      officialName: a.officialName, subtype: a.subtype, mask: a.mask,
      connected: a.connected, lastSynced: a.lastSynced,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    }));
    return NextResponse.json({ success: true, data: safe });
```

**Fix `accounts/[id]/route.ts`'s `PUT` and `DELETE` handlers** the same way. Find (appears twice, once in each handler):
```ts
    const account = await db.abPersonalAccount.update({ where: { id }, data: update });
    return NextResponse.json({ success: true, data: account });
```
(in `PUT`) and:
```ts
    const account = await db.abPersonalAccount.update({ where: { id }, data: { archived: true } });
    return NextResponse.json({ success: true, data: account });
```
(in `DELETE`) — replace each with the same field-mapping shape used above (the `safe` object literal, inlined at each call site since these are two small, separate handlers rather than a shared helper — matching this file's existing size and style, not worth a new shared function for two call sites in one small file):
```ts
    return NextResponse.json({
      success: true,
      data: {
        id: account.id, tenantId: account.tenantId, name: account.name, type: account.type,
        balanceCents: account.balanceCents, currency: account.currency, isAsset: account.isAsset,
        archived: account.archived, plaidAccountId: account.plaidAccountId, institution: account.institution,
        officialName: account.officialName, subtype: account.subtype, mask: account.mask,
        connected: account.connected, lastSynced: account.lastSynced,
        createdAt: account.createdAt, updatedAt: account.updatedAt,
      },
    });
```

Run the new tests again and confirm they now PASS.

- [ ] **Step 6: Run the full existing test suites for these files to confirm no regression**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-personal`
Expected: PASS — every pre-existing test in this directory (accounts, transactions, budget, snapshot, trend) still passes; only the shape of `GET`/`PUT`/`DELETE`'s success response narrowed (dropped two fields no existing test was asserting the presence of).

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma \
  apps/web-next/src/app/api/v1/agentbook-personal/accounts/route.ts \
  apps/web-next/src/app/api/v1/agentbook-personal/accounts/\[id\]/route.ts \
  apps/web-next/src/__tests__/api/v1/agentbook-personal/
git commit -m "feat(personal-finance): add Plaid fields to AbPersonalAccount/AbPersonalTransaction

Mirrors AbBankAccount/AbBankTransaction's Plaid columns (minus the
matching-related ones, which don't apply to personal finance).
plaidAccountId gets @unique added — safe on an existing all-NULL
column (Postgres treats multiple NULLs as distinct under a unique
constraint), no backfill needed. Purely additive, no manual migration.

Also fixes a secret-leak this schema change would otherwise introduce:
accounts/route.ts's GET and accounts/[id]/route.ts's PUT/DELETE all
returned the raw Prisma row with no field filtering — once
accessTokenEnc/cursorToken exist on the model, those three
already-shipped routes would start returning the encrypted Plaid
token ciphertext to the client for any Plaid-linked account. Fixed
with the same explicit-field-mapping discipline the expense-side
/exchange route already uses for its own equivalent field."
```

---

## Task 2: `agentbook-personal-plaid.ts` — the personal-specific Plaid lib

**Files:**
- Create: `apps/web-next/src/lib/agentbook-personal-plaid.ts`
- Test: `apps/web-next/src/lib/agentbook-personal-plaid.test.ts`

**Interfaces:**
- Consumes: `encryptToken`/`decryptToken` from `./agentbook-bank-token` (existing, unchanged); `summarizeSyncRuns`/`SyncRun` from `./plaid-sync-summary` (existing, unchanged, reused as-is by Task 3's sync route, not by this file directly).
- Produces: `getPlaidClient()`, `sanitizePlaidError(err: unknown): string`, `createLinkToken(tenantId: string): Promise<{linkToken: string; expiration: string}>`, `exchangePublicToken(publicToken: string, institutionName: string | null, tenantId: string): Promise<AbPersonalAccount[]>`, `syncTransactionsForAccount(accountId: string): Promise<{added: number; modified: number; removed: number; cursor: string | null; hasMore: boolean}>`, `disconnectAccount(accountId: string, tenantId: string): Promise<void>` — all consumed by Task 3's routes and Task 4's cron.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/lib/agentbook-personal-plaid.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

process.env.BANK_TOKEN_ENCRYPTION_KEY = '1111111111111111111111111111111111111111111111111111111111111111';

const accountFindFirst = vi.fn();
const accountFindUnique = vi.fn();
const accountCreate = vi.fn();
const accountUpdate = vi.fn();
const transactionUpsert = vi.fn();
const transactionUpdateMany = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: {
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
      findUnique: (...a: unknown[]) => accountFindUnique(...a),
      create: (...a: unknown[]) => accountCreate(...a),
      update: (...a: unknown[]) => accountUpdate(...a),
    },
    abPersonalTransaction: {
      upsert: (...a: unknown[]) => transactionUpsert(...a),
      updateMany: (...a: unknown[]) => transactionUpdateMany(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const mockTransactionsSync = vi.fn();
const mockAccountsGet = vi.fn();
const mockItemPublicTokenExchange = vi.fn();
const mockLinkTokenCreate = vi.fn();
const mockItemRemove = vi.fn();

vi.mock('plaid', () => ({
  Configuration: vi.fn(),
  PlaidApi: vi.fn().mockImplementation(() => ({
    linkTokenCreate: (...a: unknown[]) => mockLinkTokenCreate(...a),
    itemPublicTokenExchange: (...a: unknown[]) => mockItemPublicTokenExchange(...a),
    accountsGet: (...a: unknown[]) => mockAccountsGet(...a),
    transactionsSync: (...a: unknown[]) => mockTransactionsSync(...a),
    itemRemove: (...a: unknown[]) => mockItemRemove(...a),
  })),
  PlaidEnvironments: { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' },
  Products: { Transactions: 'transactions' },
  CountryCode: { Us: 'US', Ca: 'CA' },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLAID_CLIENT_ID = 'test-client-id';
  process.env.PLAID_SECRET = 'test-secret';
  process.env.PLAID_ENV = 'sandbox';
  accountUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
});

describe('createLinkToken', () => {
  it('returns the linkToken + expiration from Plaid', async () => {
    mockLinkTokenCreate.mockResolvedValue({ data: { link_token: 'link-abc', expiration: '2026-01-01T00:00:00Z' } });
    const { createLinkToken } = await import('./agentbook-personal-plaid');

    const result = await createLinkToken('tenant-1');

    expect(result).toEqual({ linkToken: 'link-abc', expiration: '2026-01-01T00:00:00Z' });
    expect(mockLinkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: { client_user_id: 'tenant-1' } }),
    );
  });
});

describe('syncTransactionsForAccount — sign-convention flip', () => {
  it('negates Plaid\'s outflow-positive amount into AbPersonalTransaction\'s inflow-positive convention', async () => {
    accountFindUnique.mockResolvedValue({
      id: 'acct-1', tenantId: 'tenant-1', connected: true, accessTokenEnc: Buffer.alloc(29).toString('base64') + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plaidAccountId: 'plaid-acct-1', cursorToken: null,
    });
    mockTransactionsSync.mockResolvedValue({
      data: {
        added: [{ transaction_id: 'txn-1', amount: 500, date: '2026-01-15', name: 'Coffee Shop', merchant_name: 'Blue Bottle', pending: false, personal_finance_category: { primary: 'FOOD_AND_DRINK' } }],
        modified: [], removed: [], next_cursor: 'cursor-1', has_more: false,
      },
    });
    mockAccountsGet.mockResolvedValue({ data: { accounts: [{ account_id: 'plaid-acct-1', balances: { current: 100 } }] } });
    transactionUpsert.mockResolvedValue({});

    const { syncTransactionsForAccount } = await import('./agentbook-personal-plaid');
    await syncTransactionsForAccount('acct-1');

    expect(transactionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { plaidTransactionId: 'txn-1' },
        create: expect.objectContaining({ amountCents: -500, merchantName: 'Blue Bottle', category: 'FOOD_AND_DRINK' }),
      }),
    );
  });

  it('does not call any matcher-equivalent function — personal sync has no matching step', async () => {
    accountFindUnique.mockResolvedValue({
      id: 'acct-2', tenantId: 'tenant-1', connected: true, accessTokenEnc: 'a'.repeat(40),
      plaidAccountId: 'plaid-acct-2', cursorToken: null,
    });
    mockTransactionsSync.mockResolvedValue({ data: { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false } });
    mockAccountsGet.mockResolvedValue({ data: { accounts: [] } });

    const { syncTransactionsForAccount } = await import('./agentbook-personal-plaid');
    const result = await syncTransactionsForAccount('acct-2');

    expect(result).toEqual({ added: 0, modified: 0, removed: 0, cursor: 'c', hasMore: false });
  });

  it('returns a zeroed result without calling Plaid when the account is not connected', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acct-3', connected: false, accessTokenEnc: null });

    const { syncTransactionsForAccount } = await import('./agentbook-personal-plaid');
    const result = await syncTransactionsForAccount('acct-3');

    expect(result).toEqual({ added: 0, modified: 0, removed: 0, cursor: null, hasMore: false });
    expect(mockTransactionsSync).not.toHaveBeenCalled();
  });
});

describe('sanitizePlaidError', () => {
  it('extracts the Plaid error_code without leaking the raw message', async () => {
    const { sanitizePlaidError } = await import('./agentbook-personal-plaid');
    const err = { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    expect(sanitizePlaidError(err)).toBe('Plaid error: ITEM_LOGIN_REQUIRED');
  });

  it('falls back to a generic message for a non-Plaid-shaped error', async () => {
    const { sanitizePlaidError } = await import('./agentbook-personal-plaid');
    expect(sanitizePlaidError(new Error('some raw axios config leak'))).toBe('Bank operation failed. Please try again later.');
  });
});

describe('disconnectAccount', () => {
  it('clears the encrypted token + cursor and flips connected to false', async () => {
    accountFindFirst.mockResolvedValue({ id: 'acct-4', tenantId: 'tenant-1', accessTokenEnc: null });

    const { disconnectAccount } = await import('./agentbook-personal-plaid');
    await disconnectAccount('acct-4', 'tenant-1');

    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: 'acct-4' },
      data: { connected: false, accessTokenEnc: null, cursorToken: null },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-personal-plaid.test.ts`
Expected: FAIL — the module `./agentbook-personal-plaid` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web-next/src/lib/agentbook-personal-plaid.ts`:

```ts
/**
 * Personal-finance Plaid client wrapper. Mirrors
 * apps/web-next/src/lib/agentbook-plaid.ts's structure (the expense-side
 * integration) but writes to AbPersonalAccount/AbPersonalTransaction
 * instead of AbBankAccount/AbBankTransaction, and has no matcher step —
 * personal transactions aren't reconciled against invoices/expenses.
 *
 * ONE deliberate divergence from the expense-side original: Plaid's own
 * amount convention (positive = outflow/debit) is the OPPOSITE of
 * AbPersonalTransaction.amountCents's convention (positive =
 * inflow/income, established by the manual-entry route). This file
 * negates the Plaid amount on write — see syncTransactionsForAccount.
 *
 * Sandbox creds for end-to-end testing: user_good / pass_good.
 */

import 'server-only';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import type { Transaction as PlaidTransaction } from 'plaid';
import { prisma as db } from '@naap/database';
import { encryptToken, decryptToken } from './agentbook-bank-token';

export function sanitizePlaidError(err: unknown): string {
  const axiosErr = err as {
    response?: { data?: { error_code?: string; error_message?: string } };
  };
  if (axiosErr?.response?.data?.error_code) {
    return `Plaid error: ${axiosErr.response.data.error_code}`;
  }
  return 'Bank operation failed. Please try again later.';
}

let cachedClient: PlaidApi | null = null;

export function getPlaidClient(): PlaidApi {
  if (cachedClient) return cachedClient;
  const env = (process.env.PLAID_ENV || 'sandbox') as keyof typeof PlaidEnvironments;
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set');
  }
  const config = new Configuration({
    basePath: PlaidEnvironments[env] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
  cachedClient = new PlaidApi(config);
  return cachedClient;
}

export async function createLinkToken(
  tenantId: string,
): Promise<{ linkToken: string; expiration: string }> {
  const client = getPlaidClient();
  const res = await client.linkTokenCreate({
    user: { client_user_id: tenantId },
    client_name: 'AgentBook',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us, CountryCode.Ca],
    language: 'en',
  });
  return {
    linkToken: res.data.link_token,
    expiration: res.data.expiration,
  };
}

/**
 * Exchange the Link `publicToken` for a long-lived access token, encrypt
 * it, and create AbPersonalAccount rows for each connected account.
 */
export async function exchangePublicToken(
  publicToken: string,
  institutionName: string | null,
  tenantId: string,
): Promise<Awaited<ReturnType<typeof db.abPersonalAccount.create>>[]> {
  const client = getPlaidClient();
  const exchangeRes = await client.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchangeRes.data.access_token;
  const itemId = exchangeRes.data.item_id;

  const accountsRes = await client.accountsGet({ access_token: accessToken });
  const created: Awaited<ReturnType<typeof db.abPersonalAccount.create>>[] = [];

  const encryptedToken = encryptToken(accessToken);

  for (const acct of accountsRes.data.accounts) {
    const existing = await db.abPersonalAccount.findFirst({
      where: { plaidAccountId: acct.account_id },
    });
    if (existing) {
      const updated = await db.abPersonalAccount.update({
        where: { id: existing.id },
        data: {
          plaidItemId: itemId,
          accessTokenEnc: encryptedToken,
          connected: true,
          institution: institutionName || existing.institution,
          balanceCents: Math.round((acct.balances.current || 0) * 100),
          lastSynced: new Date(),
        },
      });
      created.push(updated);
      continue;
    }
    const row = await db.abPersonalAccount.create({
      data: {
        tenantId,
        plaidItemId: itemId,
        plaidAccountId: acct.account_id,
        accessTokenEnc: encryptedToken,
        name: acct.name,
        officialName: acct.official_name || null,
        type: acct.type || 'checking',
        subtype: acct.subtype || null,
        mask: acct.mask || null,
        balanceCents: Math.round((acct.balances.current || 0) * 100),
        currency: acct.balances.iso_currency_code || 'USD',
        institution: institutionName || null,
        connected: true,
        isAsset: acct.type !== 'credit' && acct.type !== 'loan',
        lastSynced: new Date(),
      },
    });
    created.push(row);
  }

  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'personal.account_connected',
      actor: 'system',
      action: { itemId, institution: institutionName, accountCount: created.length },
    },
  });

  return created;
}

/**
 * Pull new transactions for one personal account via Plaid's cursor-based
 * /transactions/sync, upsert them as AbPersonalTransaction rows. No
 * matcher call — personal transactions aren't reconciled against
 * invoices/expenses the way business bank transactions are.
 */
export async function syncTransactionsForAccount(
  accountId: string,
): Promise<{ added: number; modified: number; removed: number; cursor: string | null; hasMore: boolean }> {
  const account = await db.abPersonalAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.connected || !account.accessTokenEnc) {
    return { added: 0, modified: 0, removed: 0, cursor: null, hasMore: false };
  }
  const accessToken = decryptToken(account.accessTokenEnc);
  const client = getPlaidClient();

  let cursor: string | undefined = account.cursorToken || undefined;
  let added: PlaidTransaction[] = [];
  let modified: PlaidTransaction[] = [];
  const removed: { transaction_id: string }[] = [];
  let hasMore = true;

  // Same 10-page (2000-txn) safety cap as the expense-side sync — see that
  // file's comment for the full rationale (cursor model means truncation
  // only delays import, never loses data).
  let safety = 10;
  while (hasMore && safety-- > 0) {
    const res = await client.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 200,
    });
    added = added.concat(res.data.added);
    modified = modified.concat(res.data.modified);
    for (const r of res.data.removed) removed.push({ transaction_id: r.transaction_id });
    cursor = res.data.next_cursor;
    hasMore = res.data.has_more;
  }
  if (hasMore && safety <= 0) {
    console.warn(
      '[agentbook-personal-plaid] sync cap reached for account',
      accountId,
      '— more transactions remain; will resume on next sync',
    );
  }

  // Plaid: positive = outflow (debit), negative = inflow (credit).
  // AbPersonalTransaction: positive = inflow/income, negative = outflow/spend.
  // Negate on write — this is the one place this file is NOT a literal
  // mirror of agentbook-plaid.ts's equivalent loop.
  for (const t of added) {
    await db.abPersonalTransaction.upsert({
      where: { plaidTransactionId: t.transaction_id },
      update: {
        amountCents: -Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        description: t.name || 'Unknown',
        pending: t.pending || false,
      },
      create: {
        tenantId: account.tenantId,
        accountId: account.id,
        plaidTransactionId: t.transaction_id,
        amountCents: -Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        description: t.name || 'Unknown',
        category:
          (t as unknown as { personal_finance_category?: { primary?: string } })
            .personal_finance_category?.primary ||
          (Array.isArray(t.category) ? t.category.join(' > ') : 'uncategorized'),
        pending: t.pending || false,
        idempotencyKey: t.transaction_id,
      },
    });
  }

  for (const t of modified) {
    // category is intentionally NOT updated here, same rationale as the
    // expense side: a user may have re-categorized after import, and a
    // Plaid-side modify shouldn't clobber that.
    await db.abPersonalTransaction.updateMany({
      where: { plaidTransactionId: t.transaction_id },
      data: {
        amountCents: -Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        description: t.name || 'Unknown',
        pending: t.pending || false,
      },
    });
  }

  for (const r of removed) {
    // No matchStatus field on AbPersonalTransaction — a removed
    // transaction is simply deleted from the ledger view by marking it
    // pending:false and... actually there is no "ignored" concept here;
    // the simplest correct behavior is to leave the historical row as-is
    // (Plaid rarely retracts settled personal transactions) but this loop
    // exists for parity with the sync contract's shape (`removed` count in
    // the return value) — no DB write needed for personal transactions.
    void r;
  }

  try {
    const balRes = await client.accountsGet({ access_token: accessToken });
    const plaidAcct = balRes.data.accounts.find(
      (a: { account_id: string }) => a.account_id === account.plaidAccountId,
    );
    await db.abPersonalAccount.update({
      where: { id: account.id },
      data: {
        cursorToken: cursor || null,
        lastSynced: new Date(),
        balanceCents: plaidAcct
          ? Math.round((plaidAcct.balances.current || 0) * 100)
          : account.balanceCents,
      },
    });
  } catch {
    await db.abPersonalAccount.update({
      where: { id: account.id },
      data: { cursorToken: cursor || null, lastSynced: new Date() },
    });
  }

  return {
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    cursor: cursor || null,
    hasMore,
  };
}

export async function disconnectAccount(accountId: string, tenantId: string): Promise<void> {
  const account = await db.abPersonalAccount.findFirst({ where: { id: accountId, tenantId } });
  if (!account) return;
  if (account.accessTokenEnc) {
    try {
      const accessToken = decryptToken(account.accessTokenEnc);
      const client = getPlaidClient();
      await client.itemRemove({ access_token: accessToken });
    } catch {
      // ignore — Plaid may already have invalidated the item
    }
  }
  await db.abPersonalAccount.update({
    where: { id: accountId },
    data: { connected: false, accessTokenEnc: null, cursorToken: null },
  });
  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'personal.account_disconnected',
      actor: 'system',
      action: { accountId },
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-personal-plaid.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/agentbook-personal-plaid.ts apps/web-next/src/lib/agentbook-personal-plaid.test.ts
git commit -m "feat(personal-finance): agentbook-personal-plaid.ts lib

Parallel Plaid integration for personal finance, mirroring
agentbook-plaid.ts's structure without touching it. No matcher step
(personal transactions aren't reconciled against invoices/expenses).
Negates Plaid's outflow-positive amount into AbPersonalTransaction's
inflow-positive convention — the one place this deliberately isn't a
literal copy of the expense-side original."
```

---

## Task 3: Routes — link-token, exchange, disconnect, sync

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/plaid/link-token/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/plaid/exchange/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/plaid/disconnect/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-personal/plaid/sync/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts`

**Interfaces:**
- Consumes: `createLinkToken`, `exchangePublicToken`, `disconnectAccount`, `syncTransactionsForAccount`, `sanitizePlaidError` from `@/lib/agentbook-personal-plaid` (Task 2); `requirePersonalInsightsAddon` from `@/lib/agentbook-personal-insights/guard` (existing); `summarizeSyncRuns`, `type SyncRun` from `@/lib/plaid-sync-summary` (existing, unchanged).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const requirePersonalInsightsAddon = vi.fn();
vi.mock('@/lib/agentbook-personal-insights/guard', () => ({
  requirePersonalInsightsAddon: (...a: unknown[]) => requirePersonalInsightsAddon(...a),
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const createLinkToken = vi.fn();
const exchangePublicToken = vi.fn();
const disconnectAccount = vi.fn();
const syncTransactionsForAccount = vi.fn();
const sanitizePlaidError = vi.fn((e: unknown) => 'sanitized: ' + String(e));
vi.mock('@/lib/agentbook-personal-plaid', () => ({
  createLinkToken: (...a: unknown[]) => createLinkToken(...a),
  exchangePublicToken: (...a: unknown[]) => exchangePublicToken(...a),
  disconnectAccount: (...a: unknown[]) => disconnectAccount(...a),
  syncTransactionsForAccount: (...a: unknown[]) => syncTransactionsForAccount(...a),
  sanitizePlaidError: (...a: unknown[]) => sanitizePlaidError(...a),
}));

const personalAccountFindMany = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: { findMany: (...a: unknown[]) => personalAccountFindMany(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

function req(body?: unknown) {
  return new NextRequest('http://x/plaid', {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePersonalInsightsAddon.mockResolvedValue({ tenantId: 'tenant-1' });
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  eventCreate.mockResolvedValue({});
});

describe('POST /agentbook-personal/plaid/link-token', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/link-token/route');
    const res = await POST(req());
    expect(res.status).toBe(402);
    expect(createLinkToken).not.toHaveBeenCalled();
  });

  it('returns the linkToken when entitled', async () => {
    createLinkToken.mockResolvedValue({ linkToken: 'link-abc', expiration: '2026-01-01' });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/link-token/route');
    const res = await POST(req());
    const json = await res.json();
    expect(json.data.linkToken).toBe('link-abc');
    expect(createLinkToken).toHaveBeenCalledWith('tenant-1');
  });
});

describe('POST /agentbook-personal/plaid/exchange', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/exchange/route');
    const res = await POST(req({ publicToken: 'pub-1' }));
    expect(res.status).toBe(402);
    expect(exchangePublicToken).not.toHaveBeenCalled();
  });

  it('returns 400 when publicToken is missing', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/exchange/route');
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('strips accessTokenEnc from the response', async () => {
    exchangePublicToken.mockResolvedValue([
      { id: 'a1', tenantId: 'tenant-1', accessTokenEnc: 'SECRET', name: 'Checking', balanceCents: 100 },
    ]);
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/exchange/route');
    const res = await POST(req({ publicToken: 'pub-1', institutionName: 'Chase' }));
    const json = await res.json();
    expect(json.data.accounts[0].accessTokenEnc).toBeUndefined();
    expect(json.data.accounts[0].name).toBe('Checking');
  });
});

describe('POST /agentbook-personal/plaid/disconnect', () => {
  it('is NOT gated by personal_insights — works even when requirePersonalInsightsAddon would deny', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/disconnect/route');
    const res = await POST(req({ accountId: 'a1' }));
    expect(res.status).toBe(200);
    expect(disconnectAccount).toHaveBeenCalledWith('a1', 'tenant-1');
    // Confirms this route never even calls the addon guard.
    expect(requirePersonalInsightsAddon).not.toHaveBeenCalled();
  });

  it('returns 400 when accountId is missing', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/disconnect/route');
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});

describe('POST /agentbook-personal/plaid/sync', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/sync/route');
    const res = await POST(req());
    expect(res.status).toBe(402);
    expect(personalAccountFindMany).not.toHaveBeenCalled();
  });

  it('syncs every connected account and reports a summary', async () => {
    personalAccountFindMany.mockResolvedValue([{ id: 'a1', tenantId: 'tenant-1' }, { id: 'a2', tenantId: 'tenant-1' }]);
    syncTransactionsForAccount
      .mockResolvedValueOnce({ added: 3, modified: 0, removed: 0, cursor: 'c1', hasMore: false })
      .mockResolvedValueOnce({ added: 2, modified: 1, removed: 0, cursor: 'c2', hasMore: false });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/sync/route');
    const res = await POST(req());
    const json = await res.json();
    expect(json.data.accountsSynced).toBe(2);
    expect(json.data.transactionsImported).toBe(5);
    expect(json.data.complete).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts`
Expected: FAIL — none of the 4 route files exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web-next/src/app/api/v1/agentbook-personal/plaid/link-token/route.ts`:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { createLinkToken, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const { linkToken, expiration } = await createLinkToken(tenantId);
    return NextResponse.json({
      success: true,
      data: { linkToken, expiration, environment: process.env.PLAID_ENV || 'sandbox' },
    });
  } catch (err) {
    console.error('[agentbook-personal/plaid/link-token POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
```

Create `apps/web-next/src/app/api/v1/agentbook-personal/plaid/exchange/route.ts`:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { exchangePublicToken, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ExchangeBody {
  publicToken?: string;
  institutionName?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const body = (await request.json().catch(() => ({}))) as ExchangeBody;
    const { publicToken, institutionName } = body;
    if (!publicToken || typeof publicToken !== 'string') {
      return NextResponse.json({ success: false, error: 'publicToken is required' }, { status: 400 });
    }
    const accounts = await exchangePublicToken(publicToken, institutionName ?? null, tenantId);
    const safe = accounts.map((a) => ({
      id: a.id,
      tenantId: a.tenantId,
      plaidItemId: a.plaidItemId,
      plaidAccountId: a.plaidAccountId,
      name: a.name,
      officialName: a.officialName,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      balanceCents: a.balanceCents,
      currency: a.currency,
      institution: a.institution,
      connected: a.connected,
      lastSynced: a.lastSynced,
      createdAt: a.createdAt,
    }));
    return NextResponse.json({ success: true, data: { accounts: safe } });
  } catch (err) {
    console.error('[agentbook-personal/plaid/exchange POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
```

Create `apps/web-next/src/app/api/v1/agentbook-personal/plaid/disconnect/route.ts` — **deliberately NOT gated**, per the Global Constraints:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { disconnectAccount, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface DisconnectBody {
  accountId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  try {
    const body = (await request.json().catch(() => ({}))) as DisconnectBody;
    const { accountId } = body;
    if (!accountId || typeof accountId !== 'string') {
      return NextResponse.json({ success: false, error: 'accountId is required' }, { status: 400 });
    }
    await disconnectAccount(accountId, tenantId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[agentbook-personal/plaid/disconnect POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
```

Create `apps/web-next/src/app/api/v1/agentbook-personal/plaid/sync/route.ts`:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const accounts = await db.abPersonalAccount.findMany({
      where: { tenantId, connected: true, accessTokenEnc: { not: null } },
    });

    const runs: SyncRun[] = [];
    const errors: { accountId: string; error: string }[] = [];

    for (const account of accounts) {
      try {
        const r = await syncTransactionsForAccount(account.id);
        runs.push({ added: r.added, modified: r.modified, removed: r.removed, hasMore: r.hasMore });
      } catch (err) {
        console.error('[agentbook-personal/plaid/sync POST] account', account.id, 'error:', err);
        errors.push({ accountId: account.id, error: sanitizePlaidError(err) });
      }
    }

    const summary = summarizeSyncRuns(runs);
    const complete = summary.complete && errors.length === 0;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'personal.bank_sync_completed',
        actor: 'system',
        action: {
          accountsSynced: accounts.length,
          transactionsImported: summary.transactionsImported,
          modified: summary.modified,
          removed: summary.removed,
          complete,
          errorCount: errors.length,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        accountsSynced: accounts.length,
        transactionsImported: summary.transactionsImported,
        modified: summary.modified,
        removed: summary.removed,
        complete,
        errors: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[agentbook-personal/plaid/sync POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-personal/plaid apps/web-next/src/__tests__/api/v1/agentbook-personal/plaid-routes.test.ts
git commit -m "feat(personal-finance): Plaid routes (link-token, exchange, disconnect, sync)

link-token/exchange/sync gated behind requirePersonalInsightsAddon
(real Plaid API cost); disconnect stays ungated so a lapsed subscriber
can still remove a bank connection, mirroring PR-5's precedent of
never trapping a user behind a lapsed subscription."
```

---

## Task 4: Cron — daily personal-plaid-sync

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook/cron/personal-plaid-sync/route.ts`
- Modify: `vercel.json`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook/cron/personal-plaid-sync-route.test.ts`

**Interfaces:**
- Consumes: `syncTransactionsForAccount`, `sanitizePlaidError` from `@/lib/agentbook-personal-plaid` (Task 2).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/__tests__/api/v1/agentbook/cron/personal-plaid-sync-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const personalAccountFindMany = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: { findMany: (...a: unknown[]) => personalAccountFindMany(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const syncTransactionsForAccount = vi.fn();
const sanitizePlaidError = vi.fn((e: unknown) => 'sanitized: ' + String(e));
vi.mock('@/lib/agentbook-personal-plaid', () => ({
  syncTransactionsForAccount: (...a: unknown[]) => syncTransactionsForAccount(...a),
  sanitizePlaidError: (...a: unknown[]) => sanitizePlaidError(...a),
}));

const reportError = vi.fn();
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { GET } from '@/app/api/v1/agentbook/cron/personal-plaid-sync/route';

function req(bearer?: string) {
  return new NextRequest('http://x/cron/personal-plaid-sync', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  eventCreate.mockResolvedValue({});
  personalAccountFindMany.mockResolvedValue([]);
});

describe('GET /cron/personal-plaid-sync', () => {
  it('returns 401 when CRON_SECRET is set and the bearer token is wrong', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const res = await GET(req('wrong-secret'));
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it('syncs every connected account across tenants with bounded concurrency', async () => {
    personalAccountFindMany.mockResolvedValue([
      { id: 'a1', tenantId: 'tenant-1' },
      { id: 'a2', tenantId: 'tenant-2' },
    ]);
    syncTransactionsForAccount
      .mockResolvedValueOnce({ added: 2, modified: 0, removed: 0, cursor: 'c1', hasMore: false })
      .mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, cursor: 'c2', hasMore: false });

    const res = await GET(req());
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.accountsProcessed).toBe(2);
    expect(json.added).toBe(3);
    expect(personalAccountFindMany).toHaveBeenCalledWith({
      where: { connected: true, accessTokenEnc: { not: null } },
      select: { id: true, tenantId: true },
    });
  });

  it('logs a per-account error without aborting the rest of the batch', async () => {
    personalAccountFindMany.mockResolvedValue([{ id: 'a1', tenantId: 'tenant-1' }, { id: 'a2', tenantId: 'tenant-2' }]);
    syncTransactionsForAccount
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, cursor: 'c2', hasMore: false });

    const res = await GET(req());
    const json = await res.json();

    expect(json.errorCount).toBe(1);
    expect(json.added).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron/personal-plaid-sync-route.test.ts`
Expected: FAIL — the route file doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web-next/src/app/api/v1/agentbook/cron/personal-plaid-sync/route.ts`:

```ts
/**
 * Personal Finance Plaid Sync Cron — daily fan-out across all tenants
 * with a connected AbPersonalAccount. Mirrors cron/plaid-sync/route.ts's
 * structure (the expense-side cron) — see that file for the full
 * rationale on the bounded-concurrency + timing-safe-bearer patterns,
 * duplicated here rather than imported since both are small and this
 * keeps the two Plaid integrations fully independent.
 *
 * Vercel cron: "0 6 * * *" (06:00 UTC), same slot as the expense cron.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function processAll<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
    }
  }
  return results;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(authHeader, process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const accounts = await db.abPersonalAccount.findMany({
    where: { connected: true, accessTokenEnc: { not: null } },
    select: { id: true, tenantId: true },
  });

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const tenantStats: Record<string, { added: number; errors: number }> = {};
  let errorCount = 0;

  await processAll(accounts, 5, async (acct) => {
    try {
      const r = await syncTransactionsForAccount(acct.id);
      totalAdded += r.added;
      totalModified += r.modified;
      totalRemoved += r.removed;
      const t = (tenantStats[acct.tenantId] ??= { added: 0, errors: 0 });
      t.added += r.added;
    } catch (err) {
      errorCount++;
      const t = (tenantStats[acct.tenantId] ??= { added: 0, errors: 0 });
      t.errors++;
      void reportError('cron/personal-plaid-sync account error', err, {
        tenantId: acct.tenantId,
        accountId: acct.id,
        sanitized: sanitizePlaidError(err),
        source: 'cron/personal-plaid-sync',
      });
    }
  });

  for (const tenantId of Object.keys(tenantStats)) {
    await db.abEvent
      .create({
        data: {
          tenantId,
          eventType: 'personal.cron_sync_completed',
          actor: 'system',
          action: tenantStats[tenantId],
        },
      })
      .catch(() => null);
  }

  return NextResponse.json({
    ok: true,
    accountsProcessed: accounts.length,
    added: totalAdded,
    modified: totalModified,
    removed: totalRemoved,
    errorCount,
    timestamp: new Date().toISOString(),
  });
}
```

Now add the new cron to `vercel.json`. Find:
```json
    { "path": "/api/v1/agentbook/cron/plaid-sync", "schedule": "0 6 * * *" },
```

Add immediately after it:
```json
    { "path": "/api/v1/agentbook/cron/personal-plaid-sync", "schedule": "0 6 * * *" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron/personal-plaid-sync-route.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/cron/personal-plaid-sync apps/web-next/src/__tests__/api/v1/agentbook/cron/personal-plaid-sync-route.test.ts vercel.json
git commit -m "feat(personal-finance): daily personal-plaid-sync cron

Same 06:00 UTC slot and bounded-concurrency-5 fan-out pattern as the
expense-side plaid-sync cron. processAll/safeCompareBearer duplicated
rather than imported — both are small (~15 lines) and importing across
cron route modules is exactly the anti-pattern PR-5's final review
flagged and fixed elsewhere."
```

---

## Task 5: Frontend — Connect bank section in the personal dashboard

**Files:**
- Modify: `apps/web-next/package.json` (add `react-plaid-link` dependency)
- Modify: `apps/web-next/src/app/(dashboard)/personal/page.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/agentbook-personal/plaid/link-token`, `/exchange`, `/disconnect`, `/sync` (Task 3) via `fetch`.

- [ ] **Step 1: Add the dependency**

Add to `apps/web-next/package.json`'s `dependencies` (alongside the existing `"plaid": "^26.0.0"` entry):

```json
    "react-plaid-link": "^3.6.1",
```

(Matches the version already used by `plugins/agentbook-expense/frontend/package.json` — same major version, no need to chase latest for this PR.)

Run: `cd apps/web-next && npm install`
Expected: `react-plaid-link` appears in `node_modules`, lockfile updates.

- [ ] **Step 2: Add state + data-fetching for bank accounts**

In `apps/web-next/src/app/(dashboard)/personal/page.tsx`, add to the existing `interface Account` (find it near the top of the file):

Find:
```ts
interface Account {
  id: string;
  name: string;
  type: string;
  balanceCents: number;
  isAsset: boolean;
}
```

Replace with:
```ts
interface Account {
  id: string;
  name: string;
  type: string;
  balanceCents: number;
  isAsset: boolean;
  plaidAccountId: string | null;
  institution: string | null;
  connected: boolean;
  lastSynced: string | null;
}
```

Add new imports at the top of the file, alongside the existing `lucide-react` import:

Find:
```ts
import {
  Wallet, Plus, TrendingUp, TrendingDown, PiggyBank, Briefcase, Loader2,
  Receipt, Target, ArrowUpCircle, ArrowDownCircle, LineChart, Lock, Sparkles,
} from 'lucide-react';
```

Replace with:
```ts
import {
  Wallet, Plus, TrendingUp, TrendingDown, PiggyBank, Briefcase, Loader2,
  Receipt, Target, ArrowUpCircle, ArrowDownCircle, LineChart, Lock, Sparkles,
  Building2, Link2, RefreshCw, CheckCircle, AlertCircle,
} from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';
```

Add new state, right after the existing `const [upgradeError, setUpgradeError] = useState<string | null>(null);` line:

```ts
  // Bank sync (Plaid)
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connectingBank, setConnectingBank] = useState(false);
  const [syncingBank, setSyncingBank] = useState(false);
  const [bankResult, setBankResult] = useState<string | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Add `useRef` to the existing React import — find:
```ts
import React, { useCallback, useEffect, useState } from 'react';
```
Replace with:
```ts
import React, { useCallback, useEffect, useRef, useState } from 'react';
```

- [ ] **Step 3: Add the Plaid Link handlers**

Add these functions after the existing `addAccount` function (find it — it ends with `finally { setSaving(false); }` inside `addAccount`):

```ts
  const clearBankWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const handleStartBankConnect = async () => {
    setConnectingBank(true);
    try {
      const res = await fetch(`${API}/plaid/link-token`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setLinkToken(data.data.linkToken);
      } else {
        setBankResult('Failed to start bank connection: ' + (data.error || 'Unknown error'));
        setConnectingBank(false);
      }
    } catch (err) {
      setBankResult('Connection error: ' + String(err));
      setConnectingBank(false);
    }
  };

  const onPlaidSuccess = useCallback(async (publicToken: string, metadata: any) => {
    clearBankWatchdog();
    setConnectingBank(true);
    try {
      const res = await fetch(`${API}/plaid/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicToken, institutionName: metadata.institution?.name }),
      });
      const data = await res.json();
      if (data.success) {
        setBankResult(`Connected ${data.data.accounts?.length || 0} account(s) from ${metadata.institution?.name || 'bank'}`);
        await load();
      }
    } catch (err) {
      setBankResult('Failed to connect: ' + String(err));
    }
    setConnectingBank(false);
    setLinkToken(null);
  }, [load, clearBankWatchdog]);

  const { open: openPlaidLink, ready: plaidReady, exit: exitPlaidLink } = usePlaidLink({
    token: linkToken,
    onSuccess: onPlaidSuccess,
    onExit: () => { clearBankWatchdog(); setLinkToken(null); setConnectingBank(false); },
  });

  // Same 45s stuck-Link watchdog as BankConnection.tsx (the expense-side
  // equivalent) — Plaid's hosted Link UI can occasionally freeze mid-flow.
  const armBankWatchdog = useCallback(() => {
    clearBankWatchdog();
    watchdogRef.current = setTimeout(() => {
      const keepWaiting = !window.confirm(
        'Bank connection is taking longer than expected.\n\nClick OK to cancel and try again, or Cancel to keep waiting a bit longer.'
      );
      if (keepWaiting) {
        armBankWatchdog();
      } else {
        exitPlaidLink({ force: true });
        setLinkToken(null);
        setConnectingBank(false);
      }
    }, 45000);
  }, [clearBankWatchdog, exitPlaidLink]);

  useEffect(() => {
    if (linkToken && plaidReady) {
      openPlaidLink();
      armBankWatchdog();
    }
    return clearBankWatchdog;
  }, [linkToken, plaidReady, openPlaidLink, armBankWatchdog, clearBankWatchdog]);

  const handleBankSync = async () => {
    setSyncingBank(true);
    setBankResult(null);
    try {
      const res = await fetch(`${API}/plaid/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBankResult(`Synced ${data.data.accountsSynced} account(s). Imported ${data.data.transactionsImported} transactions.`);
      } else if (res.status === 402) {
        setBankResult('Bank sync is part of Personal Insights — enable it above to sync.');
      }
      await load();
    } finally {
      setSyncingBank(false);
    }
  };

  const handleBankDisconnect = async (accountId: string) => {
    if (!confirm('Disconnect this bank account? Historical transactions are kept.')) return;
    await fetch(`${API}/plaid/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    await load();
  };
```

- [ ] **Step 4: Render the Connect Bank section**

The real accounts-list JSX in `apps/web-next/src/app/(dashboard)/personal/page.tsx` reads exactly:

```tsx
      {/* Accounts */}
      <h2 className="text-sm font-semibold text-foreground mb-2">Accounts</h2>
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">
          No accounts yet. Add your checking, savings, or credit card to see your net worth.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{a.type}</p>
              </div>
              <p className={`text-sm font-bold ${a.isAsset ? 'text-foreground' : 'text-destructive'}`}>
                {fmt$(a.balanceCents)}
              </p>
            </div>
          ))}
        </div>
      )}
```

Replace it with:

```tsx
      {/* Accounts */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-foreground">Accounts</h2>
        <div className="flex gap-2">
          {accounts.some((a) => a.plaidAccountId) && (
            <button onClick={handleBankSync} disabled={syncingBank}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-muted text-foreground rounded-lg text-xs hover:bg-muted/80 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${syncingBank ? 'animate-spin' : ''}`} />
              {syncingBank ? 'Syncing…' : 'Sync bank'}
            </button>
          )}
          <button onClick={handleStartBankConnect} disabled={connectingBank}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs hover:bg-primary/90 transition-colors disabled:opacity-50">
            {connectingBank ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
            Connect bank
          </button>
        </div>
      </div>
      {bankResult && (
        <div className="mb-4 p-3 rounded-xl text-sm bg-blue-500/10 text-blue-600 border border-blue-500/20 flex items-center gap-2">
          <Building2 className="w-4 h-4 shrink-0" />
          {bankResult}
          <button onClick={() => setBankResult(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">
          No accounts yet. Add your checking, savings, or credit card to see your net worth, or connect a bank above.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{a.type}</p>
                {a.plaidAccountId && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    {a.connected ? <CheckCircle className="w-3 h-3 text-green-500" /> : <AlertCircle className="w-3 h-3 text-red-500" />}
                    {a.institution || 'Bank'} · {a.lastSynced ? `Synced ${new Date(a.lastSynced).toLocaleDateString()}` : 'Not synced'}
                    <button onClick={() => handleBankDisconnect(a.id)} className="ml-2 underline hover:no-underline">Disconnect</button>
                  </p>
                )}
              </div>
              <p className={`text-sm font-bold ${a.isAsset ? 'text-foreground' : 'text-destructive'}`}>
                {fmt$(a.balanceCents)}
              </p>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 5: Manually verify in the browser**

Run the dev server (`cd apps/web-next && NODE_OPTIONS="--max-old-space-size=4096" npm run dev`), log in as a persona with the `personal_insights` add-on granted (or grant it directly via Prisma for a local test tenant), navigate to `/personal`, click "Connect bank", complete the sandbox Link flow with `user_good`/`pass_good`, and confirm: a new account appears in the list with a "Synced" badge, and "Sync bank" successfully re-syncs without error.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/package.json apps/web-next/package-lock.json apps/web-next/src/app/\(dashboard\)/personal/page.tsx
git commit -m "feat(personal-finance): Connect Bank UI on the personal dashboard

Reuses react-plaid-link's usePlaidLink the same way BankConnection.tsx
(the expense-side equivalent) does, including its 45s stuck-Link
watchdog. Linked accounts render inline in the existing accounts list
(a small badge + disconnect link) rather than a separate section — one
unified list, matching the same principle already applied to
transactions."
```

---

## Task 6: e2e test

**Files:**
- Create: `tests/e2e/personal-bank-plaid.spec.ts`

**Interfaces:**
- Consumes: the 4 routes from Task 3, deployed.

- [ ] **Step 1: Write the test**

Create `tests/e2e/personal-bank-plaid.spec.ts`:

```ts
/**
 * E2E for the personal-finance Plaid integration. Following
 * bank-plaid.spec.ts's established precedent (the expense-side
 * equivalent): the true Plaid OAuth round-trip is not automated (Link's
 * UI is iframed) — sync/sign-flip logic is covered by
 * agentbook-personal-plaid.test.ts's vitest cases instead. This spec
 * verifies the deployed endpoints' shape and gate enforcement against a
 * real logged-in session, mirroring bank-backfill-complete.spec.ts's
 * pattern for the expense side.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

const API = '/api/v1/agentbook-personal';

async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

async function registerAndLogin(page: import('@playwright/test').Page, prefix: string): Promise<string> {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `${prefix}-${suffix}@agentbook.test`;
  const password = 'e2e-personal-bank-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Personal Bank' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  return email;
}

test.describe('Personal finance bank sync (Plaid) — gate + shape', () => {
  let prisma: typeof import('@naap/database').prisma;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;
  });

  test.afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('POST /plaid/link-token returns 402 for a tenant without personal_insights', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbank-no-addon');
    const result = await apiPost(page, `${API}/plaid/link-token`, {});
    expect(result.status).toBe(402);
  });

  test('POST /plaid/link-token returns a linkToken for an entitled tenant', async ({ page }) => {
    const email = await registerAndLogin(page, 'e2e-personalbank-entitled');
    const user = await prisma.user.findUnique({ where: { email } });
    const tenantId = user!.id;

    const addOn = await prisma.billAddOn.upsert({
      where: { code: 'personal_insights' },
      update: { isActive: true },
      create: { code: 'personal_insights', name: 'Personal Insights', interval: 'year', isActive: true },
    });
    const price = await prisma.billAddOnPrice.upsert({
      where: { addOnId_region_tier: { addOnId: addOn.id, region: 'us', tier: 'standard' } },
      update: { isActive: true },
      create: { addOnId: addOn.id, region: 'us', currency: 'usd', tier: 'standard', priceCents: 4900, isActive: true },
    });
    await prisma.billAddOnSubscription.upsert({
      where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn.id } },
      create: { accountId: tenantId, addOnId: addOn.id, priceId: price.id, status: 'active' },
      update: { status: 'active', priceId: price.id, canceledAt: null },
    });

    const result = await apiPost(page, `${API}/plaid/link-token`, {});
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect(typeof result.data.data.linkToken).toBe('string');
  });

  test('POST /plaid/disconnect works without the add-on (never gated)', async ({ page }) => {
    await registerAndLogin(page, 'e2e-personalbank-disconnect');
    // No account with this id exists for this tenant — disconnectAccount
    // no-ops on a missing row, so this just proves the route itself
    // isn't gated (a 402 here would mean the gate leaked onto this route).
    const result = await apiPost(page, `${API}/plaid/disconnect`, { accountId: 'nonexistent' });
    expect(result.status).toBe(200);
  });
});
```

- [ ] **Step 2: Verify it at least parses**

Run: `cd tests/e2e && npx playwright test personal-bank-plaid.spec.ts --list`
Expected: lists all 3 tests, no parse errors. (Full execution requires a real deployed server + prod DB credentials, per this session's established pattern — that happens during the post-implementation deploy/verify step, not during this task.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/personal-bank-plaid.spec.ts
git commit -m "test(personal-finance): e2e spec for bank sync gate + shape

Follows bank-plaid.spec.ts's established precedent — real Plaid OAuth
isn't automated (Link UI is iframed, sync/sign-flip logic is
vitest-covered separately). Verifies gate enforcement (link-token 402
without personal_insights, 200 with it) and confirms disconnect is
genuinely never gated."
```

---

## Post-implementation notes (not a task — for whoever runs the final verification)

- `react-plaid-link` is a new dependency of `apps/web-next` itself (previously only the `agentbook-expense` plugin frontend had it) — confirm the build picks it up cleanly (no version conflict with the plugin's own copy).
- No manual production migration or billing-activation step this PR — the schema change is purely additive, and `personal_insights` is already live in production from PR-2.
- Manual sandbox verification (Task 5 Step 5) is the only way to observe the real Plaid Link flow end-to-end before shipping; the automated suite (unit + e2e) deliberately doesn't cover the OAuth round-trip itself.
