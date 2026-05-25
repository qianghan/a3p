# AgentBook Rubric Scorecard — 2026-05-25 v3 (post-PRs-1..38)

Updated after PRs 34–38 (chat adapter, citations, logger adoption, Sentry vitest
fix, skill-metrics UI).

**Methodology:** Same as 2026-05-21 baseline. See `2026-05-21-rubric-scorecard.md`
and `2026-05-25-rubric-scorecard.md` for evidence rules.

---

## Score trajectory

| Snapshot | Raw | Cap-adjusted | Distance to 75 | Distance to 95 |
|----------|-----|--------------|----------------|----------------|
| 2026-05-21 baseline (pre-Wave-1) | 22 | 22 (caps tripped) | 53 | 73 |
| 2026-05-25 v2 (post-Wave-6 first half) | 66 | 66 | 9 | 29 |
| **2026-05-25 v3 (post-PR-38)** | **70** | **70** | **5** | **25** |

---

## Per-tier deltas since v2

| Tier | v2 (66) | v3 (70) | Δ | Driver |
|------|--------:|--------:|--:|--------|
| 1 Agent-Native DNA | 21 | **22** | +1 | PR 38 skill-metrics dashboard UI lifts Tier 1 #2 to 9/12 (was 8) |
| 2 Domain Workflows | 21 | **23** | +2 | PR 35 citation framework lifts Tier 2 #9 from 2/4 to 4/4 |
| 3 Activation | 10 | 10 | 0 | — |
| 4 Trust & Ops | 14 | **15** | +1 | PR 36 logger adoption + PR 37 test fix lift Tier 4 #14 from 3/4 to 4/4 |
| 5 Platform Extensibility | 0 | **0** | 0 | PR 34 adapter abstraction shipped + 3 callers migrated, but Tier 5 #17 still scores 0 — full credit requires a second non-Telegram channel actually being used (see below) |
| **Total** | **66** | **70** | **+4** | |

> Note on Tier 5 #17: the rubric criterion is "Multi-platform adapter
> abstraction" worth 3 pts. The abstraction now exists and is used; the Web
> channel ships via the `WebAdapter` (AbEvent pull). A strict reading credits
> 1 point for the existence + use of the abstraction. I'm scoring 0/3 here
> conservatively because:
>   - The Telegram webhook (largest single Telegram-coupled file) hasn't been
>     migrated.
>   - No third platform (Slack / WhatsApp / Discord) has shipped.
>
> A separate, more lenient scorer might award 1–2 pts; the most-defensible
> reading stays at 0. Either way: PR 34 is a foundation for the lift.

---

## Hard floors — all still lifted

| Floor | Status |
|-------|--------|
| Tier 1 < 32 → cap 90 | Lifted (T1 = 22) |
| No plan preview → cap 85 | Lifted (PlanPreview.tsx) |
| Skills hardcoded if/else → cap 85 | Lifted (manifest routing) |
| Destructive without confirm → cap 85 | Lifted (PR 9 confirm gate) |
| Corrections never persist → cap 85 | Never tripped |

**Effective cap: none binding.**

---

## What remains for 75 (5 points)

Highest leverage:

| Item | Pts | Effort | Status |
|------|-----|--------|--------|
| Tier 5 #17 broaden adoption — Telegram webhook + a second non-Telegram channel | +1–2 | 1–2 days | Foundation shipped (PR 34) |
| Tier 1 #4 run canonical eval suite vs live agent | +2 | 1 day (op) | Framework ready (PR 33) |
| Tier 1 #1 reduce form-only paths from ~20 to ~10 | +2 | 3 days | Onboarding done (PR 27) |
| Tier 2 #8 wire remaining proactive handlers | +1 | 1 day | Partial |

The first two close the 75 line on their own.

---

## What remains for 95+ (25 points)

In addition to the 75 items:

- Tier 1 #4 full credit: ≥92% intent accuracy, ≤2% hallucination from nightly canonical run (+4)
- Tier 1 #1 form-paths → 0 or NOTE-exempt (+4)
- Tier 1 #3 confidence-scored escalation threshold (+3)
- Tier 2 #9 grounded answer w/ source-linking in UI (+0–2; partial via PR 35 citations)
- Tier 5 multi-platform full (+3)
- Misc polish, performance, multi-turn coherence (+4)

Realistic remaining estimate to 95+: **3–4 engineer-weeks** of chat-first
refactor + adapter rollout + measurement run.

---

## PRs since 2026-05-21 (numbered for traceability)

1.  PR 1  Wave-1 security: tenant resolution lockdown
2.  PR 2  /switch-tenant deletion
3.  PR 3  admin /llm-configs gate + apiKey redaction
4.  PR 4  Stripe webhook signature verification
5.  PR 5  cross-tenant findFirst patches
6.  PR 6  line-table tenantId columns
7.  PR 7  payment idempotency
8.  PR 8  HMAC public invoice link
9.  PR 9  classify/execute split + confirm gate (G-010)
10. PR 11 manifest-driven skill routing
11. PR 12 PlanPreview component
12. PR 14 per-skill metrics (G-016)
13. PR 19 Plaid token encryption
14. PR 20 tenant-tz date helpers
15. PR 21 OCR pending-review queue
16. PR 23 structured logger + Sentry pipe
17. PR 24 undo no-silent-fail
18. PR 26 soft-delete + purge cron
19. PR 27 agent-driven onboarding
20. PR 28 /events/since + useAgentEvents
21. PR 29 real PDF via @react-pdf/renderer
22. PR 30 useAgentEvents adoption (ExpenseList + InvoiceList)
23. PR 31 RFC-4180 CSV parser
24. PR 32 legal pages + data export + deletion request
25. PR 33 canonical-utterance eval set + runner
26. PR 34 multi-platform ChatAdapter abstraction
27. PR 35 citation framework for /ask
28. PR 36 logger adoption sweep on 16 cron routes
29. PR 37 Sentry vitest resolver fix
30. PR 38 skill-metrics dashboard UI

That's 30 distinct rubric-scoring PRs over the assessment window.
