# Fix PWA Mobile Google Sign-In Infinite Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AgentBook's installed-PWA users from getting stuck in an infinite Google-sign-in loop, by fixing a verified service-worker caching bug and adding standalone-display-mode awareness to the OAuth redirect flow.

**Architecture:** Three independent, additive changes to existing files — no new modules, no new architecture. (1) The service worker (`sw.js`) stops precaching an auth-gated route and stops serving stale cached responses for the two routes where staleness is actively harmful (`/login`, `/agentbook`). (2) The OAuth login helper (`auth-context.tsx`) detects standalone/installed-PWA display mode before redirecting, purely for future observability/handling — the redirect mechanism itself is unchanged (there is no web-platform way to keep a cross-origin OAuth redirect inside an iOS standalone container). (3) The OAuth callback route renders a small recoverable "you're signed in" interstitial instead of a bare redirect when it detects the request isn't coming from within an installed PWA context, so a user stranded in the system browser gets an honest, working way back in rather than an invisible bounce.

**Tech Stack:** Next.js 15 App Router (route handlers, no framework auth library), vanilla service worker (no Workbox), Vitest + Testing Library for the two TS-based changes; `sw.js` itself has no existing test harness (confirmed via its own header comment — it's a plain, unbundled static asset) and is verified manually per this plan's Task 1.

## Global Constraints

- No new abstraction layers — this is a bug fix to three existing files, not a redesign of the auth flow.
- No popup-window/`postMessage` OAuth bridge (explicitly out of scope per the roadmap entry this plan implements — iOS's cookie-storage isolation between Safari and standalone PWAs is an OS-level restriction no client-side bridge can fully defeat, and building one would be disproportionate to this fix).
- Regular (non-PWA, ordinary browser tab) sign-in behavior must be provably unchanged by every task below.
- `sw.js` is a plain static file served from `apps/web-next/public/` — it is not passed through the TypeScript/webpack build, so changes to it are verified by direct inspection + the manual verification steps in Task 1, not by a Vitest unit test.

---

### Task 1: Stop the service worker from serving a stale pre-auth response for `/login` and `/agentbook`

**Files:**
- Modify: `apps/web-next/public/sw.js`

**Interfaces:**
- Consumes: nothing from other tasks (this is the first task).
- Produces: no code interface — this task only changes runtime caching behavior of the existing `fetch` event listener. Tasks 2 and 3 do not depend on this task's internals.

- [ ] **Step 1: Read the current file and confirm the two exact defects**

Read `apps/web-next/public/sw.js` in full. Confirm:
- `PRECACHE_URLS` (near the top) includes `'/agentbook'` — an auth-gated route being cached at install time, before any user session exists.
- The `fetch` handler's `mode === 'navigate'` branch (`if (event.request.mode === 'navigate') { event.respondWith(networkFirstWithCache(event.request)); return; }`) applies to every navigation including `/login` and `/agentbook`, and `networkFirstWithCache`'s `catch` block falls back to whatever is cached under that exact request key.

- [ ] **Step 2: Remove `/agentbook` from `PRECACHE_URLS`**

```js
// Static assets to pre-cache
const PRECACHE_URLS = [
  '/manifest.json',
];
```

`/agentbook` requires an auth cookie (enforced by `middleware.ts`); precaching it at install time — before any session exists — captures the unauthenticated redirect response, not the real dashboard. Nothing else in this file references `/agentbook` as a precache target, so removing it is a pure subtraction.

- [ ] **Step 3: Give `/login` and `/agentbook` (and any other top-level navigation) a network-only path — no cache read, no cache write**

Replace the navigation branch in the `fetch` handler:

```js
  // Navigation: network-only. Auth state (via the naap_auth_token cookie)
  // can flip between visits to the same URL — serving a stale cached
  // response here (e.g. an old pre-auth redirect to /login) is exactly the
  // failure mode that caused the PWA Google-sign-in loop. Navigations get
  // no offline fallback; everything else below still does.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
    return;
  }
```

This removes the `networkFirstWithCache` call (and therefore all caching) for every navigation request, replacing it with a plain passthrough `fetch`. API requests (`/api/v1/agentbook*`), CDN plugin bundles, and static assets below this branch are untouched — they keep their existing cache-first / network-first-with-fallback behavior, since those are the paths that legitimately benefit from an offline fallback and aren't auth-sensitive per-request.

- [ ] **Step 4: Confirm `networkFirstWithCache` still compiles/lints as valid (now only reachable from the API branch)**

Re-read the full file after the edit. `networkFirstWithCache` must still be defined and still be called from the `/api/v1/agentbook` branch (~line 43-46) — only its `navigate`-mode caller is removed, not the function itself.

- [ ] **Step 5: Bump the cache version constants so existing installs pick up the new behavior on next activation**

```js
const STATIC_CACHE = 'agentbook-static-v2';
const API_CACHE = 'agentbook-api-v2';
```

The existing `activate` handler already deletes any cache key that isn't the current `STATIC_CACHE`/`API_CACHE` — bumping the version numbers means every already-installed PWA (which may still be holding the bad `/agentbook` precache entry from before this fix) purges it automatically on the next service-worker activation, rather than requiring a manual cache clear from affected users.

- [ ] **Step 6: Manual verification (no automated test harness exists for this file)**

Using the Browser pane (or a real device if available):
1. Load the app fresh in a private/incognito context, confirm the service worker installs and `/login` loads.
2. Open DevTools → Application → Cache Storage, confirm `agentbook-static-v2` does NOT contain an entry for `/agentbook`.
3. Log in via email/password (not OAuth) in a normal browser tab, confirm `/agentbook` loads correctly and repeat visits are fresh (not stale).
4. Note: full PWA-installed + Google OAuth verification happens after Tasks 2-3 land, as the end-to-end check for this plan.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/public/sw.js
git commit -m "fix(pwa): stop caching stale pre-auth responses for /login and /agentbook"
```

---

### Task 2: Detect standalone/installed-PWA display mode in the OAuth login helper

**Files:**
- Modify: `apps/web-next/src/contexts/auth-context.tsx`
- Test: `apps/web-next/src/__tests__/contexts/auth-context.test.tsx` (new file — no existing test covers this context; follow the mocking conventions in `apps/web-next/src/__tests__/api/v1/auth/register-route.test.ts` for `vi.mock`/`vi.fn` style)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `loginWithOAuth` now sends an additional query parameter `standalone=1` on the OAuth authorization-URL request when the app is running in standalone display mode. Task 3 consumes this: the callback route (which receives the original `state` cookie set on this request) reads whether the ORIGINAL authorization request was standalone by checking a new `oauth_standalone` cookie this task also sets (see Step 3) — this is the interface Task 3's implementer must read.

- [ ] **Step 1: Write the failing test for standalone detection**

```tsx
// apps/web-next/src/__tests__/contexts/auth-context.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/contexts/auth-context';

function TestButton() {
  const { loginWithOAuth } = useAuth();
  return <button onClick={() => loginWithOAuth('google')}>go</button>;
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  global.fetch = vi.fn();
  delete (window.location as unknown as { href?: string }).href;
  (window.location as unknown as { href: string }).href = '';
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('loginWithOAuth — standalone-mode awareness', () => {
  it('requests the standalone-aware URL when display-mode: standalone matches', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { url: 'https://accounts.google.com/o/oauth2/authorize?x=1' } }),
    });

    render(<AuthProvider><TestButton /></AuthProvider>);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/auth/oauth/google?standalone=1'),
        expect.objectContaining({ credentials: 'include' })
      );
    });
  });

  it('requests the plain URL (no standalone param) in a normal browser tab', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { url: 'https://accounts.google.com/o/oauth2/authorize?x=1' } }),
    });

    render(<AuthProvider><TestButton /></AuthProvider>);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() => {
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('standalone=1');
    });
  });
});
```

Adjust the import path / provider wrapping to match `auth-context.tsx`'s actual exported shape (read the file first — if `AuthProvider` requires props or context this test doesn't supply, add minimal mocks for whatever `useEffect`s run on mount, e.g. the session-check fetch).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/__tests__/contexts/auth-context.test.tsx`
Expected: FAIL — `loginWithOAuth` doesn't add `?standalone=1` yet.

