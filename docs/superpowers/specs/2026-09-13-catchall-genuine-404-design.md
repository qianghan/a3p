# Unmatched paths must return a genuine HTTP 404

**Date:** 2026-09-13
**Status:** implemented

## Problem

`apps/web-next/src/app/(dashboard)/[...slug]/page.tsx` was a `'use client'`
catch-all. It matched every path Next.js had no more specific route for, and it
only decided the path was a 404 after JavaScript ran in the browser. To any HTTP
client the response was `200 text/html`.

Measured on production 2026-09-13:

```
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://agentbook.brainliber.com/.well-known/openid-configuration
-> 200 text/html; charset=utf-8
```

This is not cosmetic. It caused an outage-class bug (PR #556). The MCP OAuth
client requests `/.well-known/oauth-protected-resource/api/v1/mcp`. The MCP SDK
falls back to the root metadata URL only on a 4xx — its `shouldAttemptFallback`
is `status >= 400 && status < 500`. A 200 meant "found it", so the SDK threw
while parsing an HTML page as JSON, discovery ended, and the connector could not
be added at all. A 404 would have worked.

## What the catch-all was actually serving

| Route shape | Served by | Reached the catch-all? |
|---|---|---|
| `/plugins/<name>` | `(dashboard)/plugins/[pluginName]/page.tsx` | no |
| `/agentbook/*`, `/forum` | middleware rewrite via `PLUGIN_ROUTE_MAP` | no |
| `/billing`, `/admin/billing` (+ sub-paths) | the catch-all | **yes** |
| everything else unmatched | the catch-all | **yes**, and returned 200 |

Two real routes, both declared by `plugins/agentbook-billing/plugin.json`.

## The finding that decided the design

The obvious fix — make the page a server component and call `notFound()` — was
built first, and it does not work in this app. It produces the correct 404 PAGE
and a `200` STATUS.

Measured on a production build (`next build` + `next start`), with probe routes
added temporarily:

| Route | `notFound()` status |
|---|---|
| `/zzz-sync` (root segment, sync `notFound()`) | **200** |
| `/zzz-sync`, with `app/loading.tsx` removed | **404** |
| `/docs/<unknown>` (pre-existing `notFound()` call) | **200**; **404** without `app/loading.tsx` |
| `(dashboard)/zzz-dash` (sync `notFound()`), no `loading.tsx` anywhere | **200** |

Two independent structural causes, both of which put the route into streaming
mode — and a streamed response has already committed its status line by the
time the page renders:

1. **`src/app/loading.tsx`.** A root `loading.tsx` is a Suspense boundary around
   every route in the app. It is also load-bearing: removing it fails the build,
   because it is the boundary that satisfies the `useSearchParams()` CSR-bailout
   check on `/login`, `/settings` and `/marketplace`.
2. **The `(dashboard)` layout.** Even with no `loading.tsx` present anywhere, a
   trivial `notFound()`-only page inside `(dashboard)` still returns 200.

So no page inside `(dashboard)` can return a 404 status, whatever it does. That
rules out the server-component approach, and `generateStaticParams` +
`dynamicParams = false` was already ruled out because `/billing/*` sub-paths are
client-side SPA routes of unbounded depth and cannot be enumerated.

## Design

**Delete the catch-all. Serve its two real routes the way `/forum` is served.**

```ts
// middleware.ts — PLUGIN_ROUTE_MAP
'/billing': 'agentbookBilling',
'/admin/billing': 'agentbookBilling',
```

With no `[...slug]` page, an unmatched path matches no route at all, and Next.js
answers it at the **routing layer** — before any rendering, which is the only
point where the status can still be set. That is why this works where
`notFound()` cannot.

This also fixes the problem rather than patching it: the class of bug ("a page
that matches everything") stops existing, instead of being made to behave.

### What changes for users

- Unmatched paths: `200` → `404`. The rendered page is the same
  `app/not-found.tsx`.
- `/billing` and `/admin/billing`: now authenticated plugin routes, so an
  unauthenticated request gets `307 → /login` instead of a client-rendered 404.
  Correct for a billing page.
- Container paths with no `page.tsx` (`/admin`, `/plugins`, `/cpa`, `/dashboard`)
  return `404` instead of `200` with a 404 screen. Verified that nothing in the
  app links to any of them.

### The cost, and the guard

A plugin route missing from `PLUGIN_ROUTE_MAP` used to still work — the
catch-all resolved it from the plugin manifests, just later and via React. Now
it is a hard 404. `src/__tests__/architecture/plugin-route-map.test.ts` carries
the guard: every base route declared by any `plugins/*/plugin.json` must be
served by `/plugins/[pluginName]` or by `PLUGIN_ROUTE_MAP`, or CI fails naming
the route and the exact entry to add. Verified to fail against `origin/main`'s
middleware, citing `/billing` and `/admin/billing`.

## Testing

| Test | Asserts |
|---|---|
| `src/__tests__/architecture/plugin-route-map.test.ts` | every declared plugin route has something that serves it |
| `tests/e2e/http-status.spec.ts` | **status codes over real HTTP** |

The e2e spec is the one that tests the actual requirement: unmatched paths and
`/.well-known/openid-configuration` return `404`; the MCP metadata routes return
JSON; `/docs/<page>`, `/login`, `/billing` and `/admin/billing` still resolve. A
test that navigated and looked for the text "404" would have passed throughout
the entire outage, so every assertion is on the response line, not the DOM.

## Known remaining case, not fixed here

`/docs/<unknown>` still returns 200. `docs/[...slug]/page.tsx` calls
`notFound()` correctly; the root `loading.tsx` swallows the status, exactly as
measured above. Fixing it means relocating `src/app/loading.tsx` out of the root
segment and giving each subtree that needs the CSR-bailout boundary its own —
an app-shell change with its own UX consequences, and out of scope for a change
about the catch-all. Recorded here so it is not mistaken for fixed.
