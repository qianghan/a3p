# Scholarship-Taxability & Education-Credit Skill — Draft Content (for review)

Draft rule content for the Phase C "scholarship-taxability" agent-brain skill. This is
the guidance the agent would actually surface to a user — **for your review before
anything ships**, per the Phase C decision in `student.html` §11. Not yet wired into
the agent brain; see the companion implementation task for that.

Sources: IRS Pub 970 (US), CRA line 13010 / T2202 guidance (Canada) — both already
cited with more detail in `student.html` §2. Dollar thresholds below are approximate
and change yearly; the skill should surface a "verify current-year figures" caveat
rather than hardcode numbers that go stale.

## Decision tree

**Step 1 — What kind of money is this?**
- (a) Scholarship, fellowship, or grant
- (b) RESP (Canada) or 529 (US) withdrawal
- (c) A stipend/wage for work (TA/RA position, work-study)
- (d) Not sure

**Step 2a — Scholarship/grant (US)**
- Ask: are you a degree candidate at an eligible institution? (If no — the whole
  amount is generally taxable; stop here and say so plainly.)
- Ask: how was it spent — tuition/required fees/required course materials, or
  room/board/travel/optional equipment?
  - Tuition/required fees/required materials → **tax-free**, no need to report.
  - Room/board/travel/other → **taxable**, reported on Form 1040 line 1 with an "SCH"
    notation; no 1099 is typically issued for this portion.
- Flag if it's actually a stipend tied to teaching/research duties, even if labeled
  a "fellowship" — payment for services is taxable as wages regardless of what it
  funds, and this is the single most common thing students get wrong.
- Mention (as an advanced note, not a default recommendation): some students choose
  to report a small amount of otherwise tax-free scholarship as taxable income
  specifically to free up more tuition expense for the AOTC, since the credit is
  often worth more than the tax on the reclassified scholarship. Flag this as a
  calculation worth running carefully, not something to do without checking the math.

**Step 2b — Scholarship/grant (Canada)**
- Ask: full-time or part-time program?
  - Full-time, enrolled in a program that qualifies for the education amount →
    scholarship/bursary is **fully exempt**, reported on T4A box 105 but excluded
    on line 13010.
  - Part-time → exemption is limited to tuition plus program-material costs, not
    unlimited.
- Mention the T2202 tuition credit is non-refundable and most students with low
  income can't use it all in the current year — but it **carries forward
  indefinitely** or can be **transferred** (up to $5,000, minus any amount the
  student already used) to a spouse, parent, or grandparent. This is a genuinely
  useful, under-known fact worth surfacing proactively, not just on request.

**Step 3 — RESP/529 withdrawal**
- US 529: qualified withdrawals (tuition, fees, books, and room/board up to the
  school's cost-of-attendance figure) are tax-free. Non-qualified withdrawals —
  the earnings portion only, not the original contributions — are taxable to
  whoever receives the funds and generally hit a 10% penalty on top.
- Canada RESP: the EAP portion (accumulated growth + government grants) is
  taxable income to the **student**, reported on T4A, but usually results in
  little or no tax owed because the student's income is low and the basic
  personal amount plus tuition credit typically absorb it. The original PSE
  (post-secondary education) contribution portion is never taxable to anyone.

**Step 4 — Education credit eligibility overlay (US only, layered on top of the above)**
- Ask: does someone else (a parent) claim you as a dependent?
  - Yes → the student generally **cannot** claim AOTC/LLC themselves regardless of
    who actually paid the expenses; the person claiming the dependency claims the
    credit. Say this plainly — it's a common, costly point of confusion.
  - No (independent filer) → the student can claim education credits themselves
    if they meet the income and enrollment tests below.
- AOTC (American Opportunity Tax Credit): up to $2,500/student/year (100% of the
  first $2,000 of qualified expenses + 25% of the next $2,000), first 4 years of
  a degree program, at least half-time enrollment, 40% (up to $1,000) refundable
  even with zero tax owed. Income phase-out applies — verify current-year MAGI
  thresholds rather than trusting a hardcoded number.
- LLC (Lifetime Learning Credit): up to $2,000 per tax return (not per student),
  20% of up to $10,000 of expenses, no degree/enrollment-intensity requirement, no
  year limit — better fit for grad students or part-time enrollment, but
  non-refundable.
- Can't double-dip: expenses paid with tax-free scholarship money, or already used
  for a 529/RESP tax-free withdrawal, can't also be counted toward AOTC/LLC.

## Tone / framing notes for whoever implements the agent-brain handler

- Lead with the plain-English answer ("this part's tax-free, this part isn't")
  before the mechanism — matches the onboarding copy pattern already shipped in
  Phase A (`plugins/agentbook-core/frontend/src/pages/OnboardingChat.tsx`).
- Always end with the disclosure already established for this persona in
  `student.html` §9: AgentBook drafts guidance, it isn't a CPA or e-file agent,
  and current-year dollar thresholds should be verified rather than assumed exact.
- Every branch above ends in an actionable statement, never a dead end like "it's
  complicated" — if a case is genuinely ambiguous (e.g. mixed scholarship + service
  stipend), say what's clear and what needs the student's own judgment or a
  professional, rather than refusing to answer.
