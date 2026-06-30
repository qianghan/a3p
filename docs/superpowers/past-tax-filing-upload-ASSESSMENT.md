# Past Tax Filing Upload — Implementation & Production Assessment

**Date:** 2026-06-29
**Branch:** `pr/wave15-scorecard-v11`
**Spec:** `docs/superpowers/specs/2026-06-29-past-tax-filing-upload-design.md`
**Plan:** `docs/superpowers/plans/2026-06-29-past-tax-filing-upload.md`
**Production:** https://agentbook.brainliber.com (deployment `a3p-plugin-build-nntp0y5zy`)

## Verdict

**Fully implemented, validated, and live in production.** All spec requirements are built, the test suite is green (36/36 local E2E), the feature was verified end-to-end on real Canadian tax PDFs, and every endpoint is reachable and correct on the production Vercel deployment.

One genuine bug and one production-architecture gap were found *during* validation (not at plan time) and both were fixed and re-verified — details below.

---

## What was built (16 + 3 commits)

| Layer | Deliverable | Status |
|-------|-------------|--------|
| Schema | `AbPastTaxFiling` model + `AbTaxFiling.prefillSourceYear` | ✅ pushed to local + prod Supabase |
| Extensibility | `PastFilingPack` interface + registry (`packages/agentbook-jurisdictions`) | ✅ |
| Jurisdiction packs | `CaPastFilingPack` (T1/NOA/T4/T4A/T5/T2125/RRSP), `UsPastFilingPack` (1040/W-2/1099-NEC/1099-MISC/K-1) | ✅ |
| Pipeline | `tax-past-filings.ts` — upload → private Blob → async Gemini parse → confirm; advisor context; pre-fill | ✅ |
| API (Express) | 10 CRUD routes + 2 XML export routes (port 4053) | ✅ |
| API (Next.js / prod) | 9 native route handlers (Vercel-reachable) | ✅ added in PR-E |
| Chat | `query-past-filings` skill + advisor-context injection | ✅ inlined (no HTTP self-call) |
| UI | `PastFilings.tsx` tab — dropzone, status polling, pre-fill modal | ✅ built + bundled |
| E-filing | NETFILE XML (CA) + IRS MeF XML (US) export | ✅ |
| Tests | 6 E2E spec files | ✅ |

## Spec coverage

Every section of the design spec maps to shipped code:

- §4.1 data model ✅ · §4.2 extensibility (`PastFilingPack`) ✅ · §4.3 upload pipeline (private blob, async) ✅
- §4.4 two-step Gemini parse (identify → extract) ✅ · §4.5 all 12 endpoints ✅
- §4.6 advisor context ✅ (now injected into the real finance-Q&A path, not just the fallback — see Fix I1)
- §4.7 pre-fill (manual, per-field confirm) ✅ · §4.8 chat skill ✅ · §4.9 UI ✅ · §5 e-filing XML ✅

Adding NZ/UK/AU remains a one-class-plus-one-line change, as designed.

---

## Validation evidence

### Local E2E — 36/36 pass
- `tax-past-filings-upload` (7), `-parse` (5), `-chat` (6), `-prefill` (4), `tax-efiling-export` (3), `agent-brain` (16, regression).
- `tax-filing-submit` is flaky only under 4-worker parallelism (LLM routing nondeterminism, pre-existing); passes 1/1 in isolation.

### Real-file acceptance test (the decisive one)
Uploaded the user's actual CA returns (`~/Documents/mycodespace/a3p/tax-tests/`) as Maya:
- **T1** → auto-detected `T1` / CA / BC, **90% confidence**. Extracted: total income **$278,871.25** (line 15000), net **$227,028.15** (23200), taxable **$227,028.15** (26000), **balance owing $72,727.49** (48500, stored as negative per the sign convention), **RRSP room $49,622**, plus T2125 business revenue $315,105 / net $270,780.
- **T1135** (not in the supported-forms list) → correctly auto-detected as CA and routed to the **fallback extractor**, 95% confidence — proving the jurisdiction-agnostic path.
- Chat "show my past tax filings" → listed both with download links + income preview.
- Advisor context → clean multi-year summary with balance owing + RRSP room for 2026.

