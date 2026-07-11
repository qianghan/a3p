# AgentBook MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude (and best-effort ChatGPT/Codex) use AgentBook via an OAuth 2.1-authenticated MCP server, so onboarding is "add a connector, log in, approve" with no manual API keys.

**Architecture:** An `oidc-provider`-backed OAuth 2.1 authorization server and an `@modelcontextprotocol/sdk`-based MCP endpoint, both added as new, additive routes inside `apps/web-next`. The MCP server exposes one tool, `ask_agentbook`, that thin-wraps agent-brain's existing `POST /api/v1/agentbook-core/agent/message` — the same call the existing web/Telegram proxies already make. Destructive actions require human-visible confirmation via MCP's `elicitation/create` mechanism, checking agent-brain's real `data.plan.requiresConfirmation` field (not an invented one) and resuming via `sessionAction: 'confirm'`.

**Tech Stack:** Next.js 15 App Router (`apps/web-next`), Prisma (`packages/database`), `oidc-provider` (new dep), `@modelcontextprotocol/sdk` (new dep), Vitest (unit), Playwright (e2e, `tests/e2e`).

## Global Constraints

- Never reference or push against the old `livepeer/naap` Neon endpoint (`neondb_owner`, `ep-hidden-paper`, `ep-frosty-pine`) — this repo's DB is Supabase `agentbook-db` (CLAUDE.md).
- New Prisma models go in `packages/database/prisma/schema.prisma`, end with `@@schema("public")` (app-level, not plugin-scoped — matching `FeatureFlag` at schema.prisma:318-328, which is `public`; note `AbTelegramBot` at schema.prisma:1474-1489 is `plugin_agentbook_core`-scoped and is cited below only for its field-naming conventions, not its schema namespace), following the `id String @id @default(uuid())` / `createdAt DateTime @default(now())` / `updatedAt DateTime @updatedAt` conventions used throughout the file.
- New runtime dependencies go in `apps/web-next/package.json` `dependencies`, caret-pinned (`^x.y.z`), matching every third-party entry there except `next` itself, which is exact-pinned (`"15.5.12"`, no caret).
- **Merge Task 1's schema change promptly once opened.** This repo's Vercel build runs `prisma db push --accept-data-loss` on every deploy (`bin/vercel-build.sh:75-82`); a slow-merging schema PR racing a concurrent deploy from an older commit is a known sharp edge here (see `feedback_vercel_deploy_race_and_db_push`), not specific to this plan but worth calling out since Task 1 is the one task that touches the schema.
- Unit tests are Vitest, colocated as `*.test.ts` beside the module under test (e.g. `apps/web-next/src/lib/agentbook-fx.ts` + `.test.ts`), following the `vi.mock('@naap/database', ...)` / `vi.mock('server-only', ...)` pattern from `apps/web-next/src/lib/agentbook-fx.test.ts:1-14`.
- E2E tests are Playwright under `tests/e2e`, run via `cd tests/e2e && npx playwright test --config=playwright.config.ts`.
- The feature flag is DB-backed via the existing `FeatureFlag` model + `apps/web-next/src/lib/admin-feature-flags.ts` helpers (not a raw `NEXT_PUBLIC_*_ENABLED` env var) — this is the established, already-tested pattern for dark-shipping features without a redeploy.
- Local Prisma push: `cd packages/database && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" npx --no prisma db push --skip-generate`. Never use `--accept-data-loss` locally; it's fine in the Vercel build path (`bin/vercel-build.sh:75-82`), which is unmodified by this plan.
- Every task that touches an existing shared file (`middleware.ts`, `settings/page.tsx`) must show the exact before/after diff — no "similar to existing" hand-waving.

---

## Phase 1 — OAuth 2.1 Authorization Server Foundation

### Task 1: Prisma schema for OAuth storage

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (append near `FeatureFlag`, schema.prisma:318-328)
- Test: `packages/database/src/oidc-adapter.test.ts` (new)

