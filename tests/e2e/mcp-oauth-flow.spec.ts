/**
 * Task 11 — full scripted OAuth 2.1 client integration test: Dynamic Client
 * Registration -> /authorize (PKCE) -> login -> consent -> token exchange ->
 * MCP `initialize` -> MCP `tools/call` (ask_agentbook, read-only query).
 *
 * This is the culmination test for the whole OAuth/MCP server plan
 * (docs/superpowers/plans/2026-07-10-agentbook-mcp-server.md) — it proves the
 * end-to-end handshake a real MCP client (Claude Desktop/Code, etc.) would
 * perform actually works against a live server, not just the individual unit
 * tests for each piece.
 *
 * Two important departures from the brief's original example code (see
 * .superpowers/sdd/task-11-brief.md), both confirmed against the *current*
 * implementation rather than assumed:
 *
 * 1. Login button text. The login form (login-form.tsx) renders a button
 *    labeled "Continue with email", not "Sign in" — the brief's
 *    `getByRole('button', { name: /sign in/i })` selector was written before
 *    that copy was finalized and would never match.
 *
 * 2. The MCP endpoint (Task 8 rework). It's no longer a stateless
 *    single-request handler: the route (apps/web-next/src/app/api/v1/mcp/
 *    route.ts) requires a real MCP session handshake on top of OAuth —
 *      a. POST an `initialize` JSON-RPC request (no `Mcp-Session-Id` header
 *         yet). The route creates a brand-new `McpServer`/
 *         `StreamableHTTPServerTransport` pair (session-store.ts) and the
 *         transport assigns its own session id, returned via the
 *         `Mcp-Session-Id` response header (confirmed against
 *         node_modules/@modelcontextprotocol/sdk's
 *         webStandardStreamableHttp.js: `onsessioninitialized` fires with
 *         the id the transport itself generated).
 *      b. POST a `notifications/initialized` notification carrying that same
 *         `Mcp-Session-Id` header, completing the MCP lifecycle handshake
 *         (spec: https://modelcontextprotocol.io/... basic/lifecycle) before
 *         any tool call. The route's session-store reuses the *same*
 *         session for this and every subsequent request with that header.
 *      c. POST the `tools/call` request, again with the same
 *         `Mcp-Session-Id` header, and the bearer access token.
 *    Every POST to `/api/v1/mcp` must also carry
 *    `Accept: application/json, text/event-stream` (the SDK's
 *    `WebStandardStreamableHTTPServerTransport.handlePostRequest` 406s
 *    otherwise) and `Content-Type: application/json`. Successful responses
 *    come back as a single Server-Sent-Events chunk
 *    (`event: message\ndata: {...}\n\n`) rather than a bare JSON body, since
 *    the route doesn't opt into the SDK's `enableJsonResponse` mode — parsed
 *    below via `parseSseJsonRpc`.
 *
 * Requires the `agentbook.mcp.enabled` DB-backed feature flag (Task 2) to be
 * on. Rather than going through the admin HTTP API (which needs an admin
 * session — see admin-feature-flags.spec.ts), this flips it directly via
 * Prisma in `beforeAll`/`afterAll`, since `isMcpEnabled()`
 * (lib/mcp/mcp-flag.ts) just reads the same `FeatureFlag` row the admin API
 * would write. Net-clean: restores whatever the flag's prior state was.
 *
 * Schema prerequisite / why this test can self-skip: the OAuth 2.1 server
 * (Phase 1 of this plan) added new tables (`OidcModel`, `McpConsentGrant`,
 * ...) to schema.prisma. This repo's shared local dev Postgres (the `naap`
 * database docker-composed at localhost:5432, used by every worktree) has
 * NOT had those tables pushed to it — doing so on that shared DB is
 * explicitly out of bounds (a live `prisma db push` diff against it reported
 * it would drop several *other* branches' in-progress tables/columns, e.g.
 * `SalesRepContractTemplate`, `AbPersonalProfile`, `AbWhatsAppLink`,
 * `AbTenantConfig.businessTags` — real data loss for other concurrent work,
 * not something `--accept-data-loss` should ever paper over). This test was
 * instead verified end-to-end against a separate, isolated database
 * (`naap_task11_verify`, same Postgres container, schema pushed fresh with
 * zero data loss since it started empty) — see task-11-report.md for the
 * exact setup. Rather than silently no-op or hard-fail when run against an
 * environment that hasn't had that migration applied (e.g. the shared `naap`
 * db, which is what every other spec in this suite targets), `beforeAll`
 * probes for the `OidcModel` table and the test cleanly `test.skip()`s with
 * an explicit reason if it's missing, instead of reporting a false
 * regression-suite failure for an environment/migration gap unrelated to
 * this test's own logic.
 */

