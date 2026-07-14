# Tax Fast-Track MCP Parity + Deadline Reuse + Billing Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-shipped tax fast-track feature (PR-3/PR-4) reachable via MCP, connect it to the existing tax-deadline calendar system, and put new fast-track work behind a paid add-on.

**Architecture:** Fix a pre-existing self-call URL bug so the MCP tool actually reaches the backend; add one new regex-detected chat/MCP intent for draft-status queries (start/answer/cancel already work via the existing session-recovery branch); fold a deadline countdown into the already-fetched `/status` response and add one new branch to the existing deadline-alert cron; add a billing guard mirroring an existing add-on pattern exactly, called from the two routes that do new paid work.

**Tech Stack:** TypeScript, Next.js App Router (apps/web-next), Express-style route handlers in `plugins/agentbook-core/backend` (shared library code, not a running server in production), Prisma, Vitest, Playwright.

## Global Constraints

- No new Prisma models or schema migration — `BillAddOn`/`BillAddOnSubscription`/`AbCalendarEvent` all already exist.
- No dedicated MCP tool — reuse the existing single `ask_agentbook` tool.
- No push notifications on draft completion — status-checking stays pull-based.
- Gate only `/start` and `/regenerate` (HTTP) and the `start-tax-fast-track` chat skill's actual session-creation call — never `/answer`, `/cancel`, `/status`, or Step 1b's active-session branch.
- The new `TAX_DRAFT_STATUS_RE` regex must require one of the specific phrases "filing draft", "client letter", or "tax draft"/"tax fast-track draft" — never a bare `\bdraft\b`/`\bletter\b` match (collides with AgentBook's own invoice `'draft'` status).
- The annual-filing-deadline check must match both `calendar.annual_tax_filing_due` (US) and `calendar.t1_filing_due` (CA) — a single hardcoded key silently never fires for CA tenants.
- The new `bin/seed-tax-fast-track-addon.ts` seeds `isActive: true` directly (not `false`) — this feature is already live and free; seeding inactive would make `hasAddOn` deny every tenant permanently with no purchase path once the gate ships.
- Every new/changed function needs a test using this repo's existing conventions: Vitest with hand-written `dbMock`/`vi.mock()` objects (no test-container DB), Playwright for `tests/e2e/*.spec.ts` against a real (local or deployed) instance.

---

## Task 1: Fix `ask_agentbook`'s self-call URL

**Files:**
- Modify: `apps/web-next/src/lib/mcp/ask-agentbook-tool.ts`
- Test: `apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts` (existing file — add one test, don't break the other four)

**Interfaces:**
- Consumes: `getAppBaseUrl` from `@/lib/agentbook-config` (already exported, signature `(request?: NextRequest) => string`).
- Produces: nothing new — `callAgentBrain`'s exported signature is unchanged; only its internal `CORE_URL` resolution changes.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe('callAgentBrain', ...)` block in `apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts` (add the import and mock at the top of the file, alongside the existing `vi.mock('server-only', ...)`):

```ts
// Add near the top of the file, before the existing `import { callAgentBrain, AgentBrainError } from './ask-agentbook-tool';` line:
vi.mock('@/lib/agentbook-config', () => ({
  getAppBaseUrl: vi.fn(() => 'https://agentbook.brainliber.com'),
}));
```

Then add this test inside the existing `describe('callAgentBrain', ...)` block:

```ts
  it('resolves its target host via getAppBaseUrl(), not a raw localhost fallback', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, data: { message: 'ok' } }),
    });

    await callAgentBrain({ text: 'hi', tenantId: 'user-1' });

    const [url] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://agentbook.brainliber.com/api/v1/agentbook-core/agent/message');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/lib/mcp/ask-agentbook-tool.test.ts`
Expected: FAIL — the new test fails because the real file still constructs `CORE_URL` from `PLUGIN_PORTS`/`AGENTBOOK_CORE_URL`, not the mocked `getAppBaseUrl()`, so the asserted URL won't match (it will be `http://localhost:4050/api/v1/agentbook-core/agent/message` or similar).

- [ ] **Step 3: Write minimal implementation**

Replace the top of `apps/web-next/src/lib/mcp/ask-agentbook-tool.ts`:

```ts
import 'server-only';
import crypto from 'crypto';
import { getAppBaseUrl } from '@/lib/agentbook-config';

// No NextRequest available in this background/tool-call context —
// getAppBaseUrl() falls through to AGENTBOOK_HOST (set in prod), then
// VERCEL_URL, then the canonical production domain. Previously this file
// built its own CORE_URL from AGENTBOOK_CORE_URL/PLUGIN_PORTS, which falls
// back to an unreachable http://localhost:4050 in a serverless function —
// the same class of bug already fixed everywhere else via getAppBaseUrl()
// in the F4-01/F4-02 "chat self-call" incident, just never applied here.
const CORE_URL = getAppBaseUrl();
```

Remove the old line `const CORE_URL = process.env.AGENTBOOK_CORE_URL || \`http://localhost:${PLUGIN_PORTS['agentbook-core'] || DEFAULT_PORT}\`;` and its now-unused import `import { PLUGIN_PORTS, DEFAULT_PORT } from '@/lib/plugin-ports';`. Everything else in the file (the `callAgentBrain` function body, `AgentResponse`/`AgentBrainError` types) stays exactly the same — only these top lines change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/lib/mcp/ask-agentbook-tool.test.ts`
Expected: PASS (all 5 tests — the 4 pre-existing plus the new one).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/mcp/ask-agentbook-tool.ts apps/web-next/src/lib/mcp/ask-agentbook-tool.test.ts
git commit -m "fix(mcp): resolve ask_agentbook's target host via getAppBaseUrl()

AGENTBOOK_CORE_URL isn't set in prod, so the old fallback to
http://localhost:4050 made every ask_agentbook call unreachable in a
serverless function — same bug class as the F4-01/F4-02 chat self-call
fix, just never applied to this file."
```

---

## Task 2: Shared draft-staleness + latest-session helpers, dedup into existing routes

**Files:**
- Modify: `plugins/agentbook-core/backend/src/tax-questionnaire-session.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-session.test.ts` (existing file — add new `describe` blocks)
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts` (existing file — no test changes needed; this task is a pure refactor, same behavior)

**Interfaces:**
- Produces: `getLatestTaxQuestionnaireSession(tenantId: string): Promise<any | null>` and `isDraftStale(draftRow: { status: string; updatedAt: Date } | null): boolean`, both exported from `plugins/agentbook-core/backend/src/tax-questionnaire-session.ts` — Task 3 imports both, Task 6 does not need them.
- Consumes: nothing new (uses the same `db` from `./db/client.js` already imported in this file).

- [ ] **Step 1: Write the failing tests**

Add to `plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-session.test.ts`, after the existing `describe('getActiveTaxQuestionnaireSession', ...)` block:

```ts
describe('getLatestTaxQuestionnaireSession', () => {
  it('queries by tenantId only (no status/expiry filter) ordered by createdAt desc', async () => {
    const fakeSession = { id: 'tqs-latest', tenantId: 'tenant-A', status: 'completed' };
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(fakeSession);
    const { getLatestTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    const result = await getLatestTaxQuestionnaireSession('tenant-A');

    expect(result).toEqual(fakeSession);
    expect(dbMock.abTaxQuestionnaireSession.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-A' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns null when the tenant has never started a session', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    const { getLatestTaxQuestionnaireSession } = await import('../tax-questionnaire-session.js');

    const result = await getLatestTaxQuestionnaireSession('tenant-B');

    expect(result).toBeNull();
  });
});

describe('isDraftStale', () => {
  it('returns false for a null draft row', async () => {
    const { isDraftStale } = await import('../tax-questionnaire-session.js');
    expect(isDraftStale(null)).toBe(false);
  });

  it('returns false for a ready draft, regardless of age', async () => {
    const { isDraftStale } = await import('../tax-questionnaire-session.js');
    expect(isDraftStale({ status: 'ready', updatedAt: new Date(Date.now() - 10 * 60 * 1000) })).toBe(false);
  });

  it('returns false for a pending draft within the 2-minute window', async () => {
    const { isDraftStale } = await import('../tax-questionnaire-session.js');
    expect(isDraftStale({ status: 'pending', updatedAt: new Date() })).toBe(false);
  });

  it('returns true for a pending draft past the 2-minute window', async () => {
    const { isDraftStale } = await import('../tax-questionnaire-session.js');
    expect(isDraftStale({ status: 'pending', updatedAt: new Date(Date.now() - 3 * 60 * 1000) })).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-questionnaire-session.test.ts`
Expected: FAIL — `getLatestTaxQuestionnaireSession` and `isDraftStale` are not exported from `tax-questionnaire-session.ts` yet.

- [ ] **Step 3: Write minimal implementation**

Add to the end of `plugins/agentbook-core/backend/src/tax-questionnaire-session.ts` (after the existing `updateTaxQuestionnaireSession` function):

```ts
// ─── getLatestTaxQuestionnaireSession ───────────────────────────────────────

/**
 * The tenant's most recent session regardless of status — unlike
 * getActiveTaxQuestionnaireSession, which only ever returns an in-progress,
 * non-expired one. Used to check whether a *completed* session's draft is
 * ready (PR-5's chat/MCP draft-status intent, and the dedicated /status
 * route both need this same read).
 */
export async function getLatestTaxQuestionnaireSession(tenantId: string): Promise<any | null> {
  return db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

// ─── isDraftStale ────────────────────────────────────────────────────────────

const STALE_PENDING_MS = 2 * 60 * 1000;

/**
 * A killed after() invocation (the function was frozen mid-generation)
 * leaves an AbTaxFastTrackDraft row 'pending' forever with nothing to flip
 * it to 'failed'. Flag it as stale past a fixed timeout so callers (the
 * /status route, the /regenerate route, and PR-5's chat/MCP status intent)
 * can all offer a retry instead of waiting forever — one shared
 * computation instead of three copies of the same constant + comparison.
 */
export function isDraftStale(draftRow: { status: string; updatedAt: Date } | null): boolean {
  if (!draftRow) return false;
  return draftRow.status === 'pending' && Date.now() - draftRow.updatedAt.getTime() > STALE_PENDING_MS;
}
```

Now update `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts` to use `isDraftStale` instead of its own inline `STALE_PENDING_MS` computation. Replace the whole file with:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_PENDING_MS = 2 * 60 * 1000; // kept here too — used below for the session-level (no-draft-row) synthesis, which isDraftStale doesn't cover

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const session = await db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    return NextResponse.json({ success: true, data: { session: null, draft: null } });
  }

  const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: session.id } });
  let draft = draftRow
    ? {
      status: draftRow.status,
      draftPdfUrl: draftRow.draftPdfUrl,
      letterPdfUrl: draftRow.letterPdfUrl,
      draftSummary: draftRow.draftSummary,
      errorMsg: draftRow.errorMsg,
      stale: isDraftStale(draftRow),
    }
    : null;

  // A killed after() invocation can also die BEFORE its first DB write —
  // i.e. before the row-creating upsert ever runs — leaving no
  // AbTaxFastTrackDraft row at all. In that case `draft` above is null and
  // there is no staleness signal, so the UI polls "Generating..." forever
  // with no retry option. Synthesize a stale-pending draft once the session
  // itself has sat 'completed' (which is when generation should have
  // started) for longer than the same timeout used for stale draft rows.
  if (!draft && session.status === 'completed' && Date.now() - session.updatedAt.getTime() > STALE_PENDING_MS) {
    draft = {
      status: 'pending',
      draftPdfUrl: null,
      letterPdfUrl: null,
      draftSummary: null,
      errorMsg: null,
      stale: true,
    };
  }

  return NextResponse.json({
    success: true,
    data: {
      session: {
        id: session.id, status: session.status, qaHistory: session.qaHistory, askedCount: session.askedCount,
      },
      draft,
    },
  });
}
```

(This is a pure refactor — the `stale: draftRow.status === 'pending' && Date.now() - draftRow.updatedAt.getTime() > STALE_PENDING_MS` line becomes `stale: isDraftStale(draftRow)`, same computation. The session-level synthesis block below it is untouched since `isDraftStale` only takes a draft row, not a session.)

Now update `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts` the same way — replace the whole file with:

```ts
import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale } from '@agentbook-core/tax-questionnaire-session';
import { callGemini } from '@agentbook-core/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => ({}));
  const sessionId = String(body.sessionId ?? '');
  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'sessionId required' }, { status: 400 });
  }

  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session || session.tenantId !== tenantId || session.status !== 'completed') {
    return NextResponse.json({ success: false, error: 'session not eligible for regeneration' }, { status: 400 });
  }

  const draft = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId } });
  const isStale = isDraftStale(draft);
  if (draft && draft.status !== 'failed' && !isStale) {
    return NextResponse.json({ success: false, error: `draft is '${draft.status}', not eligible for regeneration` }, { status: 400 });
  }

  after(() => generateFilingDraft(sessionId, callGemini).catch((err) => {
    console.error('[tax-fast-track/regenerate] generateFilingDraft failed:', err);
  }));

  return NextResponse.json({ success: true, data: { status: 'pending' } });
}
```

(Same refactor: `const isStale = !!draft && draft.status === 'pending' && Date.now() - draft.updatedAt.getTime() > STALE_PENDING_MS;` becomes `const isStale = isDraftStale(draft);` — `isDraftStale` already handles the null-safety `!!draft` check internally.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-questionnaire-session.test.ts`
Expected: PASS (all tests, including the 4 new ones).

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`
Expected: PASS — all existing tests still pass unchanged (this task doesn't change either route's observable behavior, only where the staleness computation lives). If `@agentbook-core/tax-questionnaire-session` isn't already mocked in this test file for the `isDraftStale` import to resolve under Vitest, add this mock near the file's other `vi.mock()` calls (it needs to return the REAL `isDraftStale` so behavior stays identical — not a stub):

```ts
vi.mock('@agentbook-core/tax-questionnaire-session', async () => {
  const actual = await vi.importActual<typeof import('@agentbook-core/tax-questionnaire-session')>('@agentbook-core/tax-questionnaire-session');
  return { ...actual, getActiveTaxQuestionnaireSession: sessionHelpersMock.getActiveTaxQuestionnaireSession };
});
```

(Replacing the existing `vi.mock('@agentbook-core/tax-questionnaire-session', () => sessionHelpersMock);` line — same mocked `getActiveTaxQuestionnaireSession`, but now also exposes the real `isDraftStale`/`getLatestTaxQuestionnaireSession` instead of `undefined`.)

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/tax-questionnaire-session.ts \
  plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-session.test.ts \
  apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts \
  apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts \
  apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts
git commit -m "refactor(tax-fast-track): extract getLatestTaxQuestionnaireSession + isDraftStale

Shared helpers so the /status route, /regenerate route, and PR-5's new
chat/MCP draft-status intent (Task 3) all use the same staleness
computation instead of three copies of the same constant + comparison.
Pure refactor — no behavior change in either existing route."
```

---

## Task 3: Chat/MCP draft-status intent

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/agent-brain.test.ts` (existing file — check it exists; if the exact filename differs, find it with `find plugins/agentbook-core/backend/src/__tests__ -iname "*agent-brain*"` and add to whichever file already tests Step 1b's tax-questionnaire branch)

**Interfaces:**
- Consumes: `getLatestTaxQuestionnaireSession`, `isDraftStale` from `./tax-questionnaire-session.js` (Task 2); `db.abTaxFastTrackDraft` from `./db/client.js` (already imported as `db` in this file); `buildResponse` (already defined in this file, `(data: AgentResponse['data']) => AgentResponse`).
- Produces: nothing new exported — this is an internal branch inside `handleAgentMessage`.

- [ ] **Step 1: Write the failing tests**

First find the right test file:

Run: `find plugins/agentbook-core/backend/src/__tests__ -iname "*agent-brain*"`

Add these tests to whichever file already covers Step 1b (look for a `describe` block mentioning `'Step 1b'` or `'tax questionnaire'` or `'TAX_QUESTIONNAIRE_CANCEL_RE'` — add a new `describe('tax draft status intent (Step 1c)', ...)` block near it, using that file's existing `dbMock`/`vi.mock()` setup for `db.abTaxQuestionnaireSession`/`db.abTaxFastTrackDraft`):

```ts
describe('tax draft status intent (Step 1c)', () => {
  beforeEach(() => {
    // No active in-progress session for any of these tests — that's Step
    // 1b's branch (already tested elsewhere in this file); this intent
    // only evaluates once Step 1b has NOT already claimed the reply.
    dbMock.abTaxQuestionnaireSession.findFirst
      .mockImplementation(async (args: any) => (args?.where?.status === 'in_progress' ? null : null));
  });

  it('matches "is my filing draft ready" and returns both PDF links when the draft is ready', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'ready', draftPdfUrl: 'https://x/draft.pdf', letterPdfUrl: 'https://x/letter.pdf',
      draftSummary: { caveat: 'Estimate only.' }, errorMsg: null, updatedAt: new Date(),
    });
    const { handleAgentMessage } = await import('../agent-brain.js');

    const result = await handleAgentMessage(
      { text: 'is my filing draft ready?', tenantId: 'tenant-A', channel: 'mcp' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    expect(result.data.message).toContain('https://x/draft.pdf');
    expect(result.data.message).toContain('https://x/letter.pdf');
  });

  it('matches "check my client letter" (a different one of the three intended phrasings)', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-2', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'ready', draftPdfUrl: 'https://x/draft.pdf', letterPdfUrl: 'https://x/letter.pdf',
      draftSummary: { caveat: 'Estimate only.' }, errorMsg: null, updatedAt: new Date(),
    });
    const { handleAgentMessage } = await import('../agent-brain.js');

    const result = await handleAgentMessage(
      { text: 'check my client letter', tenantId: 'tenant-A', channel: 'web' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    expect(result.data.message).toContain('https://x/letter.pdf');
  });

  it('does NOT match "check my invoice draft" — must not hijack invoice messages', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-3', status: 'completed' });
    const { handleAgentMessage } = await import('../agent-brain.js');

    const result = await handleAgentMessage(
      { text: 'check my invoice draft', tenantId: 'tenant-A', channel: 'web' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    // Falls through to normal classification instead — draft row is never queried.
    expect(dbMock.abTaxFastTrackDraft.findUnique).not.toHaveBeenCalled();
  });

  it('returns a still-generating message when the draft row is pending and not stale', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-4', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date(), errorMsg: null });
    const { handleAgentMessage } = await import('../agent-brain.js');

    const result = await handleAgentMessage(
      { text: 'is my tax draft ready', tenantId: 'tenant-A', channel: 'web' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    expect(result.data.message.toLowerCase()).toContain('still generating');
  });

  it('returns a stuck/retry message when the draft row is pending and past the staleness timeout', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-5', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'pending', updatedAt: new Date(Date.now() - 3 * 60 * 1000), errorMsg: null,
    });
    const { handleAgentMessage } = await import('../agent-brain.js');

    const result = await handleAgentMessage(
      { text: 'is my tax draft ready', tenantId: 'tenant-A', channel: 'web' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    expect(result.data.message.toLowerCase()).toContain('stuck');
  });

  it('returns the categorized failure message when the draft failed', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-6', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'failed', errorMsg: 'pdf_render_failed', updatedAt: new Date(),
    });
    const { handleAgentMessage } = await import('../agent-brain.js');

    const result = await handleAgentMessage(
      { text: 'is my tax draft ready', tenantId: 'tenant-A', channel: 'web' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    expect(result.data.message).toContain('pdf_render_failed');
  });

  it('falls through to normal classification when no completed session exists at all', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    const { handleAgentMessage } = await import('../agent-brain.js');

    await handleAgentMessage(
      { text: 'is my tax draft ready', tenantId: 'tenant-A', channel: 'web' },
      { callGemini: vi.fn(), baseUrls: {} } as any,
    );

    expect(dbMock.abTaxFastTrackDraft.findUnique).not.toHaveBeenCalled();
  });
});
```

If the file's existing `dbMock` doesn't already have `abTaxFastTrackDraft: { findUnique: vi.fn() }`, add it alongside the existing `abTaxQuestionnaireSession` mock entry.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/agent-brain.test.ts` (substitute the real filename found above)
Expected: FAIL — the new intent doesn't exist yet, so these messages fall through to normal LLM classification and none of the assertions about `draftPdfUrl`/`still generating`/etc. hold.

- [ ] **Step 3: Write minimal implementation**

In `plugins/agentbook-core/backend/src/agent-brain.ts`, update the import line for session helpers:

```ts
import { getActiveTaxQuestionnaireSession, getLatestTaxQuestionnaireSession, isDraftStale } from './tax-questionnaire-session.js';
```

Add the new regex constant next to the existing `TAX_QUESTIONNAIRE_CANCEL_RE` definition (around line 204):

```ts
// Deliberately narrow — must name the feature specifically ("filing draft",
// "client letter", or "tax draft"/"tax fast-track draft"), not just "draft"
// or "letter" alone. AgentBook invoices have their own real 'draft' status
// ("check my invoice draft") — a bare \bdraft\b match would hijack those
// messages for any tenant who's ever completed a tax questionnaire.
const TAX_DRAFT_STATUS_RE = /\b(filing draft|client letter|tax (fast.?track )?draft)\b/i;
```

Add the new `buildTaxDraftStatusResponse` helper right after the existing `translateTaxCoreResult` function (around line 474, after its closing `}`):

```ts
/** Chat/MCP equivalent of GET /tax-fast-track/status's draft-shape translation — same four states the UI's FastTrackTab.tsx already renders, as chat text instead of UI cards. */
function buildTaxDraftStatusResponse(
  draftRow: { status: string; draftPdfUrl: string | null; letterPdfUrl: string | null; draftSummary: unknown; errorMsg: string | null; updatedAt: Date } | null,
  startTime: number,
): AgentResponse {
  if (!draftRow || (draftRow.status === 'pending' && !isDraftStale(draftRow))) {
    return buildResponse({
      message: "Your filing draft is still generating — check back in a few minutes.",
      skillUsed: 'tax-draft-status', confidence: 1, latencyMs: Date.now() - startTime,
    });
  }
  if (draftRow.status === 'pending' && isDraftStale(draftRow)) {
    return buildResponse({
      message: "Generation seems stuck. Open the Tax Fast-Track tab in the app and tap \"Try again\" to regenerate it.",
      skillUsed: 'tax-draft-status', confidence: 1, latencyMs: Date.now() - startTime,
    });
  }
  if (draftRow.status === 'ready') {
    const caveat = (draftRow.draftSummary as { caveat?: string } | null)?.caveat ?? '';
    return buildResponse({
      message: `Your filing draft is ready!\n\nFiling draft: ${draftRow.draftPdfUrl}\nClient letter: ${draftRow.letterPdfUrl}\n\n${caveat}`,
      skillUsed: 'tax-draft-status', confidence: 1, latencyMs: Date.now() - startTime,
    });
  }
  // 'failed'
  return buildResponse({
    message: `Something went wrong generating your draft (${draftRow.errorMsg}). Open the Tax Fast-Track tab in the app and tap "Try again" to regenerate it.`,
    skillUsed: 'tax-draft-status', confidence: 1, latencyMs: Date.now() - startTime,
  });
}
```

Now add the new branch inside `handleAgentMessage`, immediately after Step 1b's existing `if (tqSession) { ... }` block and before the `// ── Step 2: Context assembly ──` comment:

```ts
  // ── Step 1c: Tax draft/letter status (chat + MCP parity, PR-5) ────────
  // Only reachable once Step 1b above did NOT already claim the reply —
  // i.e. there is no *active* (in-progress) session. A tenant mid-
  // questionnaire always has their plain text treated as an answer,
  // matching PR-3's existing contract; this intent only fires once a
  // session has already reached 'completed' and the questionnaire itself
  // is done.
  if (TAX_DRAFT_STATUS_RE.test(text.trim())) {
    const latest = await getLatestTaxQuestionnaireSession(tenantId);
    if (latest?.status === 'completed') {
      const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: latest.id } });
      return buildTaxDraftStatusResponse(draftRow, startTime);
    }
    // No completed session at all — fall through to normal classification,
    // same as any other unrecognized message.
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/agent-brain.test.ts` (real filename)
Expected: PASS — all 7 new tests plus every pre-existing test in the file (this change only adds a new branch; it doesn't touch Step 1b, Step 2, or anything else in the pipeline).

Run the full backend test suite to confirm no other test regressed: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: PASS (same pass count as before this task, plus the 7 new tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/__tests__/agent-brain.test.ts
git commit -m "feat(tax-fast-track): chat/MCP draft-status intent

Start/answer/cancel already work over MCP via Step 1b's existing
tenant-keyed session lookup (verified, no code needed). The one real
gap was draft/letter status once a session completes — Step 1b stops
matching a completed session, so there was no way to ask 'is my draft
ready' via chat or MCP; the PDF links only existed via the dedicated
/status route. New Step 1c adds a narrowly-scoped intent (must name
'filing draft'/'client letter'/'tax draft' specifically — a bare
\\bdraft\\b match would collide with AgentBook's own invoice 'draft'
status) that reuses the same read /status already does."
```

---

## Task 4: Deadline countdown — fold into the existing `/status` response

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts`
- Modify: `plugins/agentbook-tax/frontend/src/pages/FastTrackTab.tsx`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts` (existing file — extend the `describe('GET /tax-fast-track/status', ...)` block)

**Interfaces:**
- Produces: `ANNUAL_FILING_DEADLINE_KEYS: string[]` exported from `status/route.ts` — Task 5 imports this same constant into the cron route so both call sites recognize the identical set of jurisdiction-specific keys.
- Consumes: `db.abCalendarEvent` (already available via `@naap/database`'s `prisma` export, no new import needed beyond what `status/route.ts` already has).

- [ ] **Step 1: Write the failing test**

Add to the `describe('GET /tax-fast-track/status', ...)` block in `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`. First add `abCalendarEvent: { findFirst: vi.fn(async () => null as any) }` to the file's existing `dbMock` object, then add:

```ts
  it('includes nextDeadline when an upcoming annual_tax_filing_due event exists (US)', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    dbMock.abCalendarEvent.findFirst.mockResolvedValue({
      titleKey: 'calendar.annual_tax_filing_due', date: new Date('2027-04-15T00:00:00.000Z'),
    });
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();

    expect(json.data.nextDeadline).toEqual({ date: '2027-04-15T00:00:00.000Z', titleKey: 'calendar.annual_tax_filing_due' });
    expect(dbMock.abCalendarEvent.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-A', titleKey: { in: ['calendar.annual_tax_filing_due', 'calendar.t1_filing_due'] }, date: { gte: expect.any(Date) } },
      orderBy: { date: 'asc' },
    });
  });

  it('includes nextDeadline for a CA tenant\'s t1_filing_due event too', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    dbMock.abCalendarEvent.findFirst.mockResolvedValue({
      titleKey: 'calendar.t1_filing_due', date: new Date('2027-04-30T00:00:00.000Z'),
    });
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();

    expect(json.data.nextDeadline).toEqual({ date: '2027-04-30T00:00:00.000Z', titleKey: 'calendar.t1_filing_due' });
  });

  it('sets nextDeadline to null when no upcoming deadline event exists', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    dbMock.abCalendarEvent.findFirst.mockResolvedValue(null);
    const { GET } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();

    expect(json.data.nextDeadline).toBeNull();
  });
```

Note: since `!session` currently short-circuits with `return NextResponse.json({ success: true, data: { session: null, draft: null } });` before any deadline lookup, and these three new tests all use `session: null` (no active/completed session — matching the "intro screen" scenario the countdown is for), the implementation must move the `nextDeadline` lookup to run even in that early-return branch. Write the tests exactly as above (asserting on the `session: null` response) — this is the correct target behavior, not a mistake to fix later.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`
Expected: FAIL — `json.data.nextDeadline` is `undefined` (the field doesn't exist yet), and `dbMock.abCalendarEvent.findFirst` is never called.

- [ ] **Step 3: Write minimal implementation**

Replace `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts` with:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_PENDING_MS = 2 * 60 * 1000;

// The "annual filing due" event is titled differently per jurisdiction
// pack — us/calendar-deadlines.ts uses calendar.annual_tax_filing_due,
// ca/calendar-deadlines.ts uses calendar.t1_filing_due (no
// annual_tax_filing_due key exists for CA at all). Fast-track only
// supports us/ca, so this two-entry list covers it — each key is already
// unambiguous to its own jurisdiction, no tenant ever has both. Shared
// with cron/calendar-check/route.ts (Task 5) so both call sites recognize
// the identical set.
export const ANNUAL_FILING_DEADLINE_KEYS = ['calendar.annual_tax_filing_due', 'calendar.t1_filing_due'];

async function findNextDeadline(tenantId: string) {
  const event = await db.abCalendarEvent.findFirst({
    where: { tenantId, titleKey: { in: ANNUAL_FILING_DEADLINE_KEYS }, date: { gte: new Date() } },
    orderBy: { date: 'asc' },
  });
  return event ? { date: event.date.toISOString(), titleKey: event.titleKey } : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const session = await db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });

  const nextDeadline = await findNextDeadline(tenantId);

  if (!session) {
    return NextResponse.json({ success: true, data: { session: null, draft: null, nextDeadline } });
  }

  const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: session.id } });
  let draft = draftRow
    ? {
      status: draftRow.status,
      draftPdfUrl: draftRow.draftPdfUrl,
      letterPdfUrl: draftRow.letterPdfUrl,
      draftSummary: draftRow.draftSummary,
      errorMsg: draftRow.errorMsg,
      stale: isDraftStale(draftRow),
    }
    : null;

  if (!draft && session.status === 'completed' && Date.now() - session.updatedAt.getTime() > STALE_PENDING_MS) {
    draft = {
      status: 'pending',
      draftPdfUrl: null,
      letterPdfUrl: null,
      draftSummary: null,
      errorMsg: null,
      stale: true,
    };
  }

  return NextResponse.json({
    success: true,
    data: {
      session: {
        id: session.id, status: session.status, qaHistory: session.qaHistory, askedCount: session.askedCount,
      },
      draft,
      nextDeadline,
    },
  });
}
```

Now update `plugins/agentbook-tax/frontend/src/pages/FastTrackTab.tsx`. Add `nextDeadline` to the `StatusResponse` interface:

```ts
interface StatusResponse {
  session: { id: string; status: string; qaHistory: QaPair[]; askedCount: number } | null;
  draft: {
    status: string;
    draftPdfUrl: string | null;
    letterPdfUrl: string | null;
    draftSummary: {
      estimatedTotalIncomeCents?: number;
      estimatedTaxableIncomeCents?: number;
      estimatedTaxPayableCents?: number;
      taxPayableDeltaVsLastYearCents?: number;
      changesFromLastYear: string[];
      openQuestions: string[];
      caveat: string;
    } | null;
    errorMsg: string | null;
    stale: boolean;
  } | null;
  nextDeadline: { date: string; titleKey: string } | null;
}
```

Add a `daysAway` formatting helper near the existing `fmtMoney` helper:

```ts
const fmtDeadline = (iso: string): string => {
  const d = new Date(iso);
  const daysAway = Math.round((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return `${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} — ${daysAway} day${daysAway === 1 ? '' : 's'} away`;
};
```

Add the countdown to Screen 1 (no active session) — insert it right above the existing "Start" button paragraph:

```tsx
      {/* Screen 1: no active session, no draft */}
      {!session && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          {data?.nextDeadline && (
            <p className="text-xs text-muted-foreground mb-3">Filing deadline: {fmtDeadline(data.nextDeadline.date)}</p>
          )}
          <p className="text-sm text-muted-foreground mb-4">
```

(Only the new `{data?.nextDeadline && (...)}` block is added — the rest of Screen 1's JSX, including the closing tags, is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`
Expected: PASS — all pre-existing tests plus the 3 new ones. (The pre-existing tests that don't set `dbMock.abCalendarEvent.findFirst` will get the mock's default `async () => null`, so their `data.nextDeadline` will be `null` — this doesn't break their existing assertions since none of them assert on `nextDeadline`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts \
  plugins/agentbook-tax/frontend/src/pages/FastTrackTab.tsx \
  apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts
git commit -m "feat(tax-fast-track): filing-deadline countdown on the intro screen

Folds into the /status response FastTrackTab.tsx already fetches
unconditionally on mount, instead of a second round-trip. Matches both
jurisdiction packs' differently-named annual-deadline event
(calendar.annual_tax_filing_due for us, calendar.t1_filing_due for ca)."
```

---

## Task 5: Proactive deadline nudge + tab deep-link fix

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook/cron/calendar-check/route.ts`
- Modify: `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook/cron/calendar-check-route.test.ts` (existing file — mocks `@naap/database`'s `prisma` with individual per-method `vi.fn()`s like `abCalendarEventFindMany`/`abTenantConfigFindMany`, a `req()` helper, and `createNotification`/`reportError` module mocks)

**Interfaces:**
- Consumes: `ANNUAL_FILING_DEADLINE_KEYS` from `../tax-fast-track/status/route` (Task 4) — re-exported so the cron doesn't duplicate the two-entry list.

- [ ] **Step 1: Write the failing tests**

The real test file is `apps/web-next/src/__tests__/api/v1/agentbook/cron/calendar-check-route.test.ts`. It mocks `@naap/database`'s `prisma` object directly with individual `vi.fn()`s per model method (e.g. `abTenantConfigFindMany`, `abCalendarEventFindMany`), a `req()` helper (not `makeRequest()`), and `createNotification`/`reportError` module mocks. Add two new mock functions and two new `prisma` model entries to its existing `vi.mock('@naap/database', ...)` block:

```ts
const abPastTaxFilingFindFirst = vi.fn();
const abTaxQuestionnaireSessionFindFirst = vi.fn();

// Add abPastTaxFiling and abTaxQuestionnaireSession to the existing prisma
// object inside vi.mock('@naap/database', () => ({ prisma: { ... } })):
//   abPastTaxFiling: { findFirst: (...a: unknown[]) => abPastTaxFilingFindFirst(...a) },
//   abTaxQuestionnaireSession: { findFirst: (...a: unknown[]) => abTaxQuestionnaireSessionFindFirst(...a) },
```

Add both new mocks' reset + default resolved value to the existing `beforeEach`:

```ts
  abPastTaxFilingFindFirst.mockReset();
  abTaxQuestionnaireSessionFindFirst.mockReset();
  abPastTaxFilingFindFirst.mockResolvedValue(null);
  abTaxQuestionnaireSessionFindFirst.mockResolvedValue(null);
```

Add this new `describe` block at the end of the file:

```ts
describe('fast-track proactive nudge (PR-5)', () => {
  function deadlineEvent(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'evt-1', tenantId: 'tenant-A', eventType: 'tax_deadline', titleKey: 'calendar.annual_tax_filing_due',
      date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), leadTimeDays: [7, 3, 1, 0], urgency: 'critical',
      actionUrl: null, actionLabelKey: null, status: 'upcoming',
      ...overrides,
    };
  }

  it('fires the fast-track-specific notification (not the generic one) for a US tenant with a confirmed prior filing and no existing session', async () => {
    abCalendarEventFindMany.mockResolvedValue([deadlineEvent()]);
    abPastTaxFilingFindFirst.mockResolvedValue({ id: 'filing-1', status: 'confirmed' });
    abTaxQuestionnaireSessionFindFirst.mockResolvedValue(null);

    await GET(req());

    expect(createNotification).toHaveBeenCalledTimes(1);
    const call = createNotification.mock.calls[0][0];
    expect(call.ctaUrl).toBe('/agentbook/tax-package?tab=fast-track');
    expect(call.title).toBe('Get a head start on your filing');
  });

  it('fires for a CA tenant\'s t1_filing_due event too (regression coverage for the jurisdiction-key fix)', async () => {
    abCalendarEventFindMany.mockResolvedValue([deadlineEvent({ id: 'evt-2', tenantId: 'tenant-B', titleKey: 'calendar.t1_filing_due' })]);
    abPastTaxFilingFindFirst.mockResolvedValue({ id: 'filing-2', status: 'confirmed' });
    abTaxQuestionnaireSessionFindFirst.mockResolvedValue(null);

    await GET(req());

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0].ctaUrl).toBe('/agentbook/tax-package?tab=fast-track');
  });

  it('falls back to the generic notification when there is no confirmed prior filing', async () => {
    abCalendarEventFindMany.mockResolvedValue([deadlineEvent({ id: 'evt-3', tenantId: 'tenant-C' })]);
    abPastTaxFilingFindFirst.mockResolvedValue(null);

    await GET(req());

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0].title).not.toBe('Get a head start on your filing');
  });

  it('sends neither notification when a session already exists for that tax year', async () => {
    abCalendarEventFindMany.mockResolvedValue([deadlineEvent({ id: 'evt-4', tenantId: 'tenant-D' })]);
    abPastTaxFilingFindFirst.mockResolvedValue({ id: 'filing-4', status: 'confirmed' });
    abTaxQuestionnaireSessionFindFirst.mockResolvedValue({ id: 'existing-session' });

    await GET(req());

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0].title).not.toBe('Get a head start on your filing');
  });

  it('does not fire the fast-track nudge for a quarterly deadline event', async () => {
    abCalendarEventFindMany.mockResolvedValue([deadlineEvent({ id: 'evt-5', tenantId: 'tenant-E', titleKey: 'calendar.q1_estimated_tax_due' })]);

    await GET(req());

    expect(abPastTaxFilingFindFirst).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0].title).not.toBe('Get a head start on your filing');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron/calendar-check-route.test.ts`
Expected: FAIL — the new branch doesn't exist yet, so every event just gets the generic notification (`createNotification.mock.calls[0][0].title` is never `'Get a head start on your filing'`, and `abPastTaxFilingFindFirst` is never called).

- [ ] **Step 3: Write minimal implementation**

In `apps/web-next/src/app/api/v1/agentbook/cron/calendar-check/route.ts`, add an import using this app's `@/*` → `./src/*` tsconfig alias (verified against `apps/web-next/tsconfig.json`) rather than a relative path, since the two route files are 3 directories apart and a relative path is easy to miscount:

```ts
import { ANNUAL_FILING_DEADLINE_KEYS } from '@/app/api/v1/agentbook-core/tax-fast-track/status/route';
```

Replace the existing block:

```ts
      if (event.eventType === 'tax_deadline') {
        try {
          await createNotification({
            category: 'tax_deadline',
            severity: severityForUrgency(event.urgency),
            title,
            body: `Due ${event.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`,
            ctaLabel: event.actionLabelKey ? 'Take action' : 'View calendar',
            ctaUrl: event.actionUrl ?? '/agentbook/tax',
            createdByType: 'system',
            createdBy: 'calendar-check-cron',
            audienceType: 'single',
            audienceFilter: { tenantId: event.tenantId },
          });
        } catch (err) {
          reportError(`cron/calendar-check notification failed for event ${event.id}`, err, { source: 'cron/calendar-check' });
        }
      }

      alertsFired++;
```

with:

```ts
      let fastTrackNudgeSent = false;
      if (event.eventType === 'tax_deadline' && ANNUAL_FILING_DEADLINE_KEYS.includes(event.titleKey)) {
        // Wrapped the same way the generic notification below is — an
        // exception here must not abort the rest of upcomingEvents
        // (unrelated tenants' quarterly/other events still need to
        // process in this batch).
        try {
          const [priorFiling, existingSession] = await Promise.all([
            db.abPastTaxFiling.findFirst({ where: { tenantId: event.tenantId, status: 'confirmed' } }),
            db.abTaxQuestionnaireSession.findFirst({ where: { tenantId: event.tenantId, taxYear: event.date.getUTCFullYear() - 1 } }),
          ]);
          if (priorFiling && !existingSession) {
            await createNotification({
              category: 'tax_deadline',
              severity: 'warning',
              title: 'Get a head start on your filing',
              body: `Your filing deadline is ${event.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. Start the fast-track review now — it only takes a few minutes.`,
              ctaLabel: 'Start now',
              ctaUrl: '/agentbook/tax-package?tab=fast-track',
              createdByType: 'system',
              createdBy: 'calendar-check-cron',
              audienceType: 'single',
              audienceFilter: { tenantId: event.tenantId },
            });
            fastTrackNudgeSent = true;
          }
        } catch (err) {
          reportError(`cron/calendar-check fast-track nudge failed for event ${event.id}`, err, { source: 'cron/calendar-check' });
        }
      }
      if (event.eventType === 'tax_deadline' && !fastTrackNudgeSent) {
        try {
          await createNotification({
            category: 'tax_deadline',
            severity: severityForUrgency(event.urgency),
            title,
            body: `Due ${event.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`,
            ctaLabel: event.actionLabelKey ? 'Take action' : 'View calendar',
            ctaUrl: event.actionUrl ?? '/agentbook/tax',
            createdByType: 'system',
            createdBy: 'calendar-check-cron',
            audienceType: 'single',
            audienceFilter: { tenantId: event.tenantId },
          });
        } catch (err) {
          reportError(`cron/calendar-check notification failed for event ${event.id}`, err, { source: 'cron/calendar-check' });
        }
      }

      alertsFired++;
```

Now fix the tab deep-link in `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx`. Replace:

```ts
  const [tab, setTab] = useState<'package' | 'past' | 'fast-track'>(
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('tab') === 'past'
      ? 'past'
      : 'package',
  );
```

with:

```ts
  const [tab, setTab] = useState<'package' | 'past' | 'fast-track'>(() => {
    if (typeof window === 'undefined') return 'package';
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested === 'past' || requested === 'fast-track' ? requested : 'package';
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron/calendar-check-route.test.ts`
Expected: PASS — all 5 new tests, plus every pre-existing test in the file unchanged (events with `eventType !== 'tax_deadline'` or non-deadline `titleKey`s never enter either new branch).

Run the full cron test suite once more: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/cron`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/cron/calendar-check/route.ts \
  plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx \
  apps/web-next/src/__tests__/api/v1/agentbook/cron/*.test.ts
git commit -m "feat(tax-fast-track): proactive deadline nudge + fast-track tab deep-link

Reuses the existing calendar-check cron's already-seeded AbCalendarEvent
rows — no new deadline computation. Suggests starting the fast-track
review (instead of the generic 'Due April 15' notification) only when
a confirmed prior filing exists and no session already does. Also
fixes TaxPackage.tsx's ?tab= param, which only recognized 'past' before
this, so the new notification's CTA actually lands on the right tab."
```

---

## Task 6: Billing gate — guard + call sites

**Files:**
- Create: `apps/web-next/src/lib/agentbook-tax-fast-track/guard.ts`
- Test: `apps/web-next/src/lib/agentbook-tax-fast-track/guard.test.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/start/route.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts`
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts` (existing file — update `/start` and `/regenerate` describe blocks)
- Test: `plugins/agentbook-core/backend/src/__tests__/start-tax-fast-track-skill.test.ts` (existing file — add a `@naap/billing` mock, which it currently lacks entirely, plus a new `describe` block)

**Interfaces:**
- Produces: `TAX_FAST_TRACK_ADDON_CODE = 'tax_fast_track'` and `requireTaxFastTrackAddon(request: NextRequest): Promise<{ tenantId: string } | { response: NextResponse }>`, both exported from `apps/web-next/src/lib/agentbook-tax-fast-track/guard.ts` — Task 7's e2e test updates use `TAX_FAST_TRACK_ADDON_CODE` when seeding.
- Consumes: `hasAddOn` from `@naap/billing` (already a dependency of both `apps/web-next` and `plugins/agentbook-core/backend`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/lib/agentbook-tax-fast-track/guard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const hasAddOnMock = vi.fn();
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: unknown[]) => hasAddOnMock(...args) }));

const safeResolveMock = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...args: unknown[]) => safeResolveMock(...args) }));

beforeEach(() => { vi.clearAllMocks(); });

describe('requireTaxFastTrackAddon', () => {
  it('returns the tenantId when the tenant has an active tax_fast_track add-on', async () => {
    safeResolveMock.mockResolvedValue({ tenantId: 'tenant-A' });
    hasAddOnMock.mockResolvedValue(true);
    const { requireTaxFastTrackAddon, TAX_FAST_TRACK_ADDON_CODE } = await import('./guard');

    const result = await requireTaxFastTrackAddon({} as any);

    expect(result).toEqual({ tenantId: 'tenant-A' });
    expect(hasAddOnMock).toHaveBeenCalledWith('tenant-A', TAX_FAST_TRACK_ADDON_CODE);
  });

  it('returns a 402 response when the tenant lacks the add-on', async () => {
    safeResolveMock.mockResolvedValue({ tenantId: 'tenant-B' });
    hasAddOnMock.mockResolvedValue(false);
    const { requireTaxFastTrackAddon } = await import('./guard');

    const result = await requireTaxFastTrackAddon({} as any);

    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(402);
      const body = await result.response.json();
      expect(body.error).toContain('paid add-on');
    }
  });

  it('short-circuits on a safeResolveAgentbookTenant failure without calling hasAddOn', async () => {
    const fakeResponse = { status: 401 };
    safeResolveMock.mockResolvedValue({ response: fakeResponse });
    const { requireTaxFastTrackAddon } = await import('./guard');

    const result = await requireTaxFastTrackAddon({} as any);

    expect(result).toEqual({ response: fakeResponse });
    expect(hasAddOnMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-tax-fast-track/guard.test.ts`
Expected: FAIL — the module `./guard` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web-next/src/lib/agentbook-tax-fast-track/guard.ts`:

```ts
/**
 * Shared entitlement guard for the Tax Fast-Track add-on. Mirrors
 * lib/agentbook-personal-insights/guard.ts's requirePersonalInsightsAddon()
 * exactly. Only the two routes that kick off new paid LLM/PDF/storage work
 * (/start, /regenerate) call this — /answer, /cancel, /status stay
 * ungated so a tenant who starts with an active subscription and then
 * lapses mid-questionnaire isn't blocked from finishing or viewing what
 * they already paid for.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const TAX_FAST_TRACK_ADDON_CODE = 'tax_fast_track';

export type TaxFastTrackGuard = { tenantId: string } | { response: NextResponse };

export async function requireTaxFastTrackAddon(request: NextRequest): Promise<TaxFastTrackGuard> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return { response: resolved.response };
  const { tenantId } = resolved;
  if (!(await hasAddOn(tenantId, TAX_FAST_TRACK_ADDON_CODE))) {
    return {
      response: NextResponse.json(
        { error: 'Tax Fast-Track is a paid add-on — enable it in Settings to start a filing draft review.' },
        { status: 402 },
      ),
    };
  }
  return { tenantId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-tax-fast-track/guard.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Wire the guard into `/start` and `/regenerate`, update their tests**

In `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/start/route.ts`, replace:

```ts
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
```

with:

```ts
import { requireTaxFastTrackAddon } from '@/lib/agentbook-tax-fast-track/guard';
```

and replace:

```ts
  const __resolved = await safeResolveAgentbookTenant(request);
```

with:

```ts
  const __resolved = await requireTaxFastTrackAddon(request);
```

(Nothing else in the file changes — same `if ('response' in __resolved) return __resolved.response;` destructure works identically since both functions return the same `{ tenantId } | { response }` shape.)

Apply the identical two-line change to `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts`.

Now update `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`. Add a new mock alongside the existing `vi.mock('@/lib/agentbook-tenant', ...)`:

```ts
vi.mock('@/lib/agentbook-tax-fast-track/guard', () => ({
  requireTaxFastTrackAddon: vi.fn(async () => ({ tenantId: 'tenant-A' })),
  TAX_FAST_TRACK_ADDON_CODE: 'tax_fast_track',
}));
```

The existing `describe('POST /tax-fast-track/start', ...)` and `describe('POST /tax-fast-track/regenerate', ...)` tests keep passing unchanged (the mock defaults to an entitled tenant, same as the old `safeResolveAgentbookTenant` mock did). Add one new test to each of those two `describe` blocks:

```ts
  // add inside describe('POST /tax-fast-track/start', ...)
  it('returns 402 when the tenant lacks the tax_fast_track add-on', async () => {
    const guardMod = await import('@/lib/agentbook-tax-fast-track/guard');
    (guardMod.requireTaxFastTrackAddon as any).mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no addon' }), { status: 402 }),
    });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/start/route');

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(402);
  });
```

```ts
  // add inside describe('POST /tax-fast-track/regenerate', ...)
  it('returns 402 when the tenant lacks the tax_fast_track add-on', async () => {
    const guardMod = await import('@/lib/agentbook-tax-fast-track/guard');
    (guardMod.requireTaxFastTrackAddon as any).mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no addon' }), { status: 402 }),
    });
    const { POST } = await import('../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-1' }));
    expect(res.status).toBe(402);
  });
```

- [ ] **Step 6: Gate the chat-path skill handler in `server.ts`**

The real test file is `plugins/agentbook-core/backend/src/__tests__/start-tax-fast-track-skill.test.ts`. **It does not currently mock `@naap/billing` at all** — it only mocks `../db/client.js` directly, not the `@naap/database` module `hasAddOn` itself depends on. Adding an unmocked `hasAddOn()` call to the handler would make every existing test in this file hit the real (unmocked) `hasAddOn`, which is fail-closed (returns `false` on any error) — every one of this file's 9 existing tests would suddenly hit the new gate and fail, since they all currently expect `createTaxQuestionnaireSession` to be called. This must be fixed in the same step as the gate, not left to break and get "fixed later."

Add a `hasAddOn` mock at the top of the file, alongside the existing `vi.mock('../db/client.js', ...)`:

```ts
const hasAddOnMock = vi.fn(async () => true); // entitled by default — every existing test in this file exercises the happy/blocked paths assuming access is already granted
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: unknown[]) => hasAddOnMock(...args) }));
```

Add `hasAddOnMock.mockResolvedValue(true);` to the existing `beforeEach` block (alongside the other mock resets already there), so every pre-existing test keeps passing unchanged.

In `plugins/agentbook-core/backend/src/server.ts`, inside the existing `if (selectedSkill.name === 'start-tax-fast-track') { try { ... } }` block, add the gate as the very first line of the `try`:

```ts
  if (selectedSkill.name === 'start-tax-fast-track') {
    try {
      if (!(await hasAddOn(tenantId, 'tax_fast_track'))) {
        const message = 'Tax Fast-Track is a paid add-on — enable it in Settings to start a filing draft review.';
        await db.abConversation.create({ data: { tenantId, question: text || '[tax fast track]', answer: message, queryType: 'agent', channel, skillUsed: 'start-tax-fast-track' } }).catch(() => {});
        return {
          selectedSkill, extractedParams, confidence: 1, skillUsed: 'start-tax-fast-track', skillResponse: null,
          responseData: { message, actions: [], chartData: null, skillUsed: 'start-tax-fast-track', confidence: 1, latencyMs: Date.now() - startTime },
        };
      }
      const jurisdiction = (classification.tenantConfig?.jurisdiction || 'us').toLowerCase();
      const region = classification.tenantConfig?.region || null;
      const result = await startTaxQuestionnaire(
        tenantId,
        { taxYear: extractedParams.taxYear, jurisdiction, region, triggerText: text },
        callGemini,
      );
```

(`hasAddOn` is already imported at the top of `server.ts` — `import { hasAddOn } from '@naap/billing';` — used elsewhere for `student_success`/`personal_insights`; no new import needed. Everything after this new block, through the rest of the existing `try`/`catch`, is unchanged.)

Add this new `describe` block to the end of `start-tax-fast-track-skill.test.ts`, using the file's own existing `loadServer()`/`classification()`/`filing()` helpers exactly as its other tests do:

```ts
describe('start-tax-fast-track — billing gate (PR-5)', () => {
  it('returns a paid-add-on message and does not start a session when the tenant lacks tax_fast_track', async () => {
    hasAddOnMock.mockResolvedValue(false);
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(hasAddOnMock).toHaveBeenCalledWith('tenant-1', 'tax_fast_track');
    expect(result.responseData.message).toContain('paid add-on');
    expect(sessionHelpers.createTaxQuestionnaireSession).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled(); // no callGemini call — the gate short-circuits before any LLM work
  });

  it('proceeds normally when the tenant has the add-on (existing happy-path behavior, gate is a no-op)', async () => {
    hasAddOnMock.mockResolvedValue(true);
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);
    mockGeminiResponse('{"question": "What is your filing status this year?"}');

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(sessionHelpers.createTaxQuestionnaireSession).toHaveBeenCalled();
    expect(result.responseData.message).toBe('What is your filing status this year?');
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-tax-fast-track/guard.test.ts src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`
Expected: PASS — all tests in both files.

Run: `cd plugins/agentbook-core/backend && npx vitest run` (full suite)
Expected: PASS — including the 2 new billing-gate tests and all 9 pre-existing tests in `start-tax-fast-track-skill.test.ts` (the `hasAddOnMock(async () => true)` default added in Step 6 keeps every one of them on the same happy/blocked-path behavior they already asserted, since the gate is a no-op when entitled).

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/lib/agentbook-tax-fast-track/ \
  apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/start/route.ts \
  apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts \
  apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts \
  plugins/agentbook-core/backend/src/server.ts \
  plugins/agentbook-core/backend/src/__tests__/*.test.ts
git commit -m "feat(tax-fast-track): billing gate on /start + /regenerate (HTTP + chat)

New tax_fast_track add-on, mirroring agentbook-personal-insights/guard.ts
exactly. Only the two routes that kick off new paid LLM/PDF/storage work
are gated — /answer, /cancel, /status, and Step 1b's active-session
chat branch are all untouched, so a tenant who starts with an active
subscription and lapses mid-questionnaire isn't blocked from finishing
or viewing what they already paid for."
```

---

## Task 7: Seed script + e2e test updates

**Files:**
- Create: `bin/seed-tax-fast-track-addon.ts`
- Modify: `tests/e2e/tax-fast-track.spec.ts`
- Modify: `tests/e2e/tax-fast-track-ui.spec.ts`

**Interfaces:**
- Consumes: `TAX_FAST_TRACK_ADDON_CODE` from `apps/web-next/src/lib/agentbook-tax-fast-track/guard.ts` (Task 6) — the seed script hardcodes the same string value directly (seed scripts in this repo are run via `npx tsx bin/...` outside the Next.js app's module graph, so they don't import from `apps/web-next/src/lib/*` — check `bin/seed-personal-insights-addon.ts` for precedent: it hardcodes `'personal_insights'` as `ADDON_CODE` rather than importing it).

- [ ] **Step 1: Create the seed script**

Create `bin/seed-tax-fast-track-addon.ts`:

```ts
import { prisma as db } from '@naap/database';

/**
 * Seeds the "Tax Fast-Track" add-on ($49/yr) that gates /start and
 * /regenerate on the tax fast-track questionnaire (PR-5). Same $49 USD /
 * $65 CAD precedent as personal_insights and student_success.
 *
 * Unlike bin/seed-personal-insights-addon.ts, this seeds isActive:true
 * directly rather than defaulting to false with a separate ACTIVATE
 * toggle — that pattern exists for features being gated from day one
 * (register the add-on before the gated route/UI ship). Tax fast-track
 * has already been live and free for two PRs; the gate and the addon
 * go live together, in the same deploy — there is no safe "registered
 * but not yet purchasable" staging period to model here, since hasAddOn()
 * checks isActive before subscription status, and seeding inactive would
 * deny every tenant permanently with no purchase path once the gate ships.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/seed-tax-fast-track-addon.ts
 */

const ADDON_CODE = 'tax_fast_track';

const PRICES: { region: string; currency: string; priceCents: number }[] = [
  { region: 'us', currency: 'usd', priceCents: 4900 },
  { region: 'ca', currency: 'cad', priceCents: 6500 },
];

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Tax Fast-Track', interval: 'year', isActive: true },
    create: { code: ADDON_CODE, name: 'Tax Fast-Track', interval: 'year', isActive: true },
  });

  let created = 0;
  let updated = 0;
  for (const { region, currency, priceCents } of PRICES) {
    const existing = await db.billAddOnPrice.findUnique({
      where: { addOnId_region_tier: { addOnId: addOn.id, region, tier: 'standard' } },
    });
    const data = { addOnId: addOn.id, region, currency, tier: 'standard', priceCents, maxSlots: null, isActive: true };
    if (existing) {
      await db.billAddOnPrice.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.billAddOnPrice.create({ data });
      created++;
    }
  }

  console.log(JSON.stringify({ addOnId: addOn.id, isActive: true, created, updated, total: PRICES.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Update the two existing e2e specs to grant the add-on**

Add a shared helper near the top of each file (both already define a module-level `prisma` via `test.beforeAll`/`import('@naap/database')` — place this function right after that import, before the `test.describe` block):

```ts
async function grantTaxFastTrackAddon(prisma: typeof import('@naap/database').prisma, tenantId: string) {
  const addOn = await prisma.billAddOn.upsert({
    where: { code: 'tax_fast_track' },
    update: { isActive: true },
    create: { code: 'tax_fast_track', name: 'Tax Fast-Track', interval: 'year', isActive: true },
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
}
```

In `tests/e2e/tax-fast-track.spec.ts`, its happy-path test calls `const email = await registerAndLogin(page, ...)` then needs the tenant id — it doesn't currently look it up (the chat path only needs `email` for login; the questionnaire session is found by `tenantId` server-side from the auth cookie). Add the lookup + grant right after `registerAndLogin` returns, in every test that currently calls it:

```ts
    const email = await registerAndLogin(page, 'e2e-taxft-happy'); // (use each test's own existing prefix argument)
    const user = await prisma.user.findUnique({ where: { email } });
    await grantTaxFastTrackAddon(prisma, user!.id);
```

In `tests/e2e/tax-fast-track-ui.spec.ts`, every test already does exactly `const email = await registerAndLogin(page, '...'); const user = await prisma.user.findUnique({ where: { email } }); const tenantId = user!.id;` — insert the grant as the next line after that block, in every test:

```ts
    await grantTaxFastTrackAddon(prisma, tenantId);
```

Add one new test to `tests/e2e/tax-fast-track-ui.spec.ts` (this is the file with dedicated HTTP routes, so it's the natural place to verify the 402 path — the chat spec doesn't need a duplicate of this since the gate logic itself is already unit-tested in Task 6):

```ts
test('POST /start returns 402 for a tenant without the tax_fast_track add-on', async ({ page }) => {
  const email = await registerAndLogin(page, 'e2e-taxft-no-addon');
  // Deliberately skip grantTaxFastTrackAddon for this one test/tenant.
  const result = await apiPost(page, `${CORE}/start`, {});
  expect(result.status).toBe(402);
});
```

(`registerAndLogin`, `apiPost`, and `CORE = '/api/v1/agentbook-core/tax-fast-track'` are this file's own existing helpers/constants, already used by its other tests.)

- [ ] **Step 3: Run the e2e specs**

Run: `cd tests/e2e && npx playwright test tax-fast-track.spec.ts tax-fast-track-ui.spec.ts --list`
Expected: lists all tests including the new 402 test, with no parse errors.

This step cannot run to completion here (it requires a real running instance — local dev server or a deployed target — which this plan's TDD loop doesn't have available). Note this explicitly rather than claiming a run that didn't happen: **the actual pass/fail verification of these e2e specs happens during the post-implementation full-branch verification, against a real server, not during this task's own step.**

- [ ] **Step 4: Commit**

```bash
git add bin/seed-tax-fast-track-addon.ts tests/e2e/tax-fast-track.spec.ts tests/e2e/tax-fast-track-ui.spec.ts
git commit -m "feat(tax-fast-track): billing gate seed script + e2e test updates

New bin/seed-tax-fast-track-addon.ts seeds isActive:true directly (see
its own comment for why this deliberately doesn't mirror personal-
insights' isActive:false-by-default pattern). Both existing e2e specs
now grant the add-on to their throwaway test tenant before running the
happy path, since /start and /regenerate are gated as of Task 6; added
a new 402 test for a tenant without the add-on."
```

---

## Post-implementation notes (not a task — for whoever runs the final verification)

- Running `bin/seed-tax-fast-track-addon.ts` against production is the moment tax fast-track stops being free — this needs its own explicit stop-and-confirm before it runs, exactly like any other production billing change, not bundled into "deploy code."