- [ ] **Step 3: Implement standalone detection in `loginWithOAuth`**

In `apps/web-next/src/contexts/auth-context.tsx`, modify `loginWithOAuth` (currently ~lines 244-264):

```tsx
  const loginWithOAuth = useCallback(async (provider: 'google' | 'github' | 'microsoft') => {
    try {
      const isStandalone =
        typeof window !== 'undefined' &&
        (window.matchMedia?.('(display-mode: standalone)').matches ||
          (window.navigator as unknown as { standalone?: boolean }).standalone === true);
      const query = isStandalone ? '?standalone=1' : '';
      const response = await fetch(`${API_BASE}/v1/auth/oauth/${provider}${query}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || err.message || 'Failed to initiate OAuth');
      }
      const data = await response.json();
      const url = data.data?.url || data.url;
      if (url) {
        window.location.href = url;
      } else {
        throw new Error(`OAuth provider ${provider} is not configured`);
      }
    } catch (error) {
      console.error('OAuth error:', error);
      throw error;
    }
  }, []);
```

- [ ] **Step 4: Wire the `standalone` query param through the OAuth-URL route so it can set a cookie Task 3 will read**

Modify `apps/web-next/src/app/api/v1/auth/oauth/[provider]/route.ts` — read the `standalone` query param and set a short-lived cookie alongside the existing `oauth_state` cookie:

```ts
    const standalone = request.nextUrl.searchParams.get('standalone') === '1';

    // ...existing state/url generation unchanged...

    response.cookies.set('oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10,
      path: '/',
    });

    if (standalone) {
      response.cookies.set('oauth_standalone', '1', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 10,
        path: '/',
      });
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/__tests__/contexts/auth-context.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/contexts/auth-context.tsx apps/web-next/src/app/api/v1/auth/oauth/\[provider\]/route.ts apps/web-next/src/__tests__/contexts/auth-context.test.tsx
git commit -m "feat(auth): detect standalone PWA mode before initiating OAuth redirect"
```

---

### Task 3: Recoverable interstitial when the OAuth callback lands outside the installed PWA

**Files:**
- Modify: `apps/web-next/src/app/api/v1/auth/callback/[provider]/route.ts`
- New: `apps/web-next/src/app/(auth)/signed-in/page.tsx` (a minimal client page — the "you're signed in, return to the app" interstitial)
- Test: `apps/web-next/src/__tests__/api/v1/auth/callback-route.test.ts` (new file, follow the `register-route.test.ts` mocking convention)

**Interfaces:**
- Consumes: the `oauth_standalone` cookie set by Task 2's Step 4 (`request.cookies.get('oauth_standalone')?.value === '1'`).
- Produces: nothing further downstream — this is the last task in this plan.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web-next/src/__tests__/api/v1/auth/callback-route.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const handleOAuthCallbackFn = vi.fn();
vi.mock('@/lib/api/auth', () => ({
  handleOAuthCallback: (...a: unknown[]) => handleOAuthCallbackFn(...a),
}));

import { GET } from '@/app/api/v1/auth/callback/[provider]/route';

function req(url: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(url);
  for (const [k, v] of Object.entries(cookies)) request.cookies.set(k, v);
  return request;
}

beforeEach(() => {
  handleOAuthCallbackFn.mockReset();
  handleOAuthCallbackFn.mockResolvedValue({
    token: 'tok123',
    user: { id: 'u1' },
    expiresAt: new Date('2026-08-01'),
  });
});

describe('GET /api/v1/auth/callback/[provider] — standalone-aware redirect', () => {
  it('redirects straight to /agentbook when oauth_standalone cookie is absent', async () => {
    const request = req('http://x/api/v1/auth/callback/google?code=abc&state=s1', {
      oauth_state: 's1',
    });
    const res = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/agentbook');
  });

  it('redirects to the /signed-in interstitial when oauth_standalone cookie is present', async () => {
    const request = req('http://x/api/v1/auth/callback/google?code=abc&state=s1', {
      oauth_state: 's1',
      oauth_standalone: '1',
    });
    const res = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/signed-in');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/auth/callback-route.test.ts`
