# Propagate PR-10 Auth Hardening to Sibling Plugin Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `agentbook-startup`, `agentbook-invoice`, `agentbook-expense`, and `agentbook-tax`'s backends up to the exact same auth posture the already-merged Launch-gap PR-10 gave `agentbook-core` — closing both the disclosed `publicRoutes` gap (the whole API prefix listed as public regardless of environment) and a second, more severe issue found while investigating this PR: 3 of the 4 sibling plugins resolve the tenant ID by trusting the client-supplied `x-tenant-id` header **unconditionally** (even in production, even ahead of the authenticated user's real ID in two of them) — the exact "tenant-id trust" failure mode PR-10's own `tenantMiddleware` was written to close in `agentbook-core`.

**Architecture:** Copy `agentbook-core`'s exact, already-reviewed-and-merged pattern into all 4 sibling backends — a `NODE_ENV`-conditional `publicRoutes`/`requireAuth` pair, and a `tenantMiddleware` function that requires `req.user.id` (set by the SDK's real auth middleware) in production, and falls back to the `x-tenant-id` header only in local development. No new pattern — every plugin backend ends up structurally identical to `agentbook-core`'s already-merged fix.

**Tech Stack:** Express (via `@naap/plugin-server-sdk`'s `createPluginServer`), TypeScript, Vitest.

## Global Constraints

- Copy `agentbook-core`'s exact pattern (`plugins/agentbook-core/backend/src/server.ts` lines ~34-83) — don't invent a different shape per plugin.
- This is dev-only/self-hosted-only reachability (per the disclosed context from Launch-gap PR-10's own review — these Express backends are not the code path Vercel production traffic hits; Next.js API routes are) — but "not currently the production path" is not the same as "safe to leave broken," since self-hosted/docker deployments do hit this code directly.
- Every plugin's existing route handlers that read `req.tenantId` (or an equivalent ad hoc field) must keep working identically in development — this PR changes how `req.tenantId` gets SET, not how it's consumed downstream.
- Test in the same style already established for `agentbook-core`'s `tenantMiddleware` (if such a test exists — check for it) or write new tests matching this repo's Express-middleware test conventions.

---

### Task 1: `agentbook-startup` — fix `publicRoutes` and tenant resolution

**Files:**
- Modify: `plugins/agentbook-startup/backend/src/server.ts`
- Test: check for an existing `server.test.ts`/`middleware.test.ts` in this plugin's backend `__tests__` dir; add tenant-middleware tests there if one exists, or create a new focused test file if none does

**Interfaces:**
- Produces: `tenantMiddleware(req, res, next)`, registered via `app.use(tenantMiddleware)`, replacing the current `getTenantId()` helper + inline `req.tenantId = getTenantId(req)` assignment.

- [ ] **Step 1: Read the current file in full** — confirm the exact current `publicRoutes`/`requireAuth` config, the `getTenantId` function, and where `req.tenantId = getTenantId(req)` is currently invoked, before changing anything.

- [ ] **Step 2: Fix `publicRoutes`**, matching `agentbook-core`'s exact pattern:

```ts
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes:
    process.env.NODE_ENV === 'production' ? ['/healthz'] : ['/healthz', '/api/v1/agentbook-startup'],
```

- [ ] **Step 3: Replace `getTenantId`/its call site with a `tenantMiddleware` function**, copied from `agentbook-core`'s exact implementation (adjust only the plugin-name references in comments, not the logic):

```ts
export function tenantMiddleware(req: any, res: any, next: any) {
  if (process.env.NODE_ENV === 'production') {
    const tenantId = req.user?.id;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'No authenticated tenant for this request' },
      });
    }
    req.tenantId = tenantId;
    return next();
  }

  req.tenantId = (req.headers?.['x-tenant-id'] as string) || 'default';
  next();
}

app.use(tenantMiddleware);
```

Remove the old `getTenantId` function and its call site entirely — every downstream `req.tenantId` reference keeps working unchanged since the middleware still sets that same field.

- [ ] **Step 4: Write/extend tests** covering: (a) production + no `req.user` → 401; (b) production + `req.user.id` set → `req.tenantId` equals it, `x-tenant-id` header is ignored even if present; (c) development + `x-tenant-id` header present → `req.tenantId` equals the header value; (d) development + no header → `req.tenantId` defaults to `'default'`.

- [ ] **Step 5: Run the plugin's full backend test suite** (`cd plugins/agentbook-startup/backend && npm test`) and confirm nothing else broke.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-startup/backend/src/server.ts plugins/agentbook-startup/backend/src/__tests__/
git commit -m "fix(startup): propagate PR-10 auth hardening (publicRoutes + tenant-ID trust)"
```

---

### Task 2: `agentbook-tax` — fix `publicRoutes` and tenant resolution

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/server.ts`
- Test: same approach as Task 1 — check for an existing test file first.

**Interfaces:** identical shape to Task 1, applied to this plugin.

- [ ] **Step 1: Read the current file in full**, same as Task 1 Step 1, for this plugin.
- [ ] **Step 2: Fix `publicRoutes`**, same pattern, substituting `/api/v1/agentbook-tax`.
- [ ] **Step 3: Replace `getTenantId`/its call site with the same `tenantMiddleware`.** Note this file's current `getTenantId` already checks `req.user?.id` as a fallback, but in the WRONG priority order (header first, user ID second) — the new `tenantMiddleware` fixes the ordering as part of matching `agentbook-core`'s pattern, not as a separate change.
- [ ] **Step 4: Write/extend tests**, same 4 cases as Task 1.
- [ ] **Step 5: Run `cd plugins/agentbook-tax/backend && npm test`.**
- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-tax/backend/src/server.ts plugins/agentbook-tax/backend/src/__tests__/
git commit -m "fix(tax): propagate PR-10 auth hardening (publicRoutes + tenant-ID trust)"
```

---

### Task 3: `agentbook-invoice` — fix `publicRoutes` and add tenant resolution

**Files:**
- Modify: `plugins/agentbook-invoice/backend/src/server.ts`
- Test: same approach.

**Interfaces:** identical shape, but this plugin currently has NO `req.user` check at all (`(req as any).tenantId = req.headers['x-tenant-id'] as string || 'default'`, unconditionally trusting the header in every environment) — this is the most severe of the 4 sibling gaps, since it doesn't even have the partial protection the other two have.

- [ ] **Step 1: Read the current file in full**, confirm the exact current line(s).
- [ ] **Step 2: Fix `publicRoutes`**, same pattern, substituting `/api/v1/agentbook-invoice`.
- [ ] **Step 3: Add the `tenantMiddleware` function** (this plugin doesn't have an equivalent to replace — it's a net addition, not a replacement), registered via `app.use(tenantMiddleware)` before the existing inline tenant-id line, then remove that inline line.
- [ ] **Step 4: Write/extend tests**, same 4 cases.
- [ ] **Step 5: Run `cd plugins/agentbook-invoice/backend && npm test`.**
- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-invoice/backend/src/server.ts plugins/agentbook-invoice/backend/src/__tests__/
git commit -m "fix(invoice): propagate PR-10 auth hardening (publicRoutes + tenant-ID trust)"
```

---

### Task 4: `agentbook-expense` — fix `publicRoutes` and add tenant resolution

**Files:**
- Modify: `plugins/agentbook-expense/backend/src/server.ts`
- Test: same approach.

**Interfaces:** identical shape to Task 3 (same "no req.user check at all" gap).

- [ ] **Step 1: Read the current file in full.**
- [ ] **Step 2: Fix `publicRoutes`**, substituting `/api/v1/agentbook-expense`.
- [ ] **Step 3: Add the `tenantMiddleware` function**, same as Task 3.
- [ ] **Step 4: Write/extend tests**, same 4 cases.
- [ ] **Step 5: Run `cd plugins/agentbook-expense/backend && npm test`.**
- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-expense/backend/src/server.ts plugins/agentbook-expense/backend/src/__tests__/
git commit -m "fix(expense): propagate PR-10 auth hardening (publicRoutes + tenant-ID trust)"
```

---

### Task 5: Full verification across all 4 plugins

- [ ] **Step 1: Run all 4 plugin backend test suites together** one more time to confirm nothing regressed after all 4 tasks land: `agentbook-startup`, `agentbook-tax`, `agentbook-invoice`, `agentbook-expense`.
- [ ] **Step 2: Grep for any remaining unconditional `req.headers['x-tenant-id']` or old `getTenantId` reference** across all 4 plugins' `server.ts` files to confirm no leftover call site was missed.
- [ ] **Step 3: Confirm development behavior is unchanged** by re-reading each plugin's local Quick Start flow (CLAUDE.md) mentally against the new middleware — dev mode must still default to `'default'`/trust the header exactly as before, so local testing isn't broken.

## Self-Review

- Spec coverage: closes both the roadmap's originally-disclosed `publicRoutes` gap AND a more severe tenant-ID-trust gap found during this PR's own investigation in 3 of the 4 plugins — the full "propagate PR-10 hardening" intent, not just the narrower one-line description.
- Placeholder scan: none.
- Consistency: all 4 plugins end up with byte-for-byte the same `tenantMiddleware` logic as `agentbook-core`, varying only in the plugin-name string inside `publicRoutes`.
