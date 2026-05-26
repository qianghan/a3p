# AgentBook Rubric Scorecard — 2026-05-26 v6 (post-PRs-1..50)

Updated after Waves 9 and 10:
- Wave 9: PR 45 (more chat CTAs), PR 46 (onboarding telemetry), PR 47 (offline canonical-eval harness)
- Wave 10: PR 48 (multi-turn coherence), PR 49 (bank-rec top-N + filters), PR 50 (observability dashboard)
- Reliability fixes mid-stream: PR 99 (auth redirect-loop fix), PR 100 (/me 503 on DB outage)

## Score trajectory

| Snapshot | Raw | Δ |
|----------|----:|--:|
| 2026-05-21 baseline | 22 | — |
| 2026-05-25 v2 (post-PR-33) | 66 | +44 |
| 2026-05-25 v3 (post-PR-38) | 70 | +4 |
| 2026-05-25 v4 (post-PR-41) | 75 | +5 |
| 2026-05-25 v5 (post-PR-44) | 81 | +6 |
| **2026-05-26 v6 (post-PR-50)** | **88** | **+7** |

**Distance to public-launch (95): 7 points.**

---

## Per-tier deltas since v5

| Tier | v5 | v6 | Δ | Driver |
|------|---:|---:|--:|--------|
| 1 Agent-Native DNA | 29 | **33** | +4 | PR 45 lifts Tier 1 #1 from 6/12 to 9/12 (20/22 form-only paths now banner-led). PR 48 lifts Tier 1 #4 from 2/6 to 3/6 — multi-turn coherence framework + 7 thread cases ready. |
| 2 Domain Workflows | 24 | **25** | +1 | PR 49 lifts Tier 2 #5 from 6/8 to 7/8 — top-N candidates, soft-delete + dedupe filters. |
| 3 Activation | 10 | **12** | +2 | PR 46 lifts Tier 3 #10 from 5/8 to 7/8 — drop-off telemetry + funnel endpoint give first-15-min measurability. |
| 4 Trust & Ops | 15 | **15** | 0 | PR 50 takes Tier 4 #14 from 3/4 to 4/4 — but Tier 4 already had +1 absorbed in #13 (security cap-out). Net Tier 4 unchanged in totals; #14 individually at full credit now. (Edit: the math was 3/4 already because PR 36/37 lifted it. PR 50 reinforces and unlocks dashboarding without adding rubric points.) |
| 5 Platform Extensibility | 3 | 3 | 0 | — |
| **Total** | **81** | **88** | **+7** | |

> Note on Tier 4: PR 36 already brought #14 to full credit (4/4). PR 50
> doesn't add rubric points, but it's the visible artefact a reviewer
> would expect — a single admin page showing skill metrics, onboarding
> funnel, and recent errors. So PR 50 firms the +1 already there.
>
> The +7 total comes from Tier 1 (+4) + Tier 2 (+1) + Tier 3 (+2).

---

## Detailed criterion movements

### Tier 1 #1 — Agent-first architecture: 6/12 → 9/12

PR 45 raises form-only path coverage from 12/22 to 20/22 (Estimates,
Projects, RecurringInvoices, Vendors, Quarterly, Deductions in v5; plus
HomeOffice, TelegramSettings, SavedSearches, Receipts, BankConnection,
Timer, WhatIf, Reports in v6). The 2 remaining (legacy Onboarding wizard,
AdminConfig) are explicitly NOTE-exempt — superseded or admin-only.

### Tier 1 #4 — Core agent quality (measurement): 2/6 → 3/6

PR 48 extends the canonical set to 40 utterances + 7 multi-turn threads
covering pronoun resolution, vendor-alias memory, entity continuation,
refinement, and period continuation. The harness now emits
`multiTurnCoherence` so the rubric's multi-turn metric is computable. The
remaining 3/6 are gated on actually running the suite against a live agent
with non-trivial scores — operator concern, not a code one.

### Tier 2 #5 — Bookkeeping: 6/8 → 7/8

PR 49 (`agentbook-payment-matcher.ts`):
  - `matchTransactionWithCandidates` returns top-N for picker UI
  - Soft-deleted expenses (deletedAt != null) excluded
  - status='confirmed' filter — skip pending_review/rejected
  - Already-matched expense IDs excluded (no double-attribution)
  - 28 vitest tests, all pass

### Tier 3 #10 — Onboarding: 5/8 → 7/8

PR 46 emits `onboarding.started` / `onboarding.step_completed` /
`onboarding.completed` AbEvent rows on every transition (idempotent).
`GET /admin/onboarding-funnel` aggregates them into per-step drop-off +
median completion time + under-15-min rate. 11 vitest tests on the
pure aggregation logic.

---

## What remains for 95 (7 points)

Highest leverage:

| Item | Pts | Effort |
|------|----:|--------|
| Tier 1 #4 run the canonical eval suite vs live agent | +3 | 1 day (op) — needs Gemini key + populated nightly DB |
| Tier 2 #5 finish bank-rec — UI integration of top-N candidates | +1 | 1 day |
| Tier 1 #1 last 2 form-paths (legacy onboarding, AdminConfig) | +1 | <1 day |
| Tier 4 #14 wire to Datadog / external dashboard | +1 | 2 days |
| Tier 3 #10 onboarding polish — abandon-recovery flow | +1 | 1 day |

Realistic remaining estimate to 95+: **3–5 engineer-days** of measurement
runs + polish.

---

## PRs since 2026-05-21 (numbered for traceability)

(Continuing from v5's list of 36; appended below.)

37. PR 45 chat CTA on 8 more form/setup pages — 20/22 chat-first
38. PR 46 onboarding drop-off telemetry + funnel endpoint
39. PR 47 offline canonical-eval harness
40. PR fix #99 break agentbook ↔ login redirect loop on /auth/me 5xx
41. PR fix #100 /auth/me returns 503 on DB unavailable (matching /login)
42. PR 48 multi-turn coherence measurement (7 threads, harness)
43. PR 49 bank-rec top-N candidates + dedupe + soft-delete filter
44. PR 50 observability dashboard (skills + funnel + errors)

That's **44 distinct PRs** over the assessment window (2026-05-21 → 2026-05-26).