Expected: FAIL on the second case — the route currently always redirects to `/agentbook`.

- [ ] **Step 3: Implement the standalone-aware redirect in the callback route**

Modify `apps/web-next/src/app/api/v1/auth/callback/[provider]/route.ts`'s `GET` handler — after the existing state-verification block and `handleOAuthCallback` call:

```ts
    const isStandalone = request.cookies.get('oauth_standalone')?.value === '1';
    const destination = isStandalone ? '/signed-in' : '/agentbook';

    // Redirect to agentbook home (or the recoverable interstitial) with auth cookie
    const response = NextResponse.redirect(new URL(destination, request.url));

    // Set auth cookie
    response.cookies.set('naap_auth_token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    // Clear OAuth state cookies (must match sameSite used when setting them)
    response.cookies.set('oauth_state', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0, path: '/' });
    if (isStandalone) {
      response.cookies.set('oauth_standalone', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0, path: '/' });
    }

    return response;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/auth/callback-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the `/signed-in` interstitial page**

```tsx
// apps/web-next/src/app/(auth)/signed-in/page.tsx
'use client';

import Link from 'next/link';
import { Wordmark } from '@/components/brand/Wordmark';

/**
 * Reached only when an OAuth sign-in that started inside the installed PWA
 * completed in a context (typically iOS's system browser) whose cookie
 * storage the standalone app can't read. The session cookie set by the
 * callback route IS valid here — this page's own "Open AgentBook" link
 * works immediately in this browser tab. Returning to the home-screen app
 * icon requires the user to sign in there too; there's no web-platform way
 * to hand the session to the installed app's separate storage container.
 */
