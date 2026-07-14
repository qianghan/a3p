# Tax Fast-Track MCP Parity + Deadline Reuse + Billing Gate — Design

**PR-5 of the tax-fast-track roadmap.** Follows PR-4 (filing draft + client letter + UI-native questionnaire path). This PR does three independent things to the already-shipped feature: (1) makes it reachable through MCP the same way it already works through chat, (2) connects it to the existing tax-deadline calendar system, and (3) puts it behind a paid add-on.

## Goals

1. **MCP parity.** A user talking to AgentBook through an MCP client (Claude Desktop, etc., via the `ask_agentbook` tool) should be able to start the fast-track questionnaire, answer its follow-up questions, cancel it, and check whether their filing draft/client letter is ready — the same four things chat users can already do.
2. **Deadline reuse.** Read the already-seeded `AbCalendarEvent` rows (`eventType: 'tax_deadline'`, seeded by the existing `cron/calendar-check` route from each jurisdiction pack's static deadline table) to (a) show a filing-deadline countdown in the fast-track UI, and (b) proactively suggest starting the fast-track review when the annual filing deadline is approaching and the tenant has the prerequisites for it.
3. **Billing gate.** Tax fast-track is free today. Put new fast-track work (`/start`, `/regenerate`, and their chat equivalents) behind a new `tax_fast_track` add-on, following the exact entitlement pattern already used by `personal_insights` and `student_success`.

## Non-goals

- **No dedicated MCP tool.** There is exactly one MCP tool today (`ask_agentbook`), a passthrough to the same `agent/message` endpoint chat uses. This PR does not add a second tool — fast-track reaches MCP by making sure `ask_agentbook`'s existing natural-language routing handles it, matching how every other skill is exposed.
- **No push notification on draft completion.** Chat/MCP status-checking is pull-based (the user asks "is my draft ready?"). This PR does not proactively message the user via WhatsApp/Telegram the moment `generateFilingDraft` finishes — a real feature, but a separate scope decision from "parity" with the existing dedicated `/status` route, which is also pull-based.
- **No changes to the quarterly-estimated-tax deadline flow** (`calendar.q1_estimated_tax_due` etc.) — only the annual filing deadline (`calendar.annual_tax_filing_due`) triggers the fast-track-specific proactive suggestion. Quarterly deadlines keep firing their existing generic notification unchanged.
- **No gating of `/answer`, `/cancel`, `/status`.** Only routes that kick off new paid LLM/PDF/storage work (`/start`, `/regenerate`) check the add-on. A tenant who starts with an active subscription and then lapses mid-questionnaire is not blocked from finishing or viewing what they already paid for.
- **No AU/UK jurisdiction work** — that's PR-7. This PR's deadline reuse only needs `us`/`ca` calendar packs to already exist, which they do (plus `uk`/`au`, unused by fast-track either way).
- **No change to `hasAddOn`/`activeAddOnCodes` in `@naap/billing`** — those are already generic; this PR only adds a new call site + a new addon code + a seed script, mirroring the existing pattern exactly.

## Architecture overview

Three independent workstreams, plus one prerequisite fix:

0. **Prerequisite fix**: `ask-agentbook-tool.ts`'s self-call URL construction is swapped for the shared `getAppBaseUrl()` helper — without this, `ask_agentbook` cannot reliably reach the backend in production at all (see "Why this fix is needed" below), so MCP parity for fast-track (or anything else) has nothing working to build on.
1. **MCP parity**: a new regex-detected intent in `agent-brain.ts`'s Step 1b (same layer PR-4's cancel-detection already lives in) that answers "is my draft ready" once a session has completed, reusing the same read the dedicated `/status` route already does.
2. **Deadline reuse**: read-only consumption of `AbCalendarEvent` rows already seeded by `cron/calendar-check` — a countdown in `FastTrackTab.tsx`, and a new branch in that same cron's alert-firing loop for the fast-track-specific proactive suggestion.
3. **Billing gate**: a new `guard.ts` mirroring `agentbook-personal-insights/guard.ts`, called from `/start` + `/regenerate` (HTTP) and their chat-skill equivalents (Step 1b's already-active-session branch is unaffected — only the "no session yet, user wants to start one" path needs the check).

## Workstream 0 — Fix `ask_agentbook`'s self-call URL

### Why this fix is needed

`apps/web-next/src/lib/mcp/ask-agentbook-tool.ts` currently resolves its target host independently of every other internal self-call site in the codebase:

```ts
const CORE_URL = process.env.AGENTBOOK_CORE_URL || `http://localhost:${PLUGIN_PORTS['agentbook-core'] || DEFAULT_PORT}`;
```

`AGENTBOOK_CORE_URL` is not set in production. This is the same class of bug fixed everywhere else in the F4-01/F4-02 "chat self-call" incident (stale `AGENTBOOK_*_URL` env vars pointing at a dead pre-Next.js host) — every other internal call site (`agent-planner.ts`, `server.ts`'s direct-execution path, the Next.js route layer) was migrated to `getAppBaseUrl()` from `@/lib/agentbook-config`, which correctly resolves via `AGENTBOOK_HOST` (set in prod to `https://agentbook.brainliber.com`). This one file was never touched by that fix and still falls back to an unreachable `localhost:4050` in a serverless function.

### Fix

```ts
// apps/web-next/src/lib/mcp/ask-agentbook-tool.ts
import { getAppBaseUrl } from '@/lib/agentbook-config';

// No NextRequest available in this context — getAppBaseUrl() falls through
// to AGENTBOOK_HOST, then VERCEL_URL, then the canonical production domain.
const CORE_URL = getAppBaseUrl();
```

Remove the now-unused `PLUGIN_PORTS`/`DEFAULT_PORT` import if nothing else in the file needs it. No behavior change for any skill already reachable via MCP (if `ask_agentbook` were somehow already working via some other path, this doesn't change its target); this only fixes the currently-broken path.

## Workstream 1 — MCP / chat parity for draft status

### What already works (verified, not assumed)

`agent-brain.ts`'s Step 1b intercepts any message once `getActiveTaxQuestionnaireSession(tenantId)` finds an in-progress session — this runs identically whether the request arrived via `channel: 'web'`, `'telegram'`, `'whatsapp'`, or `'mcp'`, because it's keyed by `tenantId`, not by the calling channel. So **start, answer, and cancel already have MCP parity today** once Workstream 0 lands — no new code needed for those three.

### The actual gap: draft/letter status

Once a session reaches `status: 'completed'`, `getActiveTaxQuestionnaireSession` stops returning it (it only matches `status: 'in_progress'`), so Step 1b's branch is skipped entirely and the message falls through to normal skill classification — there is currently no way to ask "is my draft ready" through chat or MCP; the PDF links only exist via the dedicated `GET /tax-fast-track/status` route.

**New helper**, `plugins/agentbook-core/backend/src/tax-questionnaire-session.ts`:

```ts
export async function getLatestTaxQuestionnaireSession(tenantId: string): Promise<any | null> {
  return db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });
}
```

(Mirrors the exact query `apps/web-next/.../tax-fast-track/status/route.ts` already runs — extracted so both that route and the new chat intent share one implementation instead of two copies of the same Prisma call.)

**New intent in `agent-brain.ts`**, placed immediately after Step 1b's existing `if (tqSession)` block (so it only evaluates when there's no *active* session — an active session's plain-text messages are still always treated as answers, matching PR-3's existing contract):

```ts
const TAX_DRAFT_STATUS_RE = /\b(is my|where('?s| is) my|check my|download my)\b.*\b(tax )?(draft|filing draft|client letter)\b/i;

if (!tqSession && TAX_DRAFT_STATUS_RE.test(text.trim())) {
  const latest = await getLatestTaxQuestionnaireSession(tenantId);
  if (latest?.status === 'completed') {
    const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: latest.id } });
    return buildTaxDraftStatusResponse(draftRow, startTime); // new helper — mirrors /status route's shape translation
  }
}
```

`buildTaxDraftStatusResponse` returns one of: "still generating, check back in a few minutes" (no row or `status: 'pending'`), the two PDF links + summary caveat (`status: 'ready'`), or the categorized failure message with a note that they can ask to retry (`status: 'failed'`) — same three states the UI's `FastTrackTab.tsx` already renders, just as chat text instead of UI cards. If no completed session exists at all, fall through to normal classification (so "where's my draft" with nothing to find behaves like any other unrecognized message, not a hard error).

### Testing

- Unit tests for `getLatestTaxQuestionnaireSession` (new session, no completed session, expired old one).
- Unit tests for `TAX_DRAFT_STATUS_RE` matching/non-matching phrasings, and `buildTaxDraftStatusResponse`'s three branches.
- Extend `tests/e2e/tax-fast-track.spec.ts` (the chat spec) with a turn after the happy path asking "is my draft ready" and asserting the response contains both PDF URLs once the background generation completes.

## Workstream 2 — Deadline reuse

### Display: countdown in `FastTrackTab.tsx`

On the intro/no-session screen, fetch the tenant's next `calendar.annual_tax_filing_due` event:

```ts
// new route: GET /api/v1/agentbook-core/tax-fast-track/next-deadline
// (thin read, no new gate — same tenant resolution as the other 5 routes)
const event = await db.abCalendarEvent.findFirst({
  where: { tenantId, titleKey: 'calendar.annual_tax_filing_due', date: { gte: new Date() } },
  orderBy: { date: 'asc' },
});
```

`FastTrackTab.tsx` renders "Filing deadline: April 15, 2027 — 62 days away" above the "Start review" button when this resolves; renders nothing if there's no upcoming event (e.g. tenant config has no jurisdiction set yet, or the cron hasn't seeded this tenant yet).

