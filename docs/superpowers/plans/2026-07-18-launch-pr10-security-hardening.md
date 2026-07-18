# Launch-gap PR-10: Security Hardening — Tenant-ID Trust + CORS Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two security-flavored gaps from the launch-gap stability audit: (a) the shared plugin-backend auth middleware trusts a plain `x-tenant-id` header with no verification once a request is inside a plugin's Express app, because that plugin's entire API prefix is listed as a public (auth-exempt) route; (b) the shared plugin-backend CORS config (and a second, independently-reachable copy in the static-asset plugin server) defaults to allow-all-with-credentials whenever `CORS_ALLOWED_ORIGINS` is unset — the worst-case CORS misconfiguration.

**Architecture:** Both fixes reuse a pattern this codebase already established and hardened elsewhere (`apps/web-next/src/lib/agentbook-tenant.ts`'s two-path model: real session OR `CRON_SECRET` bearer + header, for legitimate service-to-service calls) rather than inventing anything new:
- The tenant-ID fix is centralized in `packages/plugin-server-sdk/src/middleware/auth.ts`'s shared `createAuthMiddleware` — a `CRON_SECRET` bearer short-circuit (timing-safe compare, mirroring `agentbook-tenant.ts`'s `isCronAuthenticated`/`safeBearerCompare`) is added before the existing "validate against the auth service" path. This fixes the gap for every plugin backend built on this SDK (`agentbook-core`, `agentbook-invoice`, `agentbook-expense`, `agentbook-startup`, `agentbook-tax`), not just the one file the roadmap happened to cite.
- `plugins/agentbook-core/backend/src/server.ts` then narrows its own `publicRoutes` (which currently exempts its *entire* API prefix from auth — the real bug) down to just `/healthz`, and its tenant middleware reads the now-reliably-set `req.user.id` instead of trusting the raw header directly.
- CORS: both `packages/plugin-server-sdk/src/server.ts` and the independently-reachable `services/plugin-server/src/server.ts` get the same one-line fail-closed fix — an empty/unset origin allowlist now means "reject all cross-origin requests" instead of "allow all."

**Tech Stack:** Express (plugin backends + the plugin-server-sdk factory), vitest (new test scaffolding for a package that currently has none).

## Global Constraints

- **Investigation finding, load-bearing for scope discipline:** neither vulnerable code path is reachable through this repo's actual production deployment today. `docs/DEPLOYMENT.md`/`docs/VERCEL_DEPLOYMENT.md` state plainly that production runs Next.js API route handlers only — the standalone plugin Express servers (`plugins/*/backend/src/server.ts`, built on `createPluginServer`) are dev-only, started by `bin/start.sh` for local development, and are **not** started by `docker-compose.production.yml` or reachable via the Vercel build. This matches the exact "dev-only Express duplicate" pattern found repeatedly in PR-5/6/8. Fix it anyway — for defense-in-depth, because a self-hosted operator who does start these servers directly (bypassing the documented topology) would be exposed, and because the roadmap explicitly calls for it — but do not describe this fix in the PR as closing an active production vulnerability.
- **One CORS instance IS reachable in the documented self-hosted production topology:** `services/plugin-server/src/server.ts` (a separate Express app, not built on the SDK — it only serves static plugin frontend bundles over Bearer-token auth, no session cookies) has the identical `TODO(#92)` allow-all-when-empty bug and **is** started by `docker-compose.production.yml`. This file was not named in the roadmap's own file citation but must be fixed identically — call this out explicitly in the plan and the PR description as a discovery beyond the roadmap's stated scope, matching this session's established disclosure practice.
- **No new auth architecture.** The `CRON_SECRET` bearer short-circuit added to `createAuthMiddleware` is a direct port of the exact two-path model (`isCronAuthenticated` + timing-safe bearer compare) already live and tested in `apps/web-next/src/lib/agentbook-tenant.ts` — do not invent a new token format, new header, or new service.
- **`packages/plugin-server-sdk` currently has zero test infrastructure** (no `vitest.config.ts`, no `test` script, vitest not a devDependency). This plan adds minimal scaffolding mirroring the sibling `packages/plugin-sdk` package's existing `vitest.config.ts` (same monorepo, same tooling conventions) — do not invent a different test setup.
- **`services/plugin-server`'s CORS fix is a pure config-condition change** — do not add test infrastructure to that service as part of this plan; it has no existing tests and adding a full suite there is out of scope (a config-only, one-line, directly-inspectable fix does not need new test scaffolding to be verified — read it in code review instead).

