# AgentBook Rubric Scorecard — 2026-05-21

**Methodology:** See `docs/superpowers/specs/2026-05-21-gtm-assessment-design.md` §5.

**Evidence rule:** every score must cite a file path, test result, or manual reproduction. Lack of evidence = 0.

---

## Tier 1 — Agent-Native DNA (target ≥ 32/40)

### #1 Agent-first architecture (12 pts)

| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| Every primary workflow can be completed via chat alone | 3 | _ | _ |
| UI panels are views on agent state, not parallel CRUD | 3 | _ | _ |
| Multi-step actions show a plan before executing | 2 | _ | _ |
| Agent's intermediate state is visible | 2 | _ | _ |
| No "secret form path" duplicating an agent skill | 2 | _ | _ |
| **Subtotal** | **12** | **_** | |
| **Auto-deductions** | | **_** | (list with evidence) |

### #2 Skill-driven intelligence (12 pts)
| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| First-class entities (manifest, version, metadata) | 3 | _ | _ |
| Discoverable from chat | 2 | _ | _ |
| Hot-addable without redeploy | 2 | _ | _ |
| Measurable (success rate, eval score) | 3 | _ | _ |
| Composition (planner chains skills) | 1 | _ | _ |
| Marketplace / third-party support | 1 | _ | _ |
| **Subtotal** | **12** | **_** | |
| **Auto-deductions** | | **_** | |

### #3 Human-in-the-loop quality (10 pts)
| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| Confidence-scored escalation | 2 | _ | _ |
| Destructive actions confirm | 2 | _ | _ |
| Plan preview before multi-step | 2 | _ | _ |
| Corrections persist | 2 | _ | _ |
| Undo / rollback | 1 | _ | _ |
| Audit trail | 1 | _ | _ |
| **Subtotal** | **10** | **_** | |
| **Auto-deductions** | | **_** | |

### #4 Core agent quality (6 pts)
| Criterion | Max | Score | Evidence |
|-----------|-----|-------|----------|
| Intent accuracy ≥ 92% | 2 | _ | nightly report |
| Hallucination ≤ 2% | 2 | _ | nightly report |
| Multi-turn coherence | 1 | _ | nightly report |
| Memory recall | 1 | _ | nightly report |
| **Subtotal** | **6** | **_** | |
| **Auto-deductions** | | **_** | |

**Tier 1 total: __ / 40**

---

## Tier 2 — Domain Workflows (28 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 5 | Bookkeeping | 8 | _ | _ |
| 6 | Invoicing | 6 | _ | _ |
| 7 | Tax | 6 | _ | _ |
| 8 | Budget / advisor | 4 | _ | _ |
| 9 | Consultation Q&A | 4 | _ | _ |
| | **Tier 2 total** | **28** | **_** | |

---

## Tier 3 — Activation (14 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 10 | Onboarding & first-15-min | 8 | _ | _ |
| 11 | Billing / monetization | 4 | _ | _ |
| 12 | Plaid / bank sync | 2 | _ | _ |
| | **Tier 3 total** | **14** | **_** | |

---

## Tier 4 — Trust & Ops (15 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 13 | Security & tenant isolation | 5 | _ | _ |
| 14 | Observability & ops | 4 | _ | _ |
| 15 | Support & feedback loop | 3 | _ | _ |
| 16 | Legal & data rights | 3 | _ | _ |
| | **Tier 4 total** | **15** | **_** | |

---

## Tier 5 — Platform Extensibility (3 pts)

| # | Category | Max | Score | Evidence |
|---|----------|-----|-------|----------|
| 17 | Multi-platform adapter abstraction | 3 | _ | _ |

---

## Hard Floors

- Tier 1 total: __ / 40 — pass/fail: __  (capped at 90 if < 32)
- Auto-fail clauses (any hit → cap at 85):
  - [ ] No plan-preview for multi-step
  - [ ] Skills hardcoded if/else
  - [ ] Destructive financial action without confirm
  - [ ] Corrections never persist

---

## Final score

- Raw sum: __ / 100
- After hard-floor caps: __ / 100
- Distance to 95: __ points
- Top 3 highest-leverage gaps (points reclaimed / effort): __, __, __