### Proactive: suggest fast-track before the deadline

`cron/calendar-check/route.ts` already has a single branch, `if (event.eventType === 'tax_deadline') { createNotification(...) }`, that fires a generic "Due April 15" notification for every tax-deadline event type (quarterly and annual alike) once it enters the lead-time window. Add a more specific branch ahead of it:

```ts
let fastTrackNudgeSent = false;
if (event.eventType === 'tax_deadline' && event.titleKey === 'calendar.annual_tax_filing_due') {
  const [priorFiling, existingSession] = await Promise.all([
    db.abPastTaxFiling.findFirst({ where: { tenantId: event.tenantId, status: 'confirmed' } }),
    db.abTaxQuestionnaireSession.findFirst({ where: { tenantId: event.tenantId, taxYear: event.date.getUTCFullYear() - 1 } }),
  ]);
  if (priorFiling && !existingSession) {
    await createNotification({
      category: 'tax_deadline',
      severity: 'warning',
      title: 'Get a head start on your filing',
      body: `Your filing deadline is ${event.date.toLocaleDateString(...)}. Start the fast-track review now — it only takes a few minutes.`,
      ctaLabel: 'Start now',
      ctaUrl: '/agentbook/tax-package?tab=fast-track',
      createdByType: 'system', createdBy: 'calendar-check-cron',
      audienceType: 'single', audienceFilter: { tenantId: event.tenantId },
    });
    fastTrackNudgeSent = true; // suppress the generic notification below for this event, but still count toward alertsFired same as it does today
  }
}
if (event.eventType === 'tax_deadline' && !fastTrackNudgeSent) {
  // existing generic notification, unchanged
}
```

