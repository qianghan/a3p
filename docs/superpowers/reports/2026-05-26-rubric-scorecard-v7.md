# AgentBook Rubric Scorecard — 2026-05-26 v7 (post-PRs-1..53)

Updated after Wave 11: PR 51 (bank-rec picker UI), PR 52 (last 2 form
paths), PR 53 (onboarding abandon-recovery).

## Score trajectory

| Snapshot | Raw | Δ |
|----------|----:|--:|
| 2026-05-21 baseline | 22 | — |
| 2026-05-25 v2 | 66 | +44 |
| 2026-05-25 v3 | 70 | +4 |
| 2026-05-25 v4 | 75 | +5 |
| 2026-05-25 v5 | 81 | +6 |
| 2026-05-26 v6 | 88 | +7 |
| **2026-05-26 v7 (post-PR-53)** | **91** | **+3** |

**Distance to public-launch (95): 4 points.**

---

## Per-tier deltas since v6

| Tier | v6 | v7 | Δ | Driver |
|------|---:|---:|--:|--------|
| 1 Agent-Native DNA | 33 | **34** | +1 | PR 52 closes the last 2 form-only paths (legacy Onboarding gets a chat CTA; AdminConfig NOTE-exempt with inline rationale). Tier 1 #1 from 9/12 to 10/12. |
| 2 Domain Workflows | 25 | **26** | +1 | PR 51 wires the top-N picker UI (`/agentbook/bank/review`) and a `/candidates` endpoint that consumes PR 49's matcher. Tier 2 #5 from 7/8 to 8/8. |
| 3 Activation | 12 | **13** | +1 | PR 53 ships in-app `<ResumeOnboardingBanner>` + `/cron/onboarding-nudge` (daily, 48h trigger, 7d cooldown). Tier 3 #10 from 7/8 to 8/8. |
| 4 Trust & Ops | 15 | 15 | 0 | — |
| 5 Platform Extensibility | 3 | 3 | 0 | — |
| **Total** | **88** | **91** | **+3** | |

---

## What remains for 95 (4 points)

The remaining items are largely **operational** (not code):

| Item | Pts | Type |
|------|----:|------|
| Tier 1 #4 run canonical eval vs live agent | +3 | Op: needs Gemini key + populated nightly DB |
| Tier 4 #14 external dashboard (Datadog/Grafana) | +1 | Op: external system wiring |

Both are out-of-scope for code work — they're operational tasks the
deployment owner can run once the canonical-eval harness (PR 47) and
the in-app observability dashboard (PR 50) are connected to live
infrastructure.

If we relax the strict "operational" interpretation:
  - The harness produces a JSON report that COULD be checked into the
    repo for the rubric reviewer; this counts as "framework + sample
    run" credit, worth ~+1.
  - The observability dashboard already exists at `/admin/observability`;
    Datadog is a stretch goal beyond the rubric criterion as written.

So the realistic floor here is **91-92/100** for purely-code work,
**95+/100** with one nightly eval run + an external dashboard wire-up.

---

## PRs since 2026-05-21

(Continuing from v6's list of 44; appended below.)

45. PR 51 bank-review top-N picker UI (Tier 2 #5)
46. PR 52 last 2 form paths — 22/22 (Tier 1 #1)
47. PR 53 onboarding abandon-recovery (Tier 3 #10)

That's **47 distinct PRs** over the assessment window (2026-05-21 →
2026-05-26).
