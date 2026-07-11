# Student Chat Skills — Scholarship, Co-op, and Roommate Search via the Agent Brain

## Overview

Today the AgentBook chatbot (Agent Brain v2, `POST /api/v1/agentbook-core/agent/message`) can search/query/record expenses, invoices, and tax data conversationally, but has no way to search for scholarships, co-op/job opportunities, or roommate matches — even though those three features already exist as dedicated pages (`agentbook-scholarship`, `agentbook-career`, `agentbook-housing` plugins), gated behind `businessType='student'` + the `student_success` add-on. The only chat skills that mention "scholarship" today (`scholarship-taxability`, `international-student-tax-help`) answer tax-treatment questions, not "find me one."

This adds five new chat skills that let a student ask for these directly in chat, the same way they ask about expenses, with matching quality bar: skill manifests, classification triggers that don't collide with the existing tax skills, an eligibility gate, and a "save what I just found" flow that reuses the agent brain's existing last-turn-recall mechanism.

## Background — what already exists

- **Discovery logic** (`apps/web-next/src/lib/agentbook-scholarship/discover.ts::discoverScholarships`, `apps/web-next/src/lib/agentbook-career/discover.ts::discoverJobs`) — pure async functions, no Next.js request coupling, already used by `POST /api/v1/agentbook-scholarship/discover` and `POST /api/v1/agentbook-career/discover`. Both run a Google-Search-grounded Gemini call and return `{ candidates: [...], note }`, dropping anything not grounded to a real source (no hallucinated results).
  - `ScholarshipCandidate`: `{ title, amountText, deadlineText, eligibilitySummary, sourceUrl, sourceLabel }`
  - `JobCandidate`: `{ title, employer, location, compText, deadlineText, summary, sourceUrl, sourceLabel }`
- **Save endpoints**: `POST /api/v1/agentbook-scholarship/opportunities` and `POST /api/v1/agentbook-career/opportunities` create an `AbStudentOpportunity` (`kind='scholarship'`/`kind='job'`). Their request bodies map 1:1 onto the candidate shapes above (`deadlineText` → `deadline` via the existing `parseDeadline()` util in `apps/web-next/src/lib/agentbook-student/deadline.ts`).
- **Roommate matching** (`GET /api/v1/agentbook-housing/roommate/matches`) — scores the caller against other opted-in `AbRoommateProfile` rows via `scoreMatch()` (`apps/web-next/src/lib/agentbook-housing/roommate-match.ts`, pure/unit-testable), returns `{ matches: [...], note }` with **no contact info**, by design — it's compatibility-only. If the caller has no active profile yet, it already returns `{ matches: [], note: 'Turn on your roommate profile to see compatible students.' }` instead of erroring — the chat skill inherits this for free.
- **Gating today**: two separate, non-overlapping mechanisms, neither wired into the agent brain.
  - `apps/web-next/src/lib/plugins/business-type-gate.ts` — sidebar/plugin-list visibility only, keyed off `businessType`.
  - `apps/web-next/src/lib/agentbook-student/guard.ts::requireStudentAddon` — the real route-level enforcement, checks `hasAddOn(tenantId, 'student_success')` from `@naap/billing`, fail-closed (402).
- **Agent brain skill execution** (`plugins/agentbook-core/backend/src/server.ts`, `_executeClassificationCore`) — resolves each skill's `endpoint` from its manifest (`built-in-skills.ts`), either does a generic HTTP call or runs an inline `if (selectedSkill.name === '<name>') { ...; return {...}; }` block for INTERNAL skills, in array order, first name-match wins.
- **Last-turn recall**: `handleCorrection` (`agent-memory.ts`) already resolves `lastResult` from `db.abConversation.findFirst({ where: { tenantId, queryType: 'agent' }, orderBy: { createdAt: 'desc' } }).data` — the exact mechanism this design reuses for "save the first one."
- **`@naap/billing` is already a declared dependency** of `plugins/agentbook-core/backend` (`package.json`), so `hasAddOn` needs no new wiring to call from the agent brain.