(`alertsFired++` after this block is untouched either way — both branches count as one fired alert, matching the existing counter's semantics.)

Prerequisites for the fast-track-specific message: a confirmed prior-year filing exists (fast-track needs a baseline to project from — no filing, no fast-track possible) and no session already exists for that tax year (don't nag someone who already started or finished). `event.leadTimeDays` is already `[7,3,1,0]` for every seeded deadline — this reuses those same windows rather than adding new ones, so the first fast-track nudge and the first generic reminder land on the same 7-day mark, not two different schedules to reason about.

`TaxPackage.tsx`'s tab-selection `useState` initializer currently only reads `?tab=past` from the URL; extend it to also recognize `?tab=fast-track`, matching the existing pattern, so the notification's `ctaUrl` actually lands on the right tab.

### Testing

- Extend `tests/e2e/notification-triggers.spec.ts`'s conventions (or a new spec) with: a tenant with a confirmed prior filing and an upcoming `annual_tax_filing_due` event gets the fast-track-specific notification, not the generic one; a tenant with no prior filing gets the generic one; a tenant with an existing session for that year gets neither the fast-track nudge nor a duplicate.
- Unit test for the new `next-deadline` route (event found / not found / date in the past excluded).

## Workstream 3 — Billing gate

### Guard

New `apps/web-next/src/lib/agentbook-tax-fast-track/guard.ts`, mirroring `agentbook-personal-insights/guard.ts` line for line:

```ts
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

### Call sites

- `apps/web-next/.../tax-fast-track/start/route.ts` and `.../regenerate/route.ts`: replace the existing `safeResolveAgentbookTenant` call with `requireTaxFastTrackAddon` (superset — still resolves the tenant, additionally checks the add-on).
- Chat path: the `start-tax-fast-track` skill handler in `server.ts` and the new `TAX_DRAFT_STATUS_RE`-adjacent code do **not** need the gate for status-checking (reading is free), but the actual `startTaxQuestionnaire()` call inside that skill handler needs the same `hasAddOn(tenantId, TAX_FAST_TRACK_ADDON_CODE)` check — on denial, return a chat message equivalent to the 402 body above instead of starting the session.
- `answer`/`cancel`/`status` (HTTP) and Step 1b's active-session branch (chat): unchanged, no gate — see Non-goals.

### Seeding

New `bin/seed-tax-fast-track-addon.ts`, mirroring `bin/seed-personal-insights-addon.ts` exactly (single `standard` tier, no slots): `$49 USD` / `$65 CAD` — the same anchor price as `personal_insights` and `student_success`. Run once against prod as part of this PR's deploy, same as those add-ons were seeded.

### Testing

- Unit tests for `guard.ts` (entitled tenant passes, non-entitled gets 402, `safeResolveAgentbookTenant` failure still short-circuits first).
- Extend `tests/e2e/tax-fast-track-ui.spec.ts`: a fresh tenant without the addon gets 402 from `/start`; granting the addon (direct Prisma seed, same convention as existing e2e specs) allows `/start` to proceed.
- Update `tests/e2e/tax-fast-track.spec.ts` (chat) and `tax-fast-track-ui.spec.ts` (UI) happy paths to seed the addon for their test tenant first, since both currently assume free access.

## Deployment notes

- Workstream 0's fix is a pure bug fix with no schema/data dependency — safe to ship first and independently verify (a live MCP call reaching a real response) before the rest lands.
- Workstream 3's `BillAddOn` seed must run before (or in the same deploy step as) the code that starts checking `hasAddOn` — otherwise every tenant gets denied by a nonexistent add-on code until the seed runs. Sequence: deploy code + immediately run the seed script, same order as prior add-on rollouts.
- No new Prisma models — `BillAddOn`/`BillAddOnSubscription` already exist; `AbCalendarEvent` already exists and is already seeded by the existing cron. No schema migration in this PR at all.