import { test, expect } from '@playwright/test';
import crypto from 'crypto';

const MCP_FLAG_KEY = 'agentbook.mcp.enabled';
const REDIRECT_URI = 'http://localhost:9999/callback';

// Defaults to the shared playwright.config.ts baseURL (localhost:3000) like
// every other spec in this suite; set E2E_BASE_URL to point at a separate
// server backed by a schema-complete DB (see the file doc comment above).
if (process.env.E2E_BASE_URL) {
  test.use({ baseURL: process.env.E2E_BASE_URL });
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Parses a Streamable HTTP response body of the shape the SDK writes for a
 * single JSON-RPC response (`event: message\ndata: {...}\n\n` — see
 * node_modules/@modelcontextprotocol/sdk/dist/cjs/server/
 * webStandardStreamableHttp.js `writeSSEEvent`). The route never enables
 * `enableJsonResponse`, so every reply — including `initialize` — is one SSE
 * event containing exactly one JSON-RPC message.
 */
function parseSseJsonRpc(body: string): Record<string, unknown> {
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE "data:" line found in MCP response body: ${body}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

test.describe.serial('Task 11 — full OAuth 2.1 handshake + stateful MCP tool call', () => {
  let prisma: typeof import('@naap/database').prisma;
  let priorFlagEnabled: boolean | null = null; // null = row didn't exist before this test
  let schemaReady = false;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;

    // Probe for the OAuth-server schema (see file doc comment) before
    // touching anything — if it's not there, every other step in this
    // beforeAll is moot and the test itself will skip.
    try {
      await prisma.$queryRaw`SELECT 1 FROM "OidcModel" LIMIT 1`;
      schemaReady = true;
    } catch {
      schemaReady = false;
      return;
    }

    const existing = await prisma.featureFlag.findUnique({ where: { key: MCP_FLAG_KEY } });
    priorFlagEnabled = existing ? existing.enabled : null;

    await prisma.featureFlag.upsert({
      where: { key: MCP_FLAG_KEY },
      update: { enabled: true },
      create: { key: MCP_FLAG_KEY, enabled: true, description: 'e2e: mcp-oauth-flow.spec.ts' },
    });
  });

  test.afterAll(async () => {
    if (!schemaReady) return;
    if (priorFlagEnabled === null) {
      // Flag didn't exist before this test — leave it in place rather than
      // deleting, since deleting it doesn't restore "unknown" (isMcpEnabled()
      // defaults missing-row to `false` either way) and a stray disabled row
      // is harmless. Flip it back to disabled so we don't leave MCP on.
      await prisma.featureFlag.update({ where: { key: MCP_FLAG_KEY }, data: { enabled: false } });
    } else {
      await prisma.featureFlag.update({ where: { key: MCP_FLAG_KEY }, data: { enabled: priorFlagEnabled } });
    }
  });

  test('DCR -> authorize -> login -> consent -> token -> MCP initialize -> tools/call', async ({ page, request }) => {
    test.skip(
      !schemaReady,
      `DATABASE_URL (${process.env.DATABASE_URL ? 'set' : 'unset'}) points at a DB missing the ` +
        'OAuth-server schema (no "OidcModel" table) — this test needs the Task 1-10 schema pushed. ' +
        'See the file doc comment / task-11-report.md for how to stand up an isolated verify DB ' +
        'without risking `prisma db push --accept-data-loss` against the shared local Postgres.',
    );

    // 1. Dynamic Client Registration
    const reg = await request.post('/api/v1/oauth/register', {
      data: { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' },
    });
    expect(reg.ok(), await reg.text()).toBe(true);
    const { client_id } = await reg.json();
    expect(client_id).toBeTruthy();

    // Dev-mode on-demand-compilation warmup. On a freshly started `next dev`
    // process, the very first hit to each of these routes compiles it lazily
    // — including a multi-second compile of /api/v1/base/plugins/personalized
    // (confirmed live: 3.7s for ~3700 modules on a cold server). That compile
    // happens to fall exactly where the post-login redirect chain
    // (login -> agentbook -> oauth-consent, driven by auth-context.tsx's
    // `router.push('/agentbook')` racing login-form.tsx's own
    // `router.replace(redirect)`) needs client-side React state
    // (`AuthContext`'s `isAuthenticated`) to survive a client-side
    // navigation. On a cold server this reliably triggered a
    // "[Fast Refresh] rebuilding" HMR cycle mid-navigation that dropped the
    // in-memory auth state, bouncing the browser back to a blank /login form
    // instead of proceeding to /oauth-consent (reproduced directly: without
    // this warmup the test failed at the "Consent screen" assertion below
    // every time on a fresh dev server; pre-warming these exact routes via
    // plain fetches first made it pass consistently). This is a dev-server
    // cold-start artifact, not a product bug — a real client hitting a
    // warm/production deployment wouldn't see it.
    for (const path of ['/login', '/agentbook', '/oauth-consent?uid=warmup', '/api/v1/base/plugins/personalized']) {
      await request.get(path).catch(() => {});
    }

    // 2. Kick off /authorize with PKCE
    const { verifier, challenge } = pkcePair();
    const authorizeUrl = `/api/v1/oauth/authorize?response_type=code&client_id=${client_id}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&scope=agentbook:full`;
    await page.goto(authorizeUrl);

    // 3. Unauthenticated -> oidc-provider's interactions.url() always points
    // to /oauth-consent?uid=... (oauth-provider.ts); that page's own
    // server-side login gate (oauth-consent/page.tsx) is what redirects to
    // /login?redirect=... when there's no session cookie yet.
    await expect(page).toHaveURL(/\/login\?redirect=/);
    // Settle before interacting (same "2s settle" pattern used elsewhere for
    // this app's login flow — see project notes on AgentBook e2e patterns).
    // Confirmed live via a throwaway repro: without this wait, login-form.tsx's
    // Email/Password inputs intermittently hit a React 19 hydration mismatch
    // right as Playwright's `.fill()` lands (a `caret-color: transparent`
    // style diff — most likely Chromium's own autofill/password-suggestion
    // heuristic mutating the input before hydration finishes). When that
    // race is lost, the DOM value is set but the mismatch-triggered
    // re-render resets the (still server-default-`''`) controlled value
    // right back to empty *before* React's onChange ever fires, so
    // `handleSubmit` silently submits `''`/`''` — no request, no error, just
    // stuck on /login. Waiting for hydration to settle first reproducibly
    // avoids the race.
    await page.waitForTimeout(2_000);
    await page.getByLabel('Email').fill('maya@agentbook.test');
    await page.getByLabel('Password').fill('agentbook123');
    // NOTE: the brief's example used /sign in/i, but login-form.tsx's actual
    // button copy is "Continue with email".
    await page.getByRole('button', { name: /continue with email/i }).click();

    // 4. Consent screen. Register a listener for the final redirect to our
    // (nonexistent) `redirect_uri` *before* clicking "Allow" — there's no
    // real listener on localhost:9999, so that navigation will fail to
    // connect, and (confirmed live, contra the brief's original assumption)
    // Chromium does NOT update `page.url()`/the address bar for a same-tab
    // navigation whose connection is refused before any response — it stays
    // on the pre-navigation URL, silently discarding the query string we
    // need. `page.waitForRequest()` sidesteps that entirely: Playwright's
    // `request` event fires the moment the browser *initiates* the request
    // (before the connection is attempted/resolved), so we get the full URL
    // — including the `code` query param — regardless of whether the
    // connection itself ever succeeds. (An earlier attempt tried
    // `page.route(...).abort()` for the same purpose; that handler never
    // fired at all for this cross-origin final-redirect hop, confirmed live
    // — `waitForRequest` is the one that reliably does.)
    await expect(page).toHaveURL(/\/oauth-consent\?uid=/, { timeout: 15_000 });
    const callbackRequestPromise = page.waitForRequest(
      (req) => req.url().startsWith(REDIRECT_URI),
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Allow' }).click();

    // 5. Pull the authorization code out of the captured callback request.
    const callbackRequest = await callbackRequestPromise;
    const code = new URL(callbackRequest.url()).searchParams.get('code');
    expect(code, `expected an authorization code in the redirect URL, got: ${callbackRequest.url()}`).toBeTruthy();

    // 6. Exchange the code for a token
    const tokenRes = await request.post('/api/v1/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT_URI,
        client_id,
        code_verifier: verifier,
      },
    });
    expect(tokenRes.ok(), await tokenRes.text()).toBe(true);
    const { access_token } = await tokenRes.json();
    expect(access_token).toBeTruthy();

    const mcpHeaders = {
      authorization: `Bearer ${access_token}`,
      accept: 'application/json, text/event-stream',
    };

    // 7. MCP `initialize` — no Mcp-Session-Id yet; the route creates a fresh
    // session (session-store.ts `createSession`) and the transport mints its
    // own session id, echoed back via the `Mcp-Session-Id` response header.
    const initRes = await request.post('/api/v1/mcp', {
      headers: mcpHeaders,
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'task-11-e2e-client', version: '1.0.0' },
        },
      },
    });
    expect(initRes.ok(), await initRes.text()).toBe(true);
    const sessionId = initRes.headers()['mcp-session-id'];
    expect(sessionId, 'expected Mcp-Session-Id response header on initialize').toBeTruthy();

    const initBody = parseSseJsonRpc(await initRes.text());
    expect(initBody.error).toBeUndefined();
    expect((initBody.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe('agentbook');

    const sessionHeaders = { ...mcpHeaders, 'mcp-session-id': sessionId };

    // 8. Complete the MCP lifecycle handshake with `notifications/initialized`
    // (a notification, not a request -> the transport replies 202 with no
    // body) before calling any tool, per the MCP spec's basic lifecycle.
    const initializedNotifyRes = await request.post('/api/v1/mcp', {
      headers: sessionHeaders,
      data: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    });
    expect(initializedNotifyRes.status(), await initializedNotifyRes.text()).toBe(202);

    // 9. Call the MCP tool with the issued token, on the *same* session — a
    // read-only query ("top spending this month?") so `ask_agentbook`'s
    // `requiresConfirmation` branch (elicitation) never triggers; that's a
    // separate, interactive concern intentionally left to Task 12's manual
    // live-client validation.
    const mcpRes = await request.post('/api/v1/mcp', {
      headers: sessionHeaders,
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ask_agentbook', arguments: { message: 'top spending this month?' } },
      },
    });
    expect(mcpRes.ok(), await mcpRes.text()).toBe(true);

    const toolBody = parseSseJsonRpc(await mcpRes.text());
    expect(toolBody.error, `MCP tools/call returned a JSON-RPC error: ${JSON.stringify(toolBody.error)}`).toBeUndefined();
    const result = toolBody.result as { isError?: boolean; content?: { type: string; text: string }[] };
    expect(result.isError, `ask_agentbook tool returned isError with content: ${JSON.stringify(result.content)}`).not.toBe(true);
    expect(result.content?.[0]?.text).toBeTruthy();
  });
});