## New skills

| Skill | Type | Backs onto |
|---|---|---|
| `find-scholarships` | HTTP POST | `/api/v1/agentbook-scholarship/discover` |
| `save-scholarship` | INTERNAL | resolves a candidate from the prior turn (or direct free-text) → `POST /api/v1/agentbook-scholarship/opportunities` |
| `find-coop-opportunities` | HTTP POST | `/api/v1/agentbook-career/discover` |
| `save-coop-opportunity` | INTERNAL | same pattern → `POST /api/v1/agentbook-career/opportunities` |
| `find-roommate-matches` | HTTP GET | `/api/v1/agentbook-housing/roommate/matches` |

No save skill for roommates — matches are compatibility scores to consider, not opportunities to persist.

### `baseUrls` gap

`_executeClassificationCore`'s `baseUrls` map (server.ts, ~line 3212) only lists `agentbook-expense`, `agentbook-core`, `agentbook-invoice`, `agentbook-tax`. Add `/api/v1/agentbook-scholarship`, `/api/v1/agentbook-career`, and `/api/v1/agentbook-housing` prefixes, pointed at the same Next.js app base URL the other web-app-hosted routes already resolve to (these three, like `agentbook-core`, are Next.js API routes, not standalone Express backends — no new port/service).

## Eligibility gating

Execution-time check, first thing inside `_executeClassificationCore` for these five skill names, before any HTTP/DB work — mirrors the existing `if (selectedSkill.name === ...)` early-return style used by `edit-expense`/`categorize-expenses`:

```ts
const STUDENT_CHAT_SKILLS = ['find-scholarships', 'save-scholarship', 'find-coop-opportunities', 'save-coop-opportunity', 'find-roommate-matches'];
if (STUDENT_CHAT_SKILLS.includes(selectedSkill.name)) {
  const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const eligible = cfg?.businessType === 'student' && (await hasAddOn(tenantId, 'student_success'));
  if (!eligible) {
    return {
      selectedSkill, extractedParams, confidence: 1, skillUsed: selectedSkill.name,
      skillResponse: "Scholarship, co-op, and roommate search are part of Student Success — enable it in your Business Profile settings to use them.",
      responseData: null,
    };
  }
}
```

This runs at **execution** time, not classification time — classification is unchanged for every tenant type. Trade-off (accepted): a non-student's unrelated message could in theory misfire into one of these five skills via the LLM classification stage and get the nudge instead of a real answer, rather than never being offered the skill at all. Mitigated by specific trigger phrases (below) so misfires should be rare in practice.

## Classification triggers — avoiding collision with `scholarship-taxability`

`scholarship-taxability` already claims the bare word `'scholarship'` as a trigger pattern and sits earlier in `BUILT_IN_SKILLS`, so it would win any regex match before a new skill gets tried.

- **`find-scholarships`** triggers on search-intent phrasing only: `find.*scholarship`, `scholarship.*for`, `search.*scholarship`, `look for.*scholarship`, `scholarship.*(my|as a).*(major|program)`. `examples` includes "find scholarships for a chemistry major in Ontario".
- **`scholarship-taxability`** gets a new `excludePatterns` entry for search-intent phrasing: `find|search|look for|apply (to|for)` — so "find me a scholarship" no longer matches the tax skill first, matching how it already excludes other unrelated topics.
- **`find-coop-opportunities`** triggers: `find.*(co-?op|internship|job)`, `(co-?op|internship).*for`, `search.*(co-?op|internship)`. No existing skill collides with "co-op"/"internship".
- **`find-roommate-matches`** triggers: `roommate`, `find.*roommate`, `compatible.*(student|roommate)`. No collision.
- **`save-scholarship`** / **`save-coop-opportunity`** trigger on `save.*(scholarship|that|it|the .* one)`, `track.*(scholarship|job|opportunity)`, `shortlist`.

## "Save" flow — resolving "save the first one"