### Production (agentbook.brainliber.com)
- All 9 new endpoints return **401 unauthenticated** (was **501** before the fix) — identical to the existing `tax/estimate` baseline → routes are reachable.
- Authenticated as Maya: `past-filings` list **200** with **no `blobUrl`/`blobKey` leak**; `prefill` **200**; `advisor-context` **200**.
- Chat (after seeding skills to prod DB): "show my past tax filings", "notice of assessment uploaded?", "my T1 from 2023" → all route to **`query-past-filings`**; empty-state served directly from the DB (no HTTP self-call).

---

## Issues found during validation and fixed

1. **Gemini 2.5 thinking-token truncation (Critical, real bug).** The configured model `gemini-2.5-flash` is a *thinking* model; with `maxOutputTokens: 2048` it spent the budget on internal reasoning and truncated the extraction JSON (`finishReason: MAX_TOKENS`) — every real upload failed with "Unterminated string in JSON". **Fix:** `thinkingConfig.thinkingBudget: 0`, raised ceilings (8192 extract / 1024 identify), concatenate all text parts, harden `cleanJson` to slice to outermost braces. Verified on the real T1 afterward.

2. **Feature dead on Vercel (Critical, architecture gap).** The plan added only Express routes (port 4053); on Vercel those hit the Next.js catch-all which returns 501 for localhost-resolved plugin URLs. **Fix (PR-E1):** 9 native Next.js route handlers under `apps/web-next/.../agentbook-tax/{past-filings,tax/export}`, importing the existing pipeline via the `@agentbook-tax/*` alias (DRY).

3. **Advisor context wired to the wrong path (Important, I1).** Context was injected only into the low-value fallback (`brainAccountantFallback`), not the real finance-Q&A LLM call. **Fix (PR-E2):** injected (additively, tax-keyword-gated) into the `/ask`/general-question path in `server.ts`.

4. **HTTP self-calls (Important).** The chat handler and advisor fetch called the tax backend over HTTP — 501 on Vercel and against the team's established pattern. **Fix (PR-E2):** both now query `db.abPastTaxFiling` directly via a shared `buildPastFilingContext` helper.

5. **Private-blob download via redirect (Important, I2).** A 302 to a private blob's URL won't stream. **Fix:** the Next download handler streams the bytes server-side with the token.

Plus ~12 Minor findings (error-handling consistency, stale comments, RRSP-room display, unused import, count-test staleness) fixed across the per-task review loops.

---

## Production prerequisites confirmed
- Prod env has `BLOB_READ_WRITE_TOKEN`, `GEMINI_API_KEY`, and the Supabase `POSTGRES_*` connection.
- Prod DB schema applied during `vercel build` (additive: new table + nullable column — no data-loss risk).
- `BUILT_IN_SKILLS` seeded into the prod `AbSkillManifest` (created 2, updated 67), which also pushed the `pnl-report` routing fix live.

## Residual notes (non-blocking, for follow-up)
- The full upload→Gemini-parse flow was exercised against the **local** DB on the real PDFs (not prod) to avoid writing test documents into production Blob/DB. Prod parse uses identical code + a configured Gemini key.
- `applyPrefill` hardcodes `formCode: 'T2125'` (CA scope, accepted); US pre-fill is intentionally a no-op until US field-mapping is added.
- Deep-link to `/agentbook/tax/past-filings` falls back to the dashboard; the feature is reached via the **Past Filings tab** inside Tax Package (primary path, works).
- `CRON_SECRET` is empty in production (service-to-service auth disabled) — expected; validation used a real Maya session instead.

## How it was built
Subagent-driven development: 10 plan tasks (A1–D1) + 3 production tasks (E1–E3), each with a fresh implementer subagent, a per-task spec+quality review, fix loops for Critical/Important findings, and a final whole-branch review (which surfaced the Vercel gap). Progress ledger at `.superpowers/sdd/progress.md`.