**Interfaces:**
- Produces: `OidcModel`, `McpConsentGrant` Prisma models, both `@@schema("public")`. (A tool-call audit log was considered and deferred — nothing in this plan reads one; see spec's Out of scope.)

- [ ] **Step 1: Add the models to schema.prisma**

```prisma
// One generic table serves every oidc-provider model kind (AccessToken,
// AuthorizationCode, RefreshToken, Client, Grant, Interaction, Session, ...)
// — this mirrors oidc-provider's own adapter contract, which is type+id keyed.
model OidcModel {
  id        String    @id
  type      String
  payload   Json
  grantId   String?
  userCode  String?
  uid       String?
  expiresAt DateTime?

  @@unique([type, id])
  @@index([type, uid])
  @@index([type, grantId])
  @@index([type, userCode])
  @@schema("public")
}

// Persisted user consent, separate from oidc-provider's own ephemeral Grant
// model, so a returning user skips the consent screen on reconnect.
model McpConsentGrant {
  id        String    @id @default(uuid())
  userId    String
  clientId  String
  scope     String
  grantedAt DateTime  @default(now())
  revokedAt DateTime?

  @@unique([userId, clientId])
  @@schema("public")
}
```

- [ ] **Step 2: Push the schema to local dev Postgres**

Run:
```bash
cd packages/database && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" npx --no prisma db push --skip-generate
```
Expected: `Your database is now in sync with your Prisma schema.` — no dropped tables reported (if any are, stop and investigate before proceeding — see `feedback_shared_local_db_worktrees` risk).

- [ ] **Step 3: Write the failing adapter test**

```ts
// packages/database/src/oidc-adapter.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./index', () => ({
  prisma: {
    oidcModel: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from './index';
import { PrismaOidcAdapter } from './oidc-adapter';

describe('PrismaOidcAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upsert stores the payload under (type, id) with expiresAt derived from expiresIn', async () => {
    const adapter = new PrismaOidcAdapter('AccessToken');
    const now = Date.now();
    await adapter.upsert('token-123', { foo: 'bar' }, 3600);

    expect(prisma.oidcModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type_id: { type: 'AccessToken', id: 'token-123' } },
        create: expect.objectContaining({
          type: 'AccessToken',
          id: 'token-123',
          payload: { foo: 'bar' },
        }),
      })
    );
    const call = (prisma.oidcModel.upsert as any).mock.calls[0][0];
    const storedExpiry = call.create.expiresAt.getTime();
    expect(storedExpiry).toBeGreaterThan(now + 3500 * 1000);
    expect(storedExpiry).toBeLessThan(now + 3700 * 1000);
  });

  it('find returns null for a missing or expired record', async () => {
    (prisma.oidcModel.findFirst as any).mockResolvedValue(null);
    const adapter = new PrismaOidcAdapter('AccessToken');
    const result = await adapter.find('missing-id');
    expect(result).toBeUndefined();
  });

  it('find returns the stored payload for a live record', async () => {
    (prisma.oidcModel.findFirst as any).mockResolvedValue({ payload: { foo: 'bar' } });
    const adapter = new PrismaOidcAdapter('AccessToken');
    const result = await adapter.find('token-123');
    expect(result).toEqual({ foo: 'bar' });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/database/src/oidc-adapter.test.ts`
Expected: FAIL with `Cannot find module './oidc-adapter'`.

- [ ] **Step 5: Implement the adapter**

```ts
// packages/database/src/oidc-adapter.ts
import { prisma } from './index';

// Satisfies oidc-provider's Adapter interface (see oidc-provider/lib/adapters).
export class PrismaOidcAdapter {
  constructor(private readonly type: string) {}

  async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    await prisma.oidcModel.upsert({
      where: { type_id: { type: this.type, id } },
      create: {
        id,
        type: this.type,
        payload: payload as any,
        grantId: (payload as any).grantId ?? null,
        userCode: (payload as any).userCode ?? null,
        uid: (payload as any).uid ?? null,
        expiresAt,
      },
      update: {
        payload: payload as any,
        grantId: (payload as any).grantId ?? null,
        userCode: (payload as any).userCode ?? null,
        uid: (payload as any).uid ?? null,
        expiresAt,
      },
    });
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.oidcModel.findFirst({
      where: { type: this.type, id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    return row ? (row.payload as Record<string, unknown>) : undefined;
  }

  async findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.oidcModel.findFirst({ where: { type: this.type, userCode } });
    return row ? (row.payload as Record<string, unknown>) : undefined;
  }

  async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.oidcModel.findFirst({ where: { type: this.type, uid } });
    return row ? (row.payload as Record<string, unknown>) : undefined;
  }

  async consume(id: string): Promise<void> {
    await prisma.oidcModel.updateMany({
      where: { type: this.type, id },
      data: { payload: { consumed: Math.floor(Date.now() / 1000) } as any },
    });
  }

  async destroy(id: string): Promise<void> {
    await prisma.oidcModel.deleteMany({ where: { type: this.type, id } });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await prisma.oidcModel.deleteMany({ where: { grantId } });
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/database/src/oidc-adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/src/oidc-adapter.ts packages/database/src/oidc-adapter.test.ts
git commit -m "feat(mcp): add OAuth storage models + Prisma adapter for oidc-provider"
```

### Task 2: oidc-provider bootstrap + DB-backed feature flag

**Files:**
- Create: `apps/web-next/src/lib/mcp/oauth-provider.ts`
- Create: `apps/web-next/src/lib/mcp/mcp-flag.ts`
- Test: `apps/web-next/src/lib/mcp/mcp-flag.test.ts`
- Modify: `apps/web-next/package.json` (add `oidc-provider`, `@modelcontextprotocol/sdk`)

**Interfaces:**
- Consumes: `PrismaOidcAdapter` from Task 1.
- Produces: `getOAuthProvider(): Provider` (singleton), `isMcpEnabled(): Promise<boolean>`.

- [ ] **Step 1: Add dependencies**

Edit `apps/web-next/package.json`, add to `dependencies` (alphabetical, matching existing style):
```json
"@modelcontextprotocol/sdk": "^1.12.0",
"oidc-provider": "^9.0.0",
```
Run: `npm install --workspace=apps/web-next` (or repo's standard install command if `npm install` at the workspace is blocked in your environment — coordinate with whoever has install permissions before continuing).

- [ ] **Step 1a: Check the bundle-size/cold-start cost before building on top of these deps**

Run: `cd apps/web-next && npx next build 2>&1 | tail -40` and compare the reported function sizes for any route under `api/v1/oauth`/`api/v1/mcp` (once they exist, later tasks) against a pre-change baseline. `oidc-provider` and `@modelcontextprotocol/sdk` are both server-only and not bundled into client JS, so the main cost is per-function cold-start on Vercel — acceptable for v1, but worth a real number here rather than assuming it away.

- [ ] **Step 2: Write the failing flag test**

```ts
// apps/web-next/src/lib/mcp/mcp-flag.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({
  prisma: { featureFlag: { findUnique: vi.fn() } },
}));

import { prisma } from '@naap/database';
import { isMcpEnabled, MCP_FLAG_KEY } from './mcp-flag';

describe('isMcpEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when no flag row exists (safe default: off)', async () => {
    (prisma.featureFlag.findUnique as any).mockResolvedValue(null);
    expect(await isMcpEnabled()).toBe(false);
    expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({ where: { key: MCP_FLAG_KEY } });
  });

  it('returns the stored enabled value when a row exists', async () => {
    (prisma.featureFlag.findUnique as any).mockResolvedValue({ enabled: true });
    expect(await isMcpEnabled()).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run apps/web-next/src/lib/mcp/mcp-flag.test.ts`
Expected: FAIL with `Cannot find module './mcp-flag'`.

- [ ] **Step 4: Implement the flag helper**

```ts
// apps/web-next/src/lib/mcp/mcp-flag.ts
import 'server-only';
import { prisma } from '@naap/database';

export const MCP_FLAG_KEY = 'agentbook.mcp.enabled';

export async function isMcpEnabled(): Promise<boolean> {
  const row = await prisma.featureFlag.findUnique({ where: { key: MCP_FLAG_KEY } });
  return row?.enabled ?? false;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run apps/web-next/src/lib/mcp/mcp-flag.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Implement the oidc-provider bootstrap (no route wiring yet)**

```ts
// apps/web-next/src/lib/mcp/oauth-provider.ts
import 'server-only';
import Provider from 'oidc-provider';
import { PrismaOidcAdapter } from '@naap/database/src/oidc-adapter';

let instance: Provider | undefined;

export function getOAuthProvider(): Provider {
  if (instance) return instance;

  const issuer = process.env.AGENTBOOK_MCP_ISSUER || 'https://agentbook.brainliber.com';

  instance = new Provider(issuer, {
    adapter: PrismaOidcAdapter,
    clients: [], // no static clients — Dynamic Client Registration only (Task 4)
    features: {
      registration: { enabled: true, initialAccessToken: false }, // open DCR, per MCP convention
      revocation: { enabled: true },
      devInteractions: { enabled: false }, // we render our own login/consent (Task 5)
    },
    pkce: { required: () => true }, // OAuth 2.1: PKCE mandatory for every client
    scopes: ['agentbook:full'],
    ttl: {
      AuthorizationCode: 60, // seconds
      AccessToken: 60 * 60, // 1 hour
      RefreshToken: 60 * 60 * 24 * 30, // 30 days
    },
    routes: {
      authorization: '/api/v1/oauth/authorize',
      token: '/api/v1/oauth/token',
      registration: '/api/v1/oauth/register',
      revocation: '/api/v1/oauth/revoke',
    },
  });

  return instance;
}
```

> **Fix round 1 (post-review):** the snippet above omits a `jwks` option, so oidc-provider generates ephemeral signing keys per process — unsafe on Vercel, where separate warm serverless instances would each mint incompatible keys. The shipped implementation adds `AGENTBOOK_MCP_JWKS` (a JSON-stringified JWK Set, `{ "keys": [...] }`) as a plain `process.env` var, following this repo's existing secret convention (`STRIPE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`). Unset → falls back to ephemeral keys with a one-time `console.warn` (fine for local dev); set-but-malformed → throws at startup. See `.superpowers/sdd/task-2-report.md` ("Fix round 1") for details.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/package.json apps/web-next/src/lib/mcp/oauth-provider.ts apps/web-next/src/lib/mcp/mcp-flag.ts apps/web-next/src/lib/mcp/mcp-flag.test.ts
git commit -m "feat(mcp): bootstrap oidc-provider + DB-backed MCP feature flag"
```

### Task 3: Discovery endpoints + middleware allowlist

**Files:**
- Create: `apps/web-next/src/app/.well-known/oauth-authorization-server/route.ts`
- Create: `apps/web-next/src/app/.well-known/oauth-protected-resource/route.ts`
- Modify: `apps/web-next/src/middleware.ts:145-150`
- Test: `tests/e2e/mcp-discovery.spec.ts` (new)

**Interfaces:**
- Consumes: `getOAuthProvider()` from Task 2.

- [ ] **Step 1: Add `.well-known` to the middleware allowlist**

`apps/web-next/src/middleware.ts:145-150` currently:
```ts
const publicRoutes = [
  '/api',
  '/_next',
  '/favicon.ico',
  '/docs',
];
```
Change to:
```ts
const publicRoutes = [
  '/api',
  '/_next',
  '/favicon.ico',
  '/docs',
  '/.well-known',
];
```
This is the plan's single non-additive touch to shared code — everything else (`/api/v1/oauth/*`, `/api/v1/mcp`) is already exempt today because `/api` is already in this array.

- [ ] **Step 2: Implement the discovery routes**

```ts
// apps/web-next/src/app/.well-known/oauth-authorization-server/route.ts
import { NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';

export async function GET() {
  const provider = getOAuthProvider();
  return NextResponse.json(provider.issuer && {
    issuer: provider.issuer,
    authorization_endpoint: `${provider.issuer}/api/v1/oauth/authorize`,
    token_endpoint: `${provider.issuer}/api/v1/oauth/token`,
    registration_endpoint: `${provider.issuer}/api/v1/oauth/register`,
    revocation_endpoint: `${provider.issuer}/api/v1/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['agentbook:full'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}
```

```ts
// apps/web-next/src/app/.well-known/oauth-protected-resource/route.ts
import { NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';

export async function GET() {
  const provider = getOAuthProvider();
  return NextResponse.json({
    resource: `${provider.issuer}/api/v1/mcp`,
    authorization_servers: [provider.issuer],
  });
}
```

- [ ] **Step 3: Write the e2e discovery test**

```ts
// tests/e2e/mcp-discovery.spec.ts
import { test, expect } from '@playwright/test';

test('OAuth discovery documents are reachable and well-formed', async ({ request }) => {
  const asMeta = await request.get('/.well-known/oauth-authorization-server');
  expect(asMeta.ok()).toBe(true);
  const asBody = await asMeta.json();
  expect(asBody.authorization_endpoint).toContain('/api/v1/oauth/authorize');
  expect(asBody.code_challenge_methods_supported).toContain('S256');

  const prMeta = await request.get('/.well-known/oauth-protected-resource');
  expect(prMeta.ok()).toBe(true);
  const prBody = await prMeta.json();
  expect(prBody.resource).toContain('/api/v1/mcp');
});
```

- [ ] **Step 4: Run the e2e test against a local dev server**

Run: `cd tests/e2e && npx playwright test --config=playwright.config.ts mcp-discovery.spec.ts`
Expected: PASS (1 test), once `apps/web-next` is running locally per the CLAUDE.md Quick Start.

- [ ] **Step 5: Regression check — existing login e2e still passes**

Run: `cd tests/e2e && npx playwright test --config=playwright.config.ts login-immersion.spec.ts`
Expected: PASS — proves the `middleware.ts` addition didn't change auth gating for any existing route.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/.well-known apps/web-next/src/middleware.ts tests/e2e/mcp-discovery.spec.ts
git commit -m "feat(mcp): OAuth discovery endpoints + middleware allowlist for .well-known"
```

### Task 4: Dynamic Client Registration + token endpoint wiring

**Files:**
- Create: `apps/web-next/src/app/api/v1/oauth/[...oidc]/route.ts`

**Interfaces:**
- Consumes: `getOAuthProvider()` from Task 2.
- Produces: live `/api/v1/oauth/register`, `/api/v1/oauth/token`, `/api/v1/oauth/revoke` endpoints (routing handled internally by `oidc-provider`'s own Node request handler).

- [ ] **Step 1: Mount oidc-provider's callback as a Next.js catch-all route**

`oidc-provider` exposes a plain Node `(req, res) => void` handler via `provider.callback()`. Next.js App Router route handlers use Web `Request`/`Response`, so this adapts via a small Node-compat shim:

```ts
// apps/web-next/src/app/api/v1/oauth/[...oidc]/route.ts
import { NextRequest } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';

async function handle(request: NextRequest): Promise<Response> {
  const provider = getOAuthProvider();
  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  provider.callback()(nodeReq, nodeRes);
  return responsePromise;
}

export const GET = handle;
export const POST = handle;
```

This task depends on a small adapter utility (`nodeRequestResponseFromWeb`) — build it as its own tested unit in Task 4a below rather than inline, since it's reusable by the MCP route in Phase 2 as well.

### Task 4a: Node request/response ↔ Web Request/Response adapter

**Files:**
- Create: `apps/web-next/src/lib/mcp/node-web-adapter.ts`
- Test: `apps/web-next/src/lib/mcp/node-web-adapter.test.ts`

**Interfaces:**
- Produces: `nodeRequestResponseFromWeb(request: NextRequest): Promise<{ nodeReq: IncomingMessage; nodeRes: ServerResponse; responsePromise: Promise<Response> }>`.
- Consumed by: Task 4's oidc-provider route, and Phase 2's MCP route.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web-next/src/lib/mcp/node-web-adapter.test.ts
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { nodeRequestResponseFromWeb } from './node-web-adapter';

describe('nodeRequestResponseFromWeb', () => {
  it('round-trips a JSON POST body and status/headers written via the Node response', async () => {
    const request = new NextRequest('http://localhost/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=abc',
    });

    const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
    expect(nodeReq.method).toBe('POST');
    expect(nodeReq.headers['content-type']).toBe('application/x-www-form-urlencoded');

    nodeRes.statusCode = 200;
    nodeRes.setHeader('content-type', 'application/json');
    nodeRes.end(JSON.stringify({ access_token: 'tok' }));

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: 'tok' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/web-next/src/lib/mcp/node-web-adapter.test.ts`
Expected: FAIL with `Cannot find module './node-web-adapter'`.

- [ ] **Step 3: Implement the adapter**

```ts
// apps/web-next/src/lib/mcp/node-web-adapter.ts
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { NextRequest } from 'next/server';

export async function nodeRequestResponseFromWeb(request: NextRequest): Promise<{
  nodeReq: IncomingMessage;
  nodeRes: ServerResponse;
  responsePromise: Promise<Response>;
}> {
  const url = new URL(request.url);
  const bodyBuffer = request.method !== 'GET' && request.method !== 'HEAD'
    ? Buffer.from(await request.arrayBuffer())
    : Buffer.alloc(0);

  const socket = new Socket();
  const nodeReq = new IncomingMessage(socket);
  nodeReq.method = request.method;
  nodeReq.url = url.pathname + url.search;
  nodeReq.headers = Object.fromEntries(request.headers.entries());
  process.nextTick(() => {
    nodeReq.push(bodyBuffer);
    nodeReq.push(null);
  });

  const nodeRes = new ServerResponse(nodeReq);
  const chunks: Buffer[] = [];
  const originalWrite = nodeRes.write.bind(nodeRes);
  const originalEnd = nodeRes.end.bind(nodeRes);
  (nodeRes.write as any) = (chunk: any, ...rest: any[]) => {
    chunks.push(Buffer.from(chunk));
    return originalWrite(chunk, ...rest);
  };

  const responsePromise = new Promise<Response>((resolve) => {
    (nodeRes.end as any) = (chunk?: any, ...rest: any[]) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(nodeRes.getHeaders())) {
        if (value !== undefined) headers.set(key, String(value));
      }
      resolve(new Response(Buffer.concat(chunks), { status: nodeRes.statusCode, headers }));
      return originalEnd(chunk, ...rest);
    };
  });

  return { nodeReq, nodeRes, responsePromise };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/web-next/src/lib/mcp/node-web-adapter.test.ts`
Expected: PASS (1 test).

**This is the highest-risk file in the whole plan** — it's the one place hand-rolling Node HTTP primitives instead of using a library, and it's reused unchanged by Phase 2's MCP Streamable HTTP route (Task 7), which needs long-lived/streaming responses, not just one-shot JSON. The single happy-path test above is not sufficient before Task 7 depends on it — add the following before moving on:

- [ ] **Step 4b: Add a header-casing/multi-value test, since oidc-provider (Koa-based) is sensitive to this**

```ts
it('lower-cases header names and preserves multiple Set-Cookie values, matching Node http semantics', async () => {
  const request = new NextRequest('http://localhost/api/v1/oauth/authorize', {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
  });
  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  expect(nodeReq.headers['content-type']).toBe('application/json');
  expect(nodeReq.headers['authorization']).toBe('Bearer abc');

  nodeRes.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
  nodeRes.end();
  const response = await responsePromise;
  expect(response.headers.get('set-cookie')).toContain('a=1');
});
```
Run: `npx vitest run apps/web-next/src/lib/mcp/node-web-adapter.test.ts` — expect PASS (2 tests). If `Headers.set()` collapses the two `Set-Cookie` values into one comma-joined string (a real `Headers` API quirk), switch the response-building loop in the implementation to `headers.append()` for repeated header names instead of `headers.set()`, and re-run.

- [ ] **Step 5: Commit both Task 4 and 4a together**

```bash
git add apps/web-next/src/lib/mcp/node-web-adapter.ts apps/web-next/src/lib/mcp/node-web-adapter.test.ts apps/web-next/src/app/api/v1/oauth
git commit -m "feat(mcp): Node/Web request adapter + mount oidc-provider at /api/v1/oauth"
```

### Task 5: Login/consent interaction UI

**Files:**
- Create: `apps/web-next/src/app/(auth)/oauth-consent/page.tsx`, `consent-form.tsx`
- Create: `apps/web-next/src/app/api/v1/oauth/interaction/route.ts` (GET — fetches interaction details for the consent screen)
- Modify: `apps/web-next/src/lib/mcp/oauth-provider.ts` (add `features.interactions` config pointing at the consent page)

**Interfaces:**
- Consumes: `validateSession` (`auth.ts:394`); the existing login page's `?redirect=` param + guard (`login-form.tsx:31-37`); `McpConsentGrant` (Task 1); `nodeRequestResponseFromWeb` (Task 4a).
- Produces: a rendered consent screen at `/oauth-consent?uid=<interaction-uid>`.

**Important correctness note:** `oidc-provider`'s `interactionDetails(req, res)` and `interactionResult(req, res, result)` read/write a real Koa-style request/response — specifically, they read the interaction session from a signed cookie on the actual incoming request. They **cannot** be called with empty stand-ins (`{ headers: {} } as any`); that would fail to locate the interaction at runtime, not just work unreliably. Because a Next.js Server Component (`page.tsx`) doesn't receive a raw `NextRequest` the way a route handler does, the interaction lookup is done via a small GET API route (reusing Task 4a's tested adapter) instead of calling `oidc-provider` directly from the page.

- [ ] **Step 1: Point oidc-provider's interaction flow at the new page**

In `apps/web-next/src/lib/mcp/oauth-provider.ts`, add to the `Provider` config from Task 2:
```ts
interactions: {
  url(ctx, interaction) {
    return `/oauth-consent?uid=${interaction.uid}`;
  },
},
```

- [ ] **Step 2: Implement the interaction-details API route (has a real `NextRequest`, so the adapter works correctly here)**

```ts
// apps/web-next/src/app/api/v1/oauth/interaction/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';
import { validateSession } from '@/lib/api/auth';
import { prisma } from '@naap/database';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const provider = getOAuthProvider();
  const { nodeReq, nodeRes } = await nodeRequestResponseFromWeb(request);
  const details = await provider.interactionDetails(nodeReq, nodeRes);
  const clientId = details.params.client_id as string;

  const existingGrant = await prisma.mcpConsentGrant.findUnique({
    where: { userId_clientId: { userId: user.id, clientId } },
  });

  return NextResponse.json({
    clientId,
    alreadyGranted: Boolean(existingGrant && !existingGrant.revokedAt),
  });
}
```

- [ ] **Step 3: Implement the consent page (server-side login gate only) + client form (fetches details)**

```tsx
// apps/web-next/src/app/(auth)/oauth-consent/page.tsx
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { validateSession } from '@/lib/api/auth';
import { ConsentForm } from './consent-form';

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ uid?: string }>;
}) {
  const { uid } = await searchParams;
  if (!uid) redirect('/agentbook');

  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) {
    redirect(`/login?redirect=${encodeURIComponent(`/oauth-consent?uid=${uid}`)}`);
  }

  return <ConsentForm uid={uid} />;
}
```

```tsx
// apps/web-next/src/app/(auth)/oauth-consent/consent-form.tsx
'use client';
import { useEffect, useState } from 'react';

export function ConsentForm({ uid }: { uid: string }) {
  const [details, setDetails] = useState<{ clientId: string; alreadyGranted: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/oauth/interaction?uid=${uid}`).then((r) => r.json()).then(setDetails);
  }, [uid]);

  async function respond(allow: boolean) {
    setSubmitting(true);
    const res = await fetch('/api/v1/oauth/consent-decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid, allow }),
    });
    const { redirectTo } = await res.json();
    window.location.href = redirectTo;
  }

  if (!details) return null;

  return (
    <div className="max-w-md mx-auto mt-24 p-6 rounded-xl border border-border bg-card">
      <h1 className="text-lg font-semibold mb-2">Connect to AgentBook</h1>
      <p className="text-sm text-muted-foreground mb-6">
        <strong>{details.clientId}</strong> wants to access your AgentBook data —
        expenses, invoices, tax info — and take actions on your behalf
        (you'll always be asked to confirm before anything is recorded or sent).
        {details.alreadyGranted && ' You previously approved this app.'}
      </p>
      <div className="flex gap-3">
        <button
          disabled={submitting}
          onClick={() => respond(true)}
          className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        >
          Allow
        </button>
        <button
          disabled={submitting}
          onClick={() => respond(false)}
          className="px-4 py-2 rounded-lg border border-border text-sm font-medium disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement the consent-decision route that finishes the interaction**

Uses the Task 4a adapter to give `interactionDetails`/`interactionResult` a real request/response — the same fix applied here as in the interaction-details route above, since fake `{ headers: {} } as any` stand-ins would fail to locate the interaction's session cookie at runtime. Note `request.json()` and the adapter's own body read both consume the request's body stream, so the JSON payload is read via a `clone()` first to avoid a double-read error:

```ts
// apps/web-next/src/app/api/v1/oauth/consent-decision/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';
import { prisma } from '@naap/database';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { uid, allow } = await request.clone().json();
  const token = request.cookies.get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const provider = getOAuthProvider();
  const { nodeReq, nodeRes } = await nodeRequestResponseFromWeb(request);
  const details = await provider.interactionDetails(nodeReq, nodeRes);
  const clientId = details.params.client_id as string;

  let redirectTo: string;
  if (!allow) {
    redirectTo = await provider.interactionResult(nodeReq, nodeRes, { error: 'access_denied' });
  } else {
    await prisma.mcpConsentGrant.upsert({
      where: { userId_clientId: { userId: user.id, clientId } },
      create: { userId: user.id, clientId, scope: 'agentbook:full' },
      update: { revokedAt: null, grantedAt: new Date() },
    });
    redirectTo = await provider.interactionResult(nodeReq, nodeRes, {
      login: { accountId: user.id },
      consent: { grantId: details.grantId },
    });
  }

  const response = NextResponse.json({ redirectTo, uid });
  // oidc-provider may write its own interaction/session bookkeeping cookies
  // onto the stand-in Node response — forward them onto the real one rather
  // than silently dropping them. Verify this against the pinned oidc-provider
  // version during implementation; exact cookie names/behavior aren't
  // something to assert without running the real library.
  for (const [key, value] of Object.entries(nodeRes.getHeaders())) {
    if (key.toLowerCase() === 'set-cookie' && value) {
      (Array.isArray(value) ? value : [String(value)]).forEach((v) => response.headers.append('set-cookie', v));
    }
  }
  return response;
}
```

- [ ] **Step 5: Manual verification (no automated test yet — covered by Task 11's scripted e2e flow)**

Start `apps/web-next` locally, use a scripted OAuth client (built in Task 11) to hit `/api/v1/oauth/authorize`, confirm it redirects to `/oauth-consent?uid=...` and, if unauthenticated, further to `/login?redirect=...` first.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/\(auth\)/oauth-consent apps/web-next/src/app/api/v1/oauth/consent-decision apps/web-next/src/lib/mcp/oauth-provider.ts
git commit -m "feat(mcp): login/consent interaction UI reusing existing session auth"
```

**PR checkpoint — Phase 1 complete.** At this point AgentBook has a working, independently-testable OAuth 2.1 authorization server (DCR, authorize, consent, token, revoke) with zero MCP-specific code yet. Natural split points if a reviewer wants smaller diffs: **PR #1** = Task 1 + Task 2 (schema, adapter, provider bootstrap, feature flag — Task 2 must ship with Task 1, since Tasks 3 and 4 both import `getOAuthProvider` from the module Task 2 creates); **PR #2** = Tasks 3 + 4 + 4a (discovery, DCR, Node/Web adapter); **PR #3** = Task 5 (interaction/consent + token exchange).

---

## Phase 2 — MCP Server Core

### Task 6: Bearer token validation + tenant resolution

**Files:**
- Create: `apps/web-next/src/lib/mcp/authenticate-mcp-request.ts`
- Test: `apps/web-next/src/lib/mcp/authenticate-mcp-request.test.ts`

**Interfaces:**
- Consumes: `getOAuthProvider()` (Task 2).
- Produces: `authenticateMcpRequest(request: NextRequest): Promise<{ userId: string; tenantId: string; clientId: string } | { error: NextResponse }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web-next/src/lib/mcp/authenticate-mcp-request.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const findAccessToken = vi.fn();
vi.mock('./oauth-provider', () => ({
  getOAuthProvider: () => ({
    AccessToken: { find: findAccessToken },
  }),
}));

import { authenticateMcpRequest } from './authenticate-mcp-request';

describe('authenticateMcpRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 with WWW-Authenticate when no bearer token is present', async () => {
    const request = new NextRequest('http://localhost/api/v1/mcp');
    const result = await authenticateMcpRequest(request);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
      expect(result.error.headers.get('WWW-Authenticate')).toContain('invalid_token');
    }
  });

  it('returns 401 when the token is not found or expired', async () => {
    findAccessToken.mockResolvedValue(undefined);
    const request = new NextRequest('http://localhost/api/v1/mcp', {
      headers: { authorization: 'Bearer bad-token' },
    });
    const result = await authenticateMcpRequest(request);
    expect('error' in result).toBe(true);
  });

  it('resolves userId/tenantId/clientId for a valid token (tenantId === userId per current 1:1 model)', async () => {
    findAccessToken.mockResolvedValue({ accountId: 'user-1', clientId: 'client-abc' });
    const request = new NextRequest('http://localhost/api/v1/mcp', {
      headers: { authorization: 'Bearer good-token' },
    });
    const result = await authenticateMcpRequest(request);
    expect(result).toEqual({ userId: 'user-1', tenantId: 'user-1', clientId: 'client-abc' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/web-next/src/lib/mcp/authenticate-mcp-request.test.ts`
Expected: FAIL with `Cannot find module './authenticate-mcp-request'`.

- [ ] **Step 3: Implement**

```ts
// apps/web-next/src/lib/mcp/authenticate-mcp-request.ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getOAuthProvider } from './oauth-provider';

function unauthorized(message: string): { error: NextResponse } {
  const response = NextResponse.json(
    { error: { code: 'invalid_token', message } },
    { status: 401 },
  );
  response.headers.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${message}"`);
  return { error: response };
}