export default function SignedInPage() {
  return (
    <div className="w-full max-w-sm px-4 mx-auto flex flex-col items-center text-center gap-4 py-16">
      <Wordmark size={40} />
      <h1 className="text-lg font-medium text-muted-foreground">You&apos;re signed in</h1>
      <p className="text-sm text-muted-foreground/80">
        If you opened AgentBook from your home screen, switch back to that app icon and continue there.
        Otherwise, you can keep using AgentBook right here.
      </p>
      <Link
        href="/agentbook"
        className="w-full py-2.5 bg-gradient-to-b from-brand-bright to-brand-primary text-[#04231b] rounded-lg text-sm font-semibold transition hover:brightness-105 text-center"
      >
        Open AgentBook
      </Link>
    </div>
  );
}
```

Match this page's route group placement (`(auth)`) and styling classes to `apps/web-next/src/app/(auth)/login/login-form.tsx`'s existing conventions — read that file's surrounding `layout.tsx` first to confirm the `(auth)` group doesn't itself require an auth cookie (it must be reachable in this exact scenario, i.e. cookie just-set-but-standalone-context).

- [ ] **Step 6: Confirm `/signed-in` isn't blocked by `middleware.ts`**

Read `apps/web-next/src/middleware.ts`'s `protectedRoutes`/`authRoutes`/`publicRoutes` arrays. `/signed-in` must not appear in `authRoutes` (which redirects authenticated users away — this page is FOR authenticated users) and must not require the plugin-route auth gate. If it isn't already implicitly allowed by falling through to `NextResponse.next()`, add it explicitly rather than relying on omission.

- [ ] **Step 7: Manual end-to-end verification**

Using a real iOS device (or the Browser pane's standalone-mode emulation if available) with AgentBook installed as a PWA:
1. From the installed app icon, tap "Continue with Google," complete Google's consent screen.
2. Confirm you land on `/signed-in` (not a loop back to `/login`) if the redirect surfaced in a context outside the installed app, or directly in `/agentbook` if it stayed inside.
3. Confirm tapping "Open AgentBook" on `/signed-in` reaches a real authenticated dashboard.
4. Repeat in a normal (non-PWA) mobile browser tab and confirm the flow goes straight to `/agentbook` exactly as before this fix.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/app/api/v1/auth/callback/\[provider\]/route.ts apps/web-next/src/app/\(auth\)/signed-in/page.tsx apps/web-next/src/__tests__/api/v1/auth/callback-route.test.ts apps/web-next/src/middleware.ts
git commit -m "feat(auth): recoverable sign-in interstitial for standalone-PWA OAuth"
```

---

## Self-Review

- **Spec coverage:** Task 1 closes the deterministic stale-cache bug (root cause #1+#2 from the roadmap entry); Tasks 2-3 close the standalone-mode blind spot (root cause #3), turning an invisible loop into a working recovery path. All three root causes named in the roadmap's PR US-0 entry are covered.
- **Placeholder scan:** none found — every step has real code or a real command.
- **Type/interface consistency:** `oauth_standalone` cookie name is used consistently across Task 2 (set) and Task 3 (read); `/signed-in` route path is consistent across Task 3's redirect target and the new page's file location.