Reuses the exact last-conversation-recall pattern `handleCorrection` already relies on. `skillUsed` is its own top-level column on `AbConversation`; `data` holds the raw HTTP JSON body from the skill's own endpoint call (e.g. `{ success, data: { candidates, note } }` for `find-scholarships` — double-nested because the outer `data` is the conversation-row column and the inner `.data` is the route's own response envelope, exactly as `handleCorrection` already accesses `lastResult.data.id`):

```ts
const lastConvo = await db.abConversation.findFirst({ where: { tenantId, queryType: 'agent' }, orderBy: { createdAt: 'desc' } });
const candidates = lastConvo?.skillUsed === 'find-scholarships' ? (lastConvo.data as any)?.data?.candidates ?? [] : [];
```

The LLM classifier extracts a `selector` parameter from phrasing like "save the first one" / "save the TD one" / "save that scholarship". Resolution order:

1. **Ordinal** — regex for "first/second/third/#2/2nd" → index into `candidates`.
2. **Fuzzy title match** — case-insensitive substring match against each candidate's `title`.
3. **Fallback: direct extraction** — if neither resolves (no prior find-* turn, or selector matches nothing), treat the message as a **direct save**: the LLM extracts `title`/`amountText`/`deadlineText`/`sourceUrl` straight from the user's own text, same free-text pattern `record-expense` already uses. This gives two entry points ("find → save the first one" and "just save this one I already know about") without extra plumbing.

Once resolved, map the candidate's fields onto the existing `POST /opportunities` body (1:1 for both scholarship and career, `deadlineText` parsed via the existing `parseDeadline()` util) and forward with the tenant's auth context.

## Response formatting

Each `find-*` skill's `responseTemplate` lists the top 3–5 candidates plainly (title, amount/comp, deadline, one-line source attribution), plus the route's own `note` field relayed verbatim — this is how degraded/empty states ("Search is temporarily unavailable", "No compatible students yet", "Turn on your roommate profile...") already surface, with zero special-casing needed in the skill layer.

`save-*` responses confirm what got saved, e.g.: *"Saved 'Chen Family Award' ($2,000, due Jun 1) to your shortlist — view it anytime in Scholarships."*

## Testing

- Unit tests for the five new manifest entries' trigger-pattern routing (`selectSkillByPatterns`), specifically: "find me a scholarship" → `find-scholarships` (not `scholarship-taxability`), "is my scholarship taxable" → `scholarship-taxability` (not `find-scholarships`).
- Unit tests for the eligibility gate: student + add-on → proceeds to HTTP/INTERNAL logic; missing either → nudge message, zero HTTP calls made, mocked `hasAddOn`/`abTenantConfig`.
- Unit tests for selector resolution against a mocked `lastConvo`: ordinal match, fuzzy title match, no-match-falls-back-to-direct-extraction, and the case where the last turn wasn't a `find-*` skill at all (no candidates array to resolve against).
- One Playwright e2e spec against the real chat endpoint in production after deploy: a seeded student+add-on tenant does find → save → confirms the item appears in the Scholarships opportunities list; a non-student tenant gets the nudge with no crash.

## Delivery

Isolated worktree off latest `main` (this doc lives there) → implement + unit tests → `next build` clean → PR → merge → `vercel build --prod` + `vercel deploy --prebuilt --prod` → **`POST /api/v1/agentbook-core/agent/seed-skills` against production** (classification reads from `db.abSkillManifest`, not the `BUILT_IN_SKILLS` array directly — new skills aren't classifiable until upserted, per the existing "Adding a new skill" steps in this repo's `CLAUDE.md`) → e2e verify live on `agentbook.brainliber.com` with a real seeded student test account, matching the pattern used for every other feature shipped this session.

## Explicitly out of scope

- Collecting a roommate profile conversationally (profile setup stays a form in the Housing plugin; chat just points there if missing).
- A "log a housing listing" chat skill (housing listings are deliberately user-pasted, no search/discovery backing them — out of scope per this session's discussion).
- An affordability-check chat skill.
- Changing the classification pipeline to pre-filter skills by eligibility before the regex/LLM stages (accepted trade-off, see Eligibility gating above).
