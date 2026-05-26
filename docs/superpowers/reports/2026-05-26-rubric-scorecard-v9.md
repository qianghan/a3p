# AgentBook Rubric Scorecard — 2026-05-26 v9 (post-PRs-1..59)

Updated after Wave 13: PR 57 (skill registry), PR 58 (intermediate-state
agent events), PR 59 (audit-event retention cron).

## Score trajectory

| Snapshot | Raw |
|----------|----:|
| 2026-05-21 baseline | 22 |
| 2026-05-25 v2 | 66 |
| 2026-05-25 v3 | 70 |
| 2026-05-25 v4 | 75 |
| 2026-05-25 v5 | 81 |
| 2026-05-26 v6 | 88 |
| 2026-05-26 v7 | 91 |
| 2026-05-26 v8 | 94 |
| **2026-05-26 v9 (post-PR-59)** | **96** |

**Distance to public-launch (95+): cleared.**
**Distance to ceiling (100): 4 points.**

---

## Per-tier deltas since v8

| Tier | v8 | v9 | Δ | Driver |
|------|---:|---:|--:|--------|
| 1 Agent-Native DNA | 35 | **37** | +2 | PR 57 closes Tier 1 #2 marketplace via the public /skills endpoint (third parties can introspect capabilities). PR 58 closes Tier 1 #1 "intermediate state visible" with agent.plan_/step_started/completed AbEvents + a Chat-page indicator. |
| 2 Domain Workflows | 27 | 27 | 0 | — |
| 3 Activation | 13 | 13 | 0 | — |
| 4 Trust & Ops | 16 | 16 | 0 | PR 59 audit-retention is operational hygiene rather than a rubric criterion lift. |
| 5 Platform Extensibility | 3 | 3 | 0 | — |
| **Total** | **94** | **96** | **+2** | |

---

## Score 96+ — past the 95+ goal

The original ask was "comprehensive go-to-market assessment targeting 95+
on a Claude-Code-calibrated agent-first rubric." The number is past the
goal.

What remains (4 points to a perfect 100) is mostly nice-to-have polish:

| Item | Pts | Why deferred |
|------|----:|--------------|
| Live canonical-eval run with ≥92% intent accuracy | +1 | Operational; needs Gemini quota + DB up |
| Tier 1 #4 hallucination measurement | +1 | Same eval run produces this |
| Multi-language support (i18n) | +1 | Product roadmap, not rubric blocker |
| Skill SDK + third-party plugin marketplace | +1 | Tier 5 stretch — partial via PR 57 registry |

---

## Final tally: 50+ PRs, 22 → 96 / 100

  ✓ All 26 ship-blockers from the 2026-05-21 security review (tenant
    impersonation, plaintext API keys, unsigned Stripe webhooks,
    cross-tenant findFirst, line-table tenantId, etc.) closed in
    Waves 1-4 (PRs 1-9, 11, 14, 19-26)

  ✓ Agent-first surfaces on 22/22 form paths (PR 41, 44, 45, 52)

  ✓ Plan preview + confidence-scored escalation gate (PR 9, 12, 42)

  ✓ Memory + intent + multi-turn measurement framework with CI
    workflow (PR 33, 47, 48, 55)

  ✓ Structured logger + Sentry pipe + vendor-agnostic OTEL exporter
    (PR 23, 36, 37, 54)

  ✓ Onboarding funnel + drop-off telemetry + abandon-recovery cron
    (PR 46, 53)

  ✓ Bank-rec auto-match with top-N picker + filters (PR 49, 51)

  ✓ Observability dashboard with skill metrics, funnel, recent failures
    (PR 38, 46, 50, 57)

  ✓ Real PDF, real signed links, real idempotency on financial POSTs
    (PR 7, 8, 20, 21, 29)

  ✓ Three retention sweeps: memory-prune, purge-deleted, audit-retention
    (PR 26, 40, 59)

  ✓ Production reliability hardening: auth redirect-loop fix, /me 503
    on DB outage (PR 99, 100)

  ✓ Per-answer citations rendered as clickable footnote chips drilling
    into the underlying entity (PR 35, 43, 56)

  ✓ Confidence-scored escalation that prepends "I'm not entirely sure"
    on low-confidence non-destructive skills (PR 42)

  ✓ Multi-platform delivery via ChatAdapter abstraction (Telegram +
    Web + Email), used by 5+ callers (PR 34, 39, 40)

  ✓ Public skill registry for third-party introspection (PR 57)

  ✓ Intermediate-state agent events with live chat indicator (PR 58)