export async function authenticateMcpRequest(
  request: NextRequest,
): Promise<{ userId: string; tenantId: string; clientId: string } | { error: NextResponse }> {
  const authHeader = request.headers.get('authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return unauthorized('Missing bearer token');
  }

  const provider = getOAuthProvider();
  const found = await (provider as any).AccessToken.find(token);
  if (!found) {
    return unauthorized('Token not found or expired');
  }

  // tenantId === accountId per the current 1:1 tenancy model
  // (apps/web-next/src/lib/agentbook-tenant.ts:13) — revisit if that changes.
  return { userId: found.accountId, tenantId: found.accountId, clientId: found.clientId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/web-next/src/lib/mcp/authenticate-mcp-request.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/mcp/authenticate-mcp-request.ts apps/web-next/src/lib/mcp/authenticate-mcp-request.test.ts
git commit -m "feat(mcp): bearer token validation + tenant resolution for MCP requests"
```

### Task 7: MCP endpoint scaffold + `ask_agentbook` tool

**Files:**
- Create: `apps/web-next/src/app/api/v1/mcp/route.ts`
- Create: `apps/web-next/src/lib/mcp/ask-agentbook-tool.ts`
- Test: `apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts`

**Interfaces:**
- Consumes: `authenticateMcpRequest` (Task 6), `isMcpEnabled` (Task 2), `nodeRequestResponseFromWeb` (Task 4a). Mirrors the proxy pattern in `apps/web-next/src/app/api/v1/agentbook/core/[...path]/route.ts:1-66` (env var `AGENTBOOK_CORE_URL`, `x-tenant-id` header, `POST /api/v1/agentbook-core/agent/message`).
- Produces: `callAgentBrain(params: { text: string; tenantId: string; conversationId?: string }): Promise<AgentResponse>`; the live `/api/v1/mcp` endpoint.

- [ ] **Step 1: Write the failing tests for the agent-brain wrapper**

`AgentResponse.data.plan` mirrors agent-brain's real shape (`plugins/agentbook-core/backend/src/agent-brain.ts:167`: `plan?: { steps: PlanStep[]; requiresConfirmation: boolean }`) — not an invented field. `callAgentBrain` also needs a real error path: agent-brain is a separate Express service reachable over the network, and a downstream 5xx/timeout must not leak a raw error to the calling AI client.

```ts
// apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { callAgentBrain, AgentBrainError } from './ask-agentbook-tool';

const originalFetch = global.fetch;

describe('callAgentBrain', () => {
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  it('posts to agent-brain with channel "mcp" and the resolved tenant header', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { message: 'You spent $42 this week.' } }),
    });

    const result = await callAgentBrain({ text: 'top spending?', tenantId: 'user-1' });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/agentbook-core/agent/message'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-tenant-id': 'user-1' }),
      }),
    );
    const [, options] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual({ text: 'top spending?', tenantId: 'user-1', channel: 'mcp' });
    expect(result.data.message).toBe('You spent $42 this week.');
  });

  it('surfaces a real plan.requiresConfirmation shape, not an invented field', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        data: { message: 'Record $42 to Uber as Travel?', plan: { steps: [{ id: '1' }], requiresConfirmation: true } },
      }),
    });
    const result = await callAgentBrain({ text: 'log $42 uber ride', tenantId: 'user-1' });
    expect(result.data.plan?.requiresConfirmation).toBe(true);
  });

  it('throws a safe AgentBrainError with a correlation id on network failure, no raw error leaked', async () => {
    (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:4150 — internal detail'));
    await expect(callAgentBrain({ text: 'hi', tenantId: 'user-1' })).rejects.toMatchObject({
      name: 'AgentBrainError',
      message: expect.not.stringContaining('10.0.0.5'),
      correlationId: expect.any(String),
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts`
Expected: FAIL with `Cannot find module './ask-agentbook-tool'`.

- [ ] **Step 3: Implement the agent-brain wrapper**

```ts
// apps/web-next/src/lib/mcp/ask-agentbook-tool.ts
import 'server-only';
import crypto from 'crypto';
import { PLUGIN_PORTS, DEFAULT_PORT } from '@/lib/plugin-ports';

const CORE_URL = process.env.AGENTBOOK_CORE_URL || `http://localhost:${PLUGIN_PORTS['agentbook-core'] || DEFAULT_PORT}`;

export interface AgentResponse {
  success: boolean;
  data: {
    message: string;
    skillUsed?: string;
    confidence?: number;
    sessionId?: string;
    plan?: { steps: unknown[]; requiresConfirmation: boolean };
  };
}

export class AgentBrainError extends Error {
  correlationId: string;
  constructor(message: string, correlationId: string) {
    super(message);
    this.name = 'AgentBrainError';
    this.correlationId = correlationId;
  }
}

export async function callAgentBrain(params: {
  text: string;
  tenantId: string;
  conversationId?: string;
  sessionAction?: 'confirm' | 'cancel';
}): Promise<AgentResponse> {
  const correlationId = crypto.randomUUID();
  try {
    const response = await fetch(`${CORE_URL}/api/v1/agentbook-core/agent/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': params.tenantId },
      body: JSON.stringify({
        text: params.text,
        tenantId: params.tenantId,
        channel: 'mcp',
        chatId: params.conversationId,
        sessionAction: params.sessionAction,
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`[mcp:${correlationId}] agent-brain returned ${response.status}`, body);
      throw new AgentBrainError('AgentBook is temporarily unavailable — try again shortly.', correlationId);
    }
    return JSON.parse(body) as AgentResponse;
  } catch (err) {
    if (err instanceof AgentBrainError) throw err;
    console.error(`[mcp:${correlationId}] agent-brain call failed`, err);
    throw new AgentBrainError('AgentBook is temporarily unavailable — try again shortly.', correlationId);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the MCP endpoint using the SDK's Streamable HTTP transport**

```ts
// apps/web-next/src/app/api/v1/mcp/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { authenticateMcpRequest } from '@/lib/mcp/authenticate-mcp-request';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';
import { callAgentBrain } from '@/lib/mcp/ask-agentbook-tool';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';

async function handle(request: NextRequest): Promise<Response> {
  if (!(await isMcpEnabled())) {
    return NextResponse.json({ error: 'MCP is not enabled for this deployment' }, { status: 503 });
  }

  const auth = await authenticateMcpRequest(request);
  if ('error' in auth) return auth.error;

  const server = new McpServer({ name: 'agentbook', version: '1.0.0' });

  server.registerTool(
    'ask_agentbook',
    {
      description:
        'Ask AgentBook anything about your finances, or ask it to record an expense, ' +
        'create an invoice, or take another action. Destructive actions require ' +
        'explicit human confirmation before anything is written.',
      inputSchema: { message: z.string(), conversationId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ message, conversationId }) => {
      try {
        const result = await callAgentBrain({ text: message, tenantId: auth.tenantId, conversationId });
        return { content: [{ type: 'text', text: result.data.message }] };
      } catch (err) {
        // AgentBrainError's message is already safe to surface (no stack
        // traces/internal URLs); the correlationId is logged server-side
        // (Task 7's callAgentBrain), not sent to the client.
        const message = err instanceof Error ? err.message : 'AgentBook is temporarily unavailable.';
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  );

  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(nodeReq, nodeRes);
  return responsePromise;
}

export const GET = handle;
export const POST = handle;
```

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/api/v1/mcp apps/web-next/src/lib/mcp/ask-agentbook-tool.ts apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts
git commit -m "feat(mcp): MCP endpoint + ask_agentbook tool wrapping agent-brain"
```

**PR checkpoint — Phase 2 complete (PR #4–5).** A read-capable MCP server now exists end-to-end behind the feature flag: OAuth handshake → bearer token → `ask_agentbook` → agent-brain → response. Destructive actions still work (agent-brain's own confirm-gate fires), but nothing yet guarantees a *human* saw the confirmation — that's Phase 3.

---

## Phase 3 — Confirmation Flow + Error Handling

### Task 8: Elicitation-based confirmation for destructive actions

**Files:**
- Modify: `apps/web-next/src/app/api/v1/mcp/route.ts` (call `elicitation/create` when the plan requires confirmation; refuse gracefully when the client can't support it)
- Test: a small `describe('destructive action handling')` block; the MCP SDK's request-handling isn't itself unit-testable without a running transport, so this is covered by Task 11's scripted e2e test, not a new unit test here.

**Interfaces:**
- Consumes: `AgentResponse.data.plan.requiresConfirmation` (Task 7's corrected type — matches agent-brain's real shape, `agent-brain.ts:167`) and `AgentResponse.data.message` (the human-readable preview, via agent-brain's own `formatPlan`).
- Produces: the tool handler issues `elicitation/create` before executing a confirmed write, resuming via `sessionAction: 'confirm'` (agent-brain's real confirm mechanism, `agent-brain.ts:191,205,480` — matched against text like "yes"/"confirm", not a bespoke MCP-side field).

**v1 requires elicitation support for any destructive action — no text-relay fallback.** A calling AI model relaying a preview as plain text and being trusted to only "confirm" after real user approval is exactly the gap Decision #2 (human-visible confirmation) exists to close; a client that can't do elicitation gets a clear, honest refusal for writes instead. This directly matches "Claude first" (Decision #3) — Claude Desktop/Code support elicitation today.

- [ ] **Step 1: Wire elicitation into the tool handler**

In `apps/web-next/src/app/api/v1/mcp/route.ts`, replace the tool callback body from Task 7:
```ts
async ({ message, conversationId }, extra) => {
  try {
    const result = await callAgentBrain({ text: message, tenantId: auth.tenantId, conversationId });

    if (result.data.plan?.requiresConfirmation) {
      const supportsElicitation = Boolean(extra.sendRequest); // capability check per MCP SDK
      if (!supportsElicitation) {
        return {
          content: [{
            type: 'text',
            text: 'This connection doesn\'t support secure confirmation for actions that write ' +
              'data, so I can\'t proceed with that. Read-only questions still work — or reconnect ' +
              'using a client with elicitation support (e.g. Claude Desktop/Code).',
          }],
          isError: true,
        };
      }

      const elicited = await extra.sendRequest(
        {
          method: 'elicitation/create',
          params: {
            message: result.data.message,
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean', title: 'Proceed with this action?' } },
              required: ['confirm'],
            },
          },
        },
        z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.object({ confirm: z.boolean() }).optional() }),
      );

      if (elicited.action !== 'accept' || !elicited.content?.confirm) {
        return { content: [{ type: 'text', text: 'Action cancelled — nothing was recorded.' }] };
      }

      const confirmed = await callAgentBrain({
        text: message,
        tenantId: auth.tenantId,
        conversationId,
        sessionAction: 'confirm',
      });
      return { content: [{ type: 'text', text: confirmed.data.message }] };
    }

    return { content: [{ type: 'text', text: result.data.message }] };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'AgentBook is temporarily unavailable.';
    return { content: [{ type: 'text', text: errMessage }], isError: true };
  }
},
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-next/src/app/api/v1/mcp/route.ts
git commit -m "feat(mcp): elicitation-based human confirmation for destructive actions"
```

### Task 9: Rate limiting + audit log + revoke UI

**Files:**
- Create: `apps/web-next/src/lib/mcp/rate-limit.ts`
- Test: `apps/web-next/src/lib/mcp/rate-limit.test.ts`
- Modify: `apps/web-next/src/app/api/v1/mcp/route.ts` (rate limit)
- Modify: `apps/web-next/src/app/api/v1/oauth/[...oidc]/route.ts` (rate limit the token endpoint)
- Modify: `apps/web-next/src/app/(dashboard)/settings/page.tsx` (add "Connected Apps" section between Plugin Personalization at line 832 and Appearance at line 1013)
- Create: `apps/web-next/src/app/api/v1/oauth/connected-apps/route.ts` (list + revoke, with real immediate token invalidation)

**Interfaces:**
- Consumes: `McpConsentGrant`, `PrismaOidcAdapter` (Task 1).
- Produces: `checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean>`; `GET/DELETE /api/v1/oauth/connected-apps`.

- [ ] **Step 1: Write the failing rate-limit test**

```ts
// apps/web-next/src/lib/mcp/rate-limit.test.ts
import { describe, expect, it } from 'vitest';
import { checkRateLimit } from './rate-limit';

describe('checkRateLimit', () => {
  it('allows requests under the limit and blocks the one that exceeds it', async () => {
    const key = `test-${Date.now()}`;
    expect(await checkRateLimit(key, 2, 1000)).toBe(true);
    expect(await checkRateLimit(key, 2, 1000)).toBe(true);
    expect(await checkRateLimit(key, 2, 1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/web-next/src/lib/mcp/rate-limit.test.ts`
Expected: FAIL with `Cannot find module './rate-limit'`.

- [ ] **Step 3: Implement an in-memory sliding-window limiter (no new infra for v1)**

```ts
// apps/web-next/src/lib/mcp/rate-limit.ts
const hits = new Map<string, number[]>();

export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const timestamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= limit) {
    hits.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}
```
Note: in-memory is per-instance and acceptable for v1 abuse-dampening, not a hard security boundary. Revisit with a shared store (e.g. Upstash Redis, already used elsewhere in the Vercel ecosystem) if usage grows past a single deployment's worth of protection.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/web-next/src/lib/mcp/rate-limit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Wire rate limiting into both the MCP route and the token endpoint**

The spec calls for rate limiting on *both* endpoints, not just the MCP one — the token endpoint is the more attractive target for abuse (it's what actually mints credentials). In `apps/web-next/src/app/api/v1/mcp/route.ts`, after successful auth:
```ts
const allowed = await checkRateLimit(`mcp:${auth.userId}`, 60, 60_000); // 60 calls/min/user
if (!allowed) {
  return NextResponse.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429 });
}
```
In `apps/web-next/src/app/api/v1/oauth/[...oidc]/route.ts` (Task 4), rate limit by client IP before delegating to `provider.callback()`, since token requests aren't behind `authenticateMcpRequest` (that's what they're issuing):
```ts
async function handle(request: NextRequest): Promise<Response> {
  if (request.nextUrl.pathname.endsWith('/token')) {
    const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
    const allowed = await checkRateLimit(`oauth-token:${ip}`, 20, 60_000); // 20 token requests/min/IP
    if (!allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  const provider = getOAuthProvider();
  const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
  provider.callback()(nodeReq, nodeRes);
  return responsePromise;
}
```
(Per-tool-call audit logging was considered here and deferred — see spec's Out of scope; nothing in this plan reads an audit log yet, so it isn't written either.)

- [ ] **Step 6: Implement the connected-apps list/revoke route, with real immediate token revocation**

Revocation must actually invalidate the underlying tokens, not just mark consent revoked and let them expire on their own TTL (up to 30 days for a refresh token, per Task 2's `ttl` config) — that's the difference between "revoked" and "revoked in up to a month." `revokeByGrantId` already exists from Task 1's adapter; this wires it in rather than leaving it as a follow-up comment.

```ts
// apps/web-next/src/app/api/v1/oauth/connected-apps/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { validateSession } from '@/lib/api/auth';
import { prisma } from '@naap/database';
import { PrismaOidcAdapter } from '@naap/database/src/oidc-adapter';

export async function GET(): Promise<NextResponse> {
  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const grants = await prisma.mcpConsentGrant.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { grantedAt: 'desc' },
  });
  return NextResponse.json({ data: grants });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { clientId } = await request.json();
  const grant = await prisma.mcpConsentGrant.findUnique({
    where: { userId_clientId: { userId: user.id, clientId } },
  });
  if (!grant) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await prisma.mcpConsentGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date() },
  });

  // Grant rows created via oidc-provider's own Grant model share the same
  // grantId used to key AccessToken/RefreshToken rows in OidcModel — find
  // any Grant rows for this (userId, clientId) and revoke by grantId so
  // outstanding tokens die immediately rather than waiting out their TTL.
  const grantAdapter = new PrismaOidcAdapter('Grant');
  const oidcGrants = await prisma.oidcModel.findMany({
    where: { type: 'Grant', payload: { path: ['accountId'], equals: user.id } },
  });
  for (const g of oidcGrants) {
    const payload = g.payload as { clientId?: string };
    if (payload.clientId === clientId) {
      await grantAdapter.revokeByGrantId(g.id);
    }
  }

  return NextResponse.json({ success: true });
}
```
Note: the exact `Grant` payload shape (whether `clientId` is a top-level field, and whether Prisma's JSON path filtering works this way for the installed Postgres provider) should be verified against the actual `oidc-provider` version during implementation — this is the same category of "verify against the real library" caveat as Task 5's cookie forwarding.

- [ ] **Step 7: Add the "Connected Apps" section to Settings**

In `apps/web-next/src/app/(dashboard)/settings/page.tsx`, insert a new `<section>` between the Plugin Personalization block (ending before line 1013's Appearance `<h2>`) — same `bg-card rounded-lg border p-4` shell as every other section, same `notifications.success/error` toast pattern already used for Save Profile (lines 244-249):
```tsx
<section className="bg-card rounded-lg border p-4">
  <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
    <Shield className="w-4 h-4" /> Connected Apps
  </h2>
  <ConnectedAppsList />
</section>
```
`ConnectedAppsList` is a small client component fetching `GET /api/v1/oauth/connected-apps` and rendering a revoke button per row that calls `DELETE` with the same fetch-and-toast pattern as the rest of the page.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/lib/mcp/rate-limit.ts apps/web-next/src/lib/mcp/rate-limit.test.ts apps/web-next/src/app/api/v1/mcp/route.ts apps/web-next/src/app/api/v1/oauth/[...oidc]/route.ts apps/web-next/src/app/api/v1/oauth/connected-apps apps/web-next/src/app/\(dashboard\)/settings/page.tsx
git commit -m "feat(mcp): rate limiting on MCP + token endpoints, Connected Apps revoke UI with real token invalidation"
```

**PR checkpoint — Phase 3 complete (PR #6–7).** Destructive actions now require a real human confirmation via elicitation — with a graceful refusal, not a weaker fallback, for clients that can't support it — abuse is rate-limited on both the MCP and token endpoints, and users can see/revoke connected apps from Settings with immediate token invalidation.

---

## Phase 4 — Onboarding, Docs, Validation

### Task 10: Docs page + flag flip

**Files:**
- Create: `apps/web-next/src/app/docs/mcp/page.tsx` (or `.mdx` per existing docs convention — check `apps/web-next/src/app/docs` for the established format before writing)
- N/A migration: flip the flag via the existing admin feature-flags UI/API (`apps/web-next/src/app/api/v1/admin/feature-flags/route.ts`), not a new mechanism.

- [ ] **Step 1: Write the docs page**

Follow the existing docs directory's format (MDX with frontmatter, per the other pages under `apps/web-next/src/app/docs`). Content: what the MCP server is, the exact connector URL (`https://agentbook.brainliber.com/api/v1/mcp`), a short "Add to Claude" walkthrough (Settings → Connectors → Add custom connector → paste URL → log in → approve), and an explicit note that write actions always require an in-client confirmation step.

- [ ] **Step 2: Flip the flag in a non-production environment first**

Use the existing admin feature-flags UI (already covered by `tests/e2e/admin-feature-flags.spec.ts`) to set `agentbook.mcp.enabled = true` for a preview/staging deployment. No new flag-flipping code is needed — this is the payoff of reusing the existing `FeatureFlag` pattern instead of inventing a new one.

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/src/app/docs/mcp
git commit -m "docs(mcp): connector setup guide"
```

### Task 11: Scripted OAuth-client integration test

**Files:**
- Create: `tests/e2e/mcp-oauth-flow.spec.ts`

**Interfaces:**
- Consumes: the discovery, DCR, authorize, consent, and token endpoints from Phase 1; the MCP endpoint from Phase 2.

- [ ] **Step 1: Write the full-handshake test**

```ts
// tests/e2e/mcp-oauth-flow.spec.ts
import { test, expect } from '@playwright/test';
import crypto from 'crypto';

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('full OAuth 2.1 handshake: DCR -> authorize -> login -> consent -> token -> tool call', async ({ page, request }) => {
  // 1. Dynamic Client Registration
  const reg = await request.post('/api/v1/oauth/register', {
    data: { redirect_uris: ['http://localhost:9999/callback'], token_endpoint_auth_method: 'none' },
  });
  expect(reg.ok()).toBe(true);
  const { client_id } = await reg.json();

  // 2. Kick off /authorize with PKCE
  const { verifier, challenge } = pkcePair();
  const authorizeUrl = `/api/v1/oauth/authorize?response_type=code&client_id=${client_id}` +
    `&redirect_uri=${encodeURIComponent('http://localhost:9999/callback')}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&scope=agentbook:full`;
  await page.goto(authorizeUrl);

  // 3. Expect redirect to login (test account not yet authenticated in this context)
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel('Email').fill('maya@agentbook.test');
  await page.getByLabel('Password').fill('agentbook123');
  await page.getByRole('button', { name: /sign in/i }).click();

  // 4. Consent screen
  await expect(page).toHaveURL(/\/oauth-consent\?uid=/);
  await page.getByRole('button', { name: 'Allow' }).click();

  // 5. Capture the redirected authorization code
  await page.waitForURL(/localhost:9999\/callback\?code=/, { timeout: 10_000 }).catch(() => {});
  const finalUrl = page.url();
  const code = new URL(finalUrl).searchParams.get('code');
  expect(code).toBeTruthy();

  // 6. Exchange the code for a token
  const tokenRes = await request.post('/api/v1/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: 'http://localhost:9999/callback',
      client_id,
      code_verifier: verifier,
    },
  });
  expect(tokenRes.ok()).toBe(true);
  const { access_token } = await tokenRes.json();

  // 7. Call the MCP tool with the issued token
  const mcpRes = await request.post('/api/v1/mcp', {
    headers: { authorization: `Bearer ${access_token}` },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ask_agentbook', arguments: { message: 'top spending this month?' } },
    },
  });
  expect(mcpRes.ok()).toBe(true);
});
```

- [ ] **Step 2: Run against a local dev server with the flag enabled**

Run:
```bash
cd tests/e2e && npx playwright test --config=playwright.config.ts mcp-oauth-flow.spec.ts
```
Expected: PASS. If it fails at the login step, confirm the test account (`maya@agentbook.test` / `agentbook123`, per `agentbook/users.md`) exists in the target environment.

- [ ] **Step 3: Regression check — full existing e2e suite**

Run: `cd tests/e2e && npx playwright test --config=playwright.config.ts`
Expected: all pre-existing specs still pass, confirming nothing in this plan regressed the rest of the product.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/mcp-oauth-flow.spec.ts
git commit -m "test(mcp): full OAuth handshake + tool call e2e coverage"
```

### Task 12: Live validation against Claude Desktop/Code

**Files:** none (manual validation task).

- [ ] **Step 1: Deploy to a preview environment with the flag enabled for a test tenant**
- [ ] **Step 2: In Claude Desktop or Claude Code, add a custom connector pointed at the preview MCP URL**
- [ ] **Step 3: Complete the OAuth flow as a real human** (log in, see the consent screen, approve)
- [ ] **Step 4: Ask a read-only question** ("what's my top spending category this month?") and confirm a sensible answer comes back
- [ ] **Step 5: Trigger a destructive action** ("log a $12 coffee expense") and confirm Claude surfaces a real confirmation prompt (via elicitation) before anything is written — verify the expense actually appears in AgentBook only after confirming
- [ ] **Step 6: Revoke the connection from AgentBook Settings** and confirm the next Claude tool call fails with a re-auth prompt, not a silent success
- [ ] **Step 7: Reconnect and exercise a real multi-turn confirm sequence** — ask Claude something that maps to a destructive skill, decline the elicitation prompt, confirm nothing was written, then repeat and accept — not just a single-shot happy path, since the confirm/decline branch is the actual safety-critical code path in this whole plan

**PR checkpoint — Phase 4 complete (PR #8–9).** MCP server is documented, has full automated OAuth-flow coverage, and has been validated against a real Claude client end-to-end, including the safety-critical confirmation path in both its accept and decline branches.

---

## Self-Review Notes

- **Spec coverage**: every spec section (Decisions 1–4, Architecture, End-to-end flow, Confirmation flow, Error handling, Testing, Regression risk, Out-of-scope) maps to at least one task above. Out-of-scope items (granular scopes, multi-tenant consent, structured per-capability tools, full ChatGPT/Codex validation, a tool-call audit log, and the text-relay confirmation fallback) are intentionally absent from this plan, matching the spec.
- **Type consistency checked**: `AgentResponse` is defined once in Task 7 (matching agent-brain's real `plan.requiresConfirmation` shape) and only consumed, not redefined, in Task 8; `authenticateMcpRequest`'s return shape (`{ userId, tenantId, clientId }` or `{ error }`) is used identically in Tasks 7–9.
- **Regression proof points are concrete, not asserted**: Task 3 Step 5 and Task 11 Step 3 both explicitly re-run pre-existing e2e specs and require them to still pass — this is the plan's actual evidence for the spec's "low regression risk" claim, not just a repeated claim.

### Revision log — external review pass (2026-07-10)

This plan and its spec were independently reviewed by three reviewers (fact-accuracy against the live codebase, spec/plan consistency and completeness, over-engineering and regression-risk critique) before any code was written. Confirmed and fixed:

- **Real bug, not style**: `needsConfirmation: { preview: string }` was an invented field — agent-brain's actual confirm-gate shape is `data.plan.requiresConfirmation: boolean` + `data.message` (preview text), resumed via `sessionAction: 'confirm'`. Fixed throughout Tasks 7–8 and the spec's Confirmation Flow section.
- **Real bug, not style**: Task 5's original `interactionDetails`/`interactionResult` calls used empty stand-ins (`{ headers: {} } as any`) — `oidc-provider` reads a real session cookie from the actual request to locate an interaction, so this would have failed at runtime. Fixed by routing through Task 4a's tested Node/Web adapter with the real incoming request in both the new interaction-details route and the consent-decision route.
- **Route/middleware inconsistency between spec and plan**: the spec originally described bare `/oauth/*` and `/api/mcp` routes needing two middleware allowlist additions; the plan had already (correctly) put everything under the already-exempt `/api/v1/*` prefix, needing only a `.well-known` addition. Spec updated to match the plan's lower-risk scheme.
- **Scope cut (YAGNI)**: `McpToolCallAuditLog` removed from v1 — nothing in the 12 tasks reads it. Revisit once there's a real consumer.
- **Safety-alignment fix**: the original text-relay fallback for non-elicitation clients directly reopened the gap Decision #2 exists to close. v1 now requires elicitation for any destructive action and gives a clear refusal otherwise, consistent with "Claude first."
- **Completeness gaps closed**: rate limiting now covers the token endpoint (not just MCP), `callAgentBrain` now has real error handling with a correlation ID instead of letting `JSON.parse` throw, and Connected Apps revocation now actually calls `revokeByGrantId` instead of leaving it as a code comment.
- **Minor precision fixes**: endpoint path citations now include `/api/v1`; the `AbTelegramBot` schema-citation note was corrected (it's `plugin_agentbook_core`-scoped, not `public`); `next`'s exact-pin exception to the caret-pinning convention is now noted; a schema-PR-merge-promptly note was added given this repo's known `prisma db push --accept-data-loss` deploy-race sharp edge; a bundle-size/cold-start check step was added for the two new dependencies.