---

### Task 1: `CRON_SECRET` bearer short-circuit in the shared auth middleware

**Files:**
- Modify: `packages/plugin-server-sdk/src/middleware/auth.ts`
- Create: `packages/plugin-server-sdk/vitest.config.ts`
- Modify: `packages/plugin-server-sdk/package.json` (add `vitest`/`@vitest/coverage-v8` devDependencies + a `test`/`test:run` script, mirroring `packages/plugin-sdk/package.json`'s existing scripts)
- Test: `packages/plugin-server-sdk/src/middleware/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no change to `createAuthMiddleware`'s exported signature — `req.user` is now ALSO populated (with `{ id: <tenantId from x-tenant-id header> }`) when the caller presents a valid `CRON_SECRET` bearer, in addition to the existing real-session path. Task 2 relies on `req.user.id` always being reliably set by the time its own middleware runs (for any request that reaches past `createAuthMiddleware` at all).

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin-server-sdk/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
```

Add to `packages/plugin-server-sdk/package.json`'s `"scripts"` (read the file first to match its exact existing formatting):
```json
"test": "vitest",
"test:run": "vitest run",
```
Add to `"devDependencies"`:
```json
"vitest": "^4.0.18",
"@vitest/coverage-v8": "^4.0.18",
```
(match whatever exact vitest major version `packages/plugin-sdk/package.json` currently pins — read that file and copy its exact version string rather than guessing.)

Create `packages/plugin-server-sdk/src/middleware/__tests__/auth.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Response, NextFunction } from 'express';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth';

function mockReq(headers: Record<string, string> = {}, path = '/some/route'): AuthenticatedRequest {
  return { headers, path } as AuthenticatedRequest;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('createAuthMiddleware — CRON_SECRET bearer short-circuit', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    global.fetch = vi.fn(); // any call to this proves we did NOT take the short-circuit
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalCronSecret;
    global.fetch = originalFetch;
  });

  it('sets req.user from x-tenant-id and calls next() when the bearer matches CRON_SECRET, without calling the auth service', async () => {
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({
      authorization: 'Bearer test-cron-secret',
      'x-tenant-id': 'tenant-abc-123',
    });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(req.user).toEqual({ id: 'tenant-abc-123' });
    expect(next).toHaveBeenCalledOnce();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer matches CRON_SECRET but x-tenant-id is missing', async () => {
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({ authorization: 'Bearer test-cron-secret' });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('does NOT short-circuit when the bearer does not match CRON_SECRET (falls through to normal auth-service validation)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'real-user-1', email: 'a@b.com' }),
    });
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({
      authorization: 'Bearer some-real-session-token',
      'x-tenant-id': 'tenant-should-be-ignored',
    });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(req.user?.id).toBe('real-user-1'); // NOT 'tenant-should-be-ignored'
    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT short-circuit when CRON_SECRET is unset, even if a caller sends a matching-looking bearer', async () => {
    delete process.env.CRON_SECRET;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401, text: async () => 'no' });
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({ authorization: 'Bearer test-cron-secret', 'x-tenant-id': 'tenant-x' });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(global.fetch).toHaveBeenCalledOnce(); // fell through to real validation, which then fails
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('still returns 401 for a missing Authorization header entirely (existing behavior, unchanged)', async () => {
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin-server-sdk && npx vitest run` (after `npm install` in that package to pick up the new devDependencies).
Expected: FAIL — no `CRON_SECRET` short-circuit exists yet, so the first two tests fail (real fetch never gets mocked to matter, `req.user` never gets set from the header).

- [ ] **Step 3: Implement the short-circuit**

In `packages/plugin-server-sdk/src/middleware/auth.ts`, add near the top of the file (after the existing `sanitizeForLog` helper, before `createAuthMiddleware`):
```ts
import { timingSafeEqual } from 'node:crypto';

/**
 * Timing-safe bearer compare against CRON_SECRET — mirrors
 * apps/web-next/src/lib/agentbook-tenant.ts's isCronAuthenticated/
 * safeBearerCompare exactly. This is the same two-path model (real
 * session OR CRON_SECRET + x-tenant-id for service-to-service calls)
 * already hardened there; this just applies it to the shared Express
 * auth middleware every plugin backend uses.
 */
function isCronAuthenticated(authHeader: string | undefined): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !authHeader) return false;
  const want = `Bearer ${cronSecret}`;
  if (authHeader.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(authHeader), Buffer.from(want));
}
```

Then inside `createAuthMiddleware`'s returned handler, immediately after the "Skip auth for public paths" block and BEFORE the existing "Extract token from Authorization header" / missing-header check:
```ts
    // CRON_SECRET + x-tenant-id: legitimate service-to-service calls
    // (e.g. the agent brain calling its own plugin's HTTP API). Trust
    // the header ONLY when the bearer matches CRON_SECRET — never
    // otherwise. See isCronAuthenticated above.
    const authHeaderRaw = req.headers.authorization;
    if (isCronAuthenticated(authHeaderRaw)) {
      const tenantId = req.headers['x-tenant-id'] as string | undefined;
      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'x-tenant-id header required for service-to-service auth' },
        });
      }
      req.user = { id: tenantId };
      return next();
    }
```
(The existing `const authHeader = req.headers.authorization;` line further down can stay as-is — it's fine for both to read the same header; do not duplicate work, just don't remove the existing extraction, since the rest of the function still uses its own local `authHeader` binding for the real-session path.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/plugin-server-sdk && npx vitest run src/middleware/__tests__/auth.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-server-sdk/vitest.config.ts packages/plugin-server-sdk/package.json packages/plugin-server-sdk/src/middleware/auth.ts packages/plugin-server-sdk/src/middleware/__tests__/auth.test.ts package-lock.json
git commit -m "feat(security): add CRON_SECRET bearer short-circuit to shared plugin auth middleware"
```

---

### Task 2: Narrow `agentbook-core`'s public-route exemption and stop trusting the raw header

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/tenant-middleware.test.ts`

**Interfaces:**
- Consumes: `AuthenticatedRequest` type from `@naap/plugin-server-sdk` (Task 1's file) — `req.user.id` is now reliably set for any request that reaches past the SDK's auth middleware (either a real session or a CRON_SECRET-authenticated service call).

**Context:** Currently `publicRoutes: ['/healthz', '/api/v1/agentbook-core']` exempts this plugin's *entire* API prefix from `createAuthMiddleware` — meaning `createAuthMiddleware` never runs for any real route in this plugin, and the subsequent tenant middleware trusts a bare `x-tenant-id` header with zero verification (defaulting to the string `'default'` if absent, which is its own separate footgun — a request with no header at all gets treated as a fixed, guessable tenant). This task narrows the exemption to just `/healthz` (the SDK's own default) so the auth middleware — now fixed by Task 1 to support both real sessions and CRON_SECRET service calls — actually runs, and rewrites the tenant middleware to read the verified `req.user.id` instead of the raw header.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '@naap/plugin-server-sdk';

// Import the tenant middleware as an isolated function — read
// plugins/agentbook-core/backend/src/server.ts first to see whether the
// middleware is already a named, exported function or an inline
// app.use(...) callback. If it's inline (likely, matching the current
// file), extract it into a small named, exported function
// (e.g. `export function tenantMiddleware(req, res, next) {...}`) as
// part of this task's Step 2 change, specifically so it's unit-testable
// without booting the whole Express app — this is a minimal, mechanical
// refactor (extract-function), not new architecture.

import { tenantMiddleware } from '../server';

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('agentbook-core tenant middleware', () => {
  it('derives tenantId from req.user.id (set by the SDK auth middleware) when present', () => {
    const req = { user: { id: 'tenant-from-auth' }, headers: {} } as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect((req as any).tenantId).toBe('tenant-from-auth');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when req.user is not set (auth middleware did not authenticate this request)', () => {
    const req = { headers: {} } as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('never falls back to the literal string "default" under any circumstance', () => {
    const req = { headers: {} } as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect((req as any).tenantId).not.toBe('default');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tenant-middleware.test.ts`
Expected: FAIL — `tenantMiddleware` isn't exported yet.

- [ ] **Step 3: Implement the fix**

Find (in `plugins/agentbook-core/backend/src/server.ts`):
```ts
const { app, start } = createPluginServer({
  ...pluginConfig,
  // In development, make API routes publicly accessible for testing.
  // In production, auth is enforced by the Next.js proxy layer.
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes: ['/healthz', '/api/v1/agentbook-core'],
});

// === Middleware ===
app.use((req, res, next) => {
  // TODO: Extract tenant_id from auth token. For now use header.
  (req as any).tenantId = req.headers['x-tenant-id'] as string || 'default';
  next();
});
```
Replace with:
```ts
const { app, start } = createPluginServer({
  ...pluginConfig,
  // In development, make API routes publicly accessible for testing.
  // In production, auth is enforced by the Next.js proxy layer.
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes: ['/healthz'],
});

// === Middleware ===
// req.user is set by the SDK's createAuthMiddleware — either from a real
// validated session, or from the CRON_SECRET + x-tenant-id
// service-to-service path (see packages/plugin-server-sdk's
// middleware/auth.ts). Never trust a raw header directly, and never
// fall back to a fixed 'default' tenant — an unauthenticated request
// should already have been rejected by the auth middleware before this
// ever runs, so req.user being unset here means requireAuth is off
// (local dev) or something is misconfigured; fail closed either way.
export function tenantMiddleware(req: any, res: any, next: any) {
  const tenantId = req.user?.id;
  if (!tenantId) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'No authenticated tenant for this request' },
    });
  }
  req.tenantId = tenantId;
  next();
}

app.use(tenantMiddleware);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tenant-middleware.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Run the full existing agentbook-core backend suite to check for regressions**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: same pre-existing failures already documented in this session's prior PRs (agent-brain-confirm-gate/confidence-escalation/confirm-flow — confirm this by comparing against a clean checkout if the count looks different), no NEW failures caused by this change. If any other existing test in this package directly exercises the old `app.use((req,res,next)=>{...})` inline tenant assignment via an HTTP request against the dev server (rather than mocking), it may need updating to send a valid `Authorization` header — check for this specifically, since this change makes every previously-implicitly-public route in this Express app require auth now.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/tenant-middleware.test.ts
git commit -m "fix(security): stop trusting raw x-tenant-id header in agentbook-core Express server"
```

---

### Task 3: CORS fail-closed default in the shared plugin-server SDK

**Files:**
- Modify: `packages/plugin-server-sdk/src/server.ts`
- Test: `packages/plugin-server-sdk/src/__tests__/cors.test.ts`

**Interfaces:** none new — internal config-resolution logic only.

- [ ] **Step 1: Write the failing test**

Read `packages/plugin-server-sdk/src/server.ts`'s current CORS block in full first (lines ~132-161 per this plan's investigation) to confirm the exact current variable names before writing the test, since this task extracts the origin-resolution logic into a small, directly-testable pure function rather than testing it only via a full Express app + supertest (avoiding a new test dependency, per the Global Constraints).

```ts
import { describe, expect, it } from 'vitest';
import { resolveAllowAllOrigins } from '../server';

describe('CORS origin resolution — fail-closed default', () => {
  it('does NOT allow all origins when CORS_ALLOWED_ORIGINS/corsOrigins is unset (empty)', () => {
    expect(resolveAllowAllOrigins(undefined)).toBe(false);
    expect(resolveAllowAllOrigins('')).toBe(false);
    expect(resolveAllowAllOrigins([])).toBe(false);
  });

  it('allows all origins ONLY when explicitly set to the literal string "*"', () => {
    expect(resolveAllowAllOrigins('*')).toBe(true);
    expect(resolveAllowAllOrigins(' * ')).toBe(true); // trimmed
  });

  it('does not allow all when a real origin list is configured', () => {
    expect(resolveAllowAllOrigins('https://example.com,https://foo.com')).toBe(false);
    expect(resolveAllowAllOrigins(['https://example.com'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-server-sdk && npx vitest run src/__tests__/cors.test.ts`
Expected: FAIL — `resolveAllowAllOrigins` isn't exported yet.

- [ ] **Step 3: Extract and fix the logic**

Find (in `packages/plugin-server-sdk/src/server.ts`):
```ts
  // CORS - validate origins when allowlist set; empty = allow-all (relaxed for now)
  // TODO(#92): Fail closed when empty; set CORS_ALLOWED_ORIGINS for production
  const configuredOrigins =
    corsOrigins || (process.env.CORS_ALLOWED_ORIGINS || '');
  const originsArray: string[] = (
    Array.isArray(configuredOrigins)
      ? configuredOrigins
      : typeof configuredOrigins === 'string'
        ? configuredOrigins.split(',')
        : []
  )
    .map((o) => String(o).trim())
    .filter(Boolean);
  const allowAllOrigins =
    originsArray.length === 0 ||
    (typeof configuredOrigins === 'string' && configuredOrigins.trim() === '*');
```
Replace with:
```ts
  // CORS - fail closed: an unset/empty allowlist means reject every
  // cross-origin request (same-origin and no-Origin requests, e.g.
  // server-to-server or curl, are unaffected — see the origin callback
  // below). Explicitly set CORS_ALLOWED_ORIGINS=* to opt in to allow-all.
  // Closes #92.
  const configuredOrigins =
    corsOrigins || (process.env.CORS_ALLOWED_ORIGINS || '');
  const originsArray: string[] = (
    Array.isArray(configuredOrigins)
      ? configuredOrigins
      : typeof configuredOrigins === 'string'
        ? configuredOrigins.split(',')
        : []
  )
    .map((o) => String(o).trim())
    .filter(Boolean);
  const allowAllOrigins = resolveAllowAllOrigins(configuredOrigins);
```
And add the extracted, exported function above (near the top of the file, after the imports):
```ts
/**
 * Whether the CORS origin allowlist should permit every origin.
 * Exported for direct unit testing — see src/__tests__/cors.test.ts.
 * Fail-closed: empty/unset means false (reject cross-origin requests),
 * NOT true. Only an explicit '*' opts in to allow-all. Closes #92.
 */
export function resolveAllowAllOrigins(configuredOrigins: string | string[] | undefined): boolean {
  if (typeof configuredOrigins === 'string') {
    return configuredOrigins.trim() === '*';
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-server-sdk && npx vitest run src/__tests__/cors.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd packages/plugin-server-sdk && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-server-sdk/src/server.ts packages/plugin-server-sdk/src/__tests__/cors.test.ts
git commit -m "fix(security): fail-closed CORS default in plugin-server-sdk (closes #92)"
```

---

### Task 4: Same CORS fail-closed fix in the self-hosted static-asset plugin server

**Files:**
- Modify: `services/plugin-server/src/server.ts`

**Interfaces:** none — config-condition change only, no new exports (per Global Constraints, no new test infrastructure for this service).

**Context:** discovered during this plan's investigation — not named in the roadmap's own file citation, but has the identical `TODO(#92)` bug and, unlike the SDK-based plugin backends, **is** started by `docker-compose.production.yml` in the documented self-hosted topology (it serves static plugin frontend bundles over Bearer-token auth, not session cookies — smaller blast radius than a credentialed-session CORS hole, but the same class of misconfiguration).

- [ ] **Step 1: Apply the fix**

Find (in `services/plugin-server/src/server.ts`):
```ts
// CORS - allowlist when set; empty = allow-all (relaxed for now)
// TODO(#92): Fail closed when empty; set CORS_ALLOWED_ORIGINS for production
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (CORS_ALLOWED_ORIGINS.length === 0 || CORS_ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
```
Replace with:
```ts
// CORS - fail closed: an unset/empty allowlist rejects every
// cross-origin request. Explicitly set CORS_ALLOWED_ORIGINS=* to opt
// in to allow-all, or a comma-separated list for a real allowlist.
// Closes #92 (this file was not in the original citation for #92 but
// has the identical bug and, unlike the SDK-based plugin backends, is
// actually started in docker-compose.production.yml).
const corsOriginsRaw = process.env.CORS_ALLOWED_ORIGINS || '';
const CORS_ALLOW_ALL = corsOriginsRaw.trim() === '*';
const CORS_ALLOWED_ORIGINS = corsOriginsRaw
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (CORS_ALLOW_ALL || CORS_ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
```

- [ ] **Step 2: Typecheck**

Run: `cd services/plugin-server && npx tsc --noEmit` (or this service's actual typecheck command — check its `package.json` first).
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add services/plugin-server/src/server.ts
git commit -m "fix(security): fail-closed CORS default in services/plugin-server static asset server (closes #92)"
```

---

### Task 5: Full verification, PR, CI, merge, and deploy

**Files:** none (verification-only task).

- [ ] **Step 1: Run all touched test suites**

Run: `cd packages/plugin-server-sdk && npx vitest run`, `cd plugins/agentbook-core/backend && npx vitest run`, and confirm `services/plugin-server`'s own build/typecheck is clean (no test suite exists there to run).
Expected: all new tests pass; the `agentbook-core` backend suite shows only the same pre-existing, unrelated failures already documented across this session's prior PRs (`agent-brain-confirm-gate`/`confidence-escalation`/`confirm-flow`).

- [ ] **Step 2: Typecheck all touched packages**

Run `npx tsc --noEmit` in `packages/plugin-server-sdk`, `plugins/agentbook-core/backend`, and `services/plugin-server`.
Expected: no new errors in any file this branch touches.

- [ ] **Step 3: Manually verify the auth-bypass fix actually closes the gap, locally**

Start `plugins/agentbook-core/backend/src/server.ts` locally with `NODE_ENV=production` (matching this repo's CLAUDE.md Quick Start command, adding `NODE_ENV=production` to it) and confirm: (a) a request to any non-`/healthz` route with no `Authorization` header now returns 401 (previously would have succeeded, trusting the header or defaulting to `'default'`); (b) a request with `Authorization: Bearer <CRON_SECRET>` + `x-tenant-id: <some-id>` succeeds and the tenant middleware correctly uses that id; (c) `/healthz` itself still works with no auth at all (confirms the narrowed `publicRoutes` didn't accidentally break health checks, which this repo's own infra likely depends on).

- [ ] **Step 4: Final whole-branch review**

Dispatch a code-reviewer subagent on a capable model pointed at the full diff from `origin/main` to this branch's HEAD. Ask it to specifically: (a) independently re-verify the `CRON_SECRET` timing-safe compare in Task 1 is implemented correctly (no length-check short-circuit timing leak, matches `agentbook-tenant.ts`'s established pattern exactly); (b) confirm no other plugin backend built on `createPluginServer` (agentbook-invoice, agentbook-expense, agentbook-startup, agentbook-tax) has its OWN `publicRoutes` config that similarly exempts its entire API prefix the same way `agentbook-core` did — if any do, flag this as an additional instance of the same bug this PR should either also fix or explicitly note as an accepted, separate follow-up (do not silently leave a sibling instance of the exact bug this PR is fixing); (c) confirm the CORS fail-closed fix is applied identically and correctly in both `packages/plugin-server-sdk/src/server.ts` and `services/plugin-server/src/server.ts`; (d) confirm this branch makes no changes to any Next.js route or `apps/web-next` file (the fix should be entirely scoped to the dev-only/self-hosted Express layer, per the roadmap's own file citation and this plan's investigation).

- [ ] **Step 5: Push, open PR, wait for CI, merge, deploy**

Push the branch, open a PR (conventional-commit title, e.g. `fix(security): tenant-id trust + CORS fail-closed default (Launch-gap PR-10)` — verify against the repo's title-lint allowed-types list before opening). Describe both fixes, explicitly call out that neither closes an active production vulnerability (per the Global Constraints' investigation finding) but both are real hardening for the self-hosted/local-dev topology, and explicitly disclose the `services/plugin-server` file as a discovery beyond the roadmap's stated file citation. Wait for CI; the chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure pattern (confirmed unrelated to this branch across every prior PR this session) is expected and safe to merge past once reconfirmed for this specific PR's run. Merge normally (no `--admin`). Deploy via the established `vercel build --prod` + `vercel deploy --prebuilt --prod` flow — no schema changes, no production-data actions, no separate confirmation gate needed (this PR touches only dev-only/self-hosted Express code paths, not anything the Vercel-hosted production deployment actually executes).
