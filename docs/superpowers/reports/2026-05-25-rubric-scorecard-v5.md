# AgentBook Rubric Scorecard — 2026-05-25 v5 (post-PRs-1..44)

Updated after PRs 42 (confidence escalation), 43 (citations UI), and
44 (6 more chat CTAs).

## Score trajectory

| Snapshot | Raw | Δ |
|----------|----:|--:|
| 2026-05-21 baseline | 22 | — |
| 2026-05-25 v2 (post-PR-33) | 66 | +44 |
| 2026-05-25 v3 (post-PR-38) | 70 | +4 |
| 2026-05-25 v4 (post-PR-41) | 75 | +5 |
| **2026-05-25 v5 (post-PR-44)** | **81** | **+6** |

**Distance to launch-defensible (75):** crossed at v4.
**Distance to public-launch (95):** 14 points.

---

## Per-tier deltas since v4

| Tier | v4 | v5 | Δ | Driver |
|------|---:|---:|--:|--------|
| 1 Agent-Native DNA | 24 | **29** | +5 | PR 42 confidence escalation lifts Tier 1 #3 from 7/10 to 10/10 (+3). PR 44 takes form-only paths from 6/22 to 12/22 covered — Tier 1 #1 from 4/12 to 6/12 (+2). |
| 2 Domain Workflows | 23 | **24** | +1 | PR 43 renders citations as footnote chips in the chat UI — Tier 2 #9 from 3/4 to 4/4 (+1). |
| 3 Activation | 10 | 10 | 0 | — |
| 4 Trust & Ops | 15 | 15 | 0 | — |
| 5 Platform Extensibility | 3 | 3 | 0 | — |
| **Total** | **75** | **81** | **+6** | |

---

## Detailed criterion movements

### Tier 1 #3 — Human-in-the-loop quality: 7/10 → 10/10

Before: confirm gate (PR 9) handles destructive skills, PlanPreview (PR 12)
shown, OCR pending_review (PR 21). Confidence-scored escalation missing.

After PR 42: a second gate fires when `classifyOnly` returns a non-exempt
skill with confidence below 0.55. The gate prepends an "I'm not entirely
sure I understood" lead to the plan preview so the user gets a clear
uncertainty signal AND a chance to correct before any side effect. 5/5
new vitest tests cover the matrix (low/high confidence × destructive /
non-destructive × exempt skill). Activity feed and analytics can
distinguish 'destructive' vs 'low_confidence' escalations via the new
`escalationReason` field.

### Tier 1 #1 — Agent-first architecture: 4/12 → 6/12

Form-only paths chat-coverage rose from 6/22 (PR 41) to 12/22 (PR 44).
Newly banner-led: Estimates, Projects, RecurringInvoices, Vendors,
Quarterly, Deductions. Remaining 10 paths are settings / admin /
dashboard-grid surfaces where a chat banner would be cosmetic.

### Tier 2 #9 — Consultation Q&A: 3/4 → 4/4

PR 35 emitted citations from /ask. PR 43 now threads them through the
agent-brain response and renders them as low-weight pill chips under
each agent bubble with a "Based on" header — exactly the grounding
signal the rubric criterion expects.

---

## What remains for 95 (14 points)

Highest leverage:

| Item | Pts | Effort |
|------|----:|--------|
| Tier 1 #4 run canonical eval suite vs live agent — full credit | +4 | 1 day (op) once Gemini key + nightly DB ready |
| Tier 1 #1 finish form-only-path reduction (12 → 22 covered, or NOTE-exempt the rest) | +3 | 1–2 days |
| Tier 2 #5 bookkeeping completeness — bank-rec automation, statement reconciliation | +2 | 2 days |
| Tier 3 #10 onboarding polish — first-15-min measurement + drop-off telemetry | +2 | 1 day |
| Tier 4 #14 per-skill observability dashboards (Datadog/Grafana wiring beyond local UI) | +1 | 1 day |
| Multi-turn coherence + memory recall correctness measurement | +2 | 1 day (op) |

Realistic remaining estimate: **1.5–2 engineer-weeks** of focused
measurement + polish.

---

## PRs since 2026-05-21 (numbered for traceability)

(Continuing from v4's list of 33; appended below.)

34. PR 42 confidence-scored escalation threshold (Tier 1 #3)
35. PR 43 render /ask citations as footnote chips (Tier 2 #9)
36. PR 44 chat CTA on 6 more form pages (Tier 1 #1)

That's **36 distinct rubric-scoring PRs** over the assessment window
(2026-05-21 → 2026-05-25).
