# Launch-gap PR-8: International-Student Tax Guidance — AU-Aware — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap where several chat-skill code paths hardcode a binary `jurisdiction === 'ca' ? X : Y` split that silently assumes every non-Canadian tenant is American — so an AU student today gets told they're "in the United States" and handed IRS-flavored rules and forms. Make every affected code path genuinely three-way (`us`/`ca`/`au`) aware, with real AU terminology and (where the underlying facts are actually AU-specific tax content, not just a label) real, carefully-hedged AU content.

**Architecture:** Two kinds of fix, of very different size and risk, both discovered by direct investigation rather than trusting the roadmap's own line numbers or scope framing (which undersold both the true occurrence count and the depth of two of them):

1. **Mechanical / near-mechanical fixes** (Tasks 1–2): a bracket-selection ternary and three HTML-label ternaries. These are label/data swaps, not new tax-rule authorship, and carry no special review requirement beyond the normal per-task review.
2. **New AU tax-guidance content** (Tasks 3–4): two chat-skill handlers (`scholarship-taxability`, `international-student-tax-help`) whose actual substantive rules text — not just a display label — is hardcoded US/CA-only prose fed to an LLM as ground truth. Closing the AU gap here means authoring genuinely new AU content (ATO scholarship-exemption rules, Australian tax-residency tests, superannuation, myTax filing), which is exactly the same class of user-facing tax-guidance content this repo's own prior work (`docs/superpowers/specs/2026-07-03-scholarship-taxability-skill-content.md`) explicitly drafted **"for your review before anything ships"** before the existing US/CA content went live. This plan follows that same precedent: the content is implemented and tested in-branch like everything else, but Task 4's own final step is presenting the drafted AU (and one bug-fixed CA) content to the user for explicit review before the branch can merge — mirroring Launch-gap PR-7's legal-copy checkpoint.

**Tech Stack:** Express backend file that is *partially* live production code (`plugins/agentbook-core/backend/src/server.ts` — see Global Constraints), Next.js Route Handlers (`apps/web-next`), `@agentbook/jurisdictions` package for real tax-bracket/self-employment-tax data.

## Global Constraints

- **Production-file discipline, verified by tracing the actual import graph (not assumed from file location):**
  - `GET /api/v1/agentbook-core/money-moves` and `GET /api/v1/agentbook-core/tax-package/html` are implemented **twice**: once as an Express `app.get(...)` inline callback in `plugins/agentbook-core/backend/src/server.ts` (confirmed **dead code in production** — nothing in `apps/web-next` imports the Express `app` object, only individual named functions), and once, independently, as Next.js Route Handlers under `apps/web-next/src/app/api/v1/agentbook-core/{money-moves,tax-package/html}/route.ts` (confirmed the **real, production-serving code** — these files have zero import relationship to `server.ts` and already have their own drift, e.g. a different effective-tax-rate calculation). **Tasks 1–2 fix the two Next.js route files.** The `server.ts` Express duplicates are explicitly left unfixed — dead code, not worth the risk of touching, matching this session's established practice of not chasing unreachable code.
  - `scholarship-taxability` and `international-student-tax-help` are **genuinely live production code** despite living in `plugins/agentbook-core/backend/src/server.ts` — verified via the actual static import chain: `apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts` (and the Telegram/WhatsApp webhook routes) import `classifyOnly`/`executeClassification` directly from `@agentbook-core/server` (a `tsconfig.json` path alias pointing straight at this file), which call into `_executeClassificationCore`, where both skill handlers live. **Tasks 3–4 fix `server.ts` directly** — no separate Next.js copy exists or is needed.
- **Incidental, adjacent bug fixed alongside Task 1:** the Next.js `money-moves/route.ts`'s hardcoded `US_BRACKETS` array is itself missing the top two real US federal brackets (32%/35%/37%) compared to the actual shipped `usTaxBrackets` provider in `@agentbook/jurisdictions` — Task 1 imports the real bracket providers (needed anyway to add AU), which also corrects this pre-existing drift as a side effect, not as unrelated scope creep.
- **Confirmed non-issue, so Task 2 stays a pure label fix:** `AbTaxEstimate.seTaxCents` is *already* jurisdiction-correct for AU tenants — `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts` already wires `au: auSelfEmploymentTax` (the real Medicare Levy calculator) alongside `us`/`ca`. The `tax-package/html` gap is display-label-only; no upstream computation needs fixing.
- **A second, adjacent bug found and fixed in Task 4, disclosed explicitly since it's beyond the roadmap's stated "add AU" framing:** `international-student-tax-help`'s treaty-specifics logic (`treatyNote`) is keyed **only on the student's home country**, never on jurisdiction — so a Canada-jurisdiction student from China is *already*, today, incorrectly told about "the US-China tax treaty," a real bug independent of the AU gap. Task 4 fixes this by gating the two verified treaty specifics (US-China, US-India) to `jurisdiction === 'us'` and giving Canada and Australia their own honest "I don't have verified treaty specifics for you yet" fallback, matching this handler's own established discipline (already used today for every home country besides China/India) of never fabricating a treaty claim.
- **Content-authorship discipline for Tasks 3–4:** every new AU (or honest-fallback) sentence is written to the same standard as the existing US/CA content already in these files — categorical facts (ATO residency tests, the Div 51-10 scholarship exemption's structure) are stated plainly since they don't change yearly; anything that DOES change yearly or case-by-case (work-hour visa caps, ambiguous bonded-scholarship terms) gets the same "verify/check the real source, don't guess" hedge the existing US content already uses for its own volatile figures. Where this plan has no verified AU-jurisdictions-package source for a claim (e.g. AU-China/AU-India treaty specifics), it uses an honest fallback rather than inventing one — never state a treaty article number, ATO ruling, or dollar threshold that isn't independently verifiable from this codebase's existing AU jurisdiction pack or well-established, non-volatile ATO structure (e.g. "Division 51-10," "the tax-free threshold," "myTax," "superannuation guarantee" are all stable, correct terms; specific dollar thresholds are avoided or explicitly flagged as subject to change).
- **This plan does NOT author Canada-specific international-student content** (Canadian study-permit rules, CRA residency tests, a CPP/EI equivalent to FICA) even though Task 4's investigation found Canada has the same "gets 100% US-specific content" bug AU does in this one handler — authoring real Canada content is a comparably-sized, separate content-authoring effort and out of scope for a PR titled "AU-aware." Task 4 gives Canada an honest "not available yet" fallback instead of either leaving the existing bug (silently wrong) or fabricating Canada content — tracked explicitly as a known, accepted gap, not silently left broken.
- No schema changes, no new dependencies, no database migration in this entire plan.

---

### Task 1: Wire real tax-bracket providers into `money-moves` (adds AU, fixes incomplete US brackets)

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/money-moves/route.ts`

**Interfaces:**
- Consumes: `usTaxBrackets`, `caTaxBrackets`, `auTaxBrackets` from `@agentbook/jurisdictions/{us,ca,au}/tax-brackets` (each a `TaxBracketProvider` with `getTaxBrackets(taxYear: number): TaxBracket[]`, `TaxBracket = { min: number; max: number | null; rate: number }` — same shape as this file's current local `US_BRACKETS`/`CA_BRACKETS` arrays, already confirmed field-compatible).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Replace the hardcoded bracket arrays with real provider imports**

Find:
```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Move {
  type: string;
  urgency: 'critical' | 'important' | 'informational';
  title: string;
  description: string;
  impactCents: number;
}

const US_BRACKETS = [
  { min: 0, max: 1_160_000, rate: 0.10 },
  { min: 1_160_000, max: 4_712_500, rate: 0.12 },
  { min: 4_712_500, max: 10_052_500, rate: 0.22 },
  { min: 10_052_500, max: 19_190_000, rate: 0.24 },
  { min: 19_190_000, max: null as number | null, rate: 0.32 },
];

const CA_BRACKETS = [
  { min: 0, max: 5_737_500, rate: 0.15 },
  { min: 5_737_500, max: 11_475_000, rate: 0.205 },
  { min: 11_475_000, max: 15_846_800, rate: 0.26 },
  { min: 15_846_800, max: 22_170_800, rate: 0.29 },
  { min: 22_170_800, max: null as number | null, rate: 0.33 },
];
```
Replace with:
```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Move {
  type: string;
  urgency: 'critical' | 'important' | 'informational';
  title: string;
  description: string;
  impactCents: number;
}

// Real, tested jurisdiction-pack bracket data — replaces two previously
// hand-duplicated, drifted local arrays (the old inline US_BRACKETS was
// missing the top two real federal brackets, 32%/35%/37%, compared to the
// actual usTaxBrackets provider) and adds Australia, which this route never
// supported at all.
const BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};
```

- [ ] **Step 2: Use the provider map at the call site**

Find:
```ts
    if (estimate && estimate.netIncomeCents > 0) {
      const brackets = (config?.jurisdiction || 'us') === 'ca' ? CA_BRACKETS : US_BRACKETS;
      for (let i = 0; i < brackets.length - 1; i++) {
```
Replace with:
```ts
    if (estimate && estimate.netIncomeCents > 0) {
      const jurisdiction = config?.jurisdiction || 'us';
      const provider = BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets;
      const brackets = provider.getTaxBrackets(new Date().getFullYear());
      for (let i = 0; i < brackets.length - 1; i++) {
```

- [ ] **Step 3: Write a test**

Check for an existing test file first: `find apps/web-next/src/__tests__ -ipath "*money-moves*"`. If none exists, create `apps/web-next/src/__tests__/api/v1/agentbook-core/money-moves-route.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const accountFindFirst = vi.fn();
const journalLineFindMany = vi.fn();
const expenseAggregate = vi.fn();
const clientFindMany = vi.fn();
const tenantConfigFindUnique = vi.fn();
const taxEstimateFindFirst = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abAccount: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
    abJournalLine: { findMany: (...a: unknown[]) => journalLineFindMany(...a) },
    abExpense: { aggregate: (...a: unknown[]) => expenseAggregate(...a) },
    abClient: { findMany: (...a: unknown[]) => clientFindMany(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abTaxEstimate: { findFirst: (...a: unknown[]) => taxEstimateFindFirst(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-core/money-moves/route';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-core/money-moves', { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset();
  accountFindFirst.mockReset();
  journalLineFindMany.mockReset();
  expenseAggregate.mockReset();
  clientFindMany.mockReset();
  tenantConfigFindUnique.mockReset();
  taxEstimateFindFirst.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindFirst.mockResolvedValue(null); // skip cash-cushion branch
  journalLineFindMany.mockResolvedValue([]);
  expenseAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  clientFindMany.mockResolvedValue([]); // skip revenue-cliff branch
});

describe('GET /api/v1/agentbook-core/money-moves — AU bracket wiring', () => {
  it('produces an AU optimal-timing move using the real 30% bracket, not a hardcoded US/CA table', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    // AU bracket 2 is $45,001–$135,000 @ 30% (4_500_000–13_500_000 cents).
    // Net income $2,000 below the top of that bracket → should trigger the
    // "prepay expenses" nudge using the AU 30%→37% rate jump, not a US/CA one.
    taxEstimateFindFirst.mockResolvedValue({ netIncomeCents: 13_300_000 });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    const move = body.data.find((m: { type: string }) => m.type === 'optimal_timing');
    expect(move).toBeTruthy();
    expect(move.description).toMatch(/30%/);
    const gap = 13_500_000 - 13_300_000; // 200_000 cents = $2,000
    const savings = Math.round(gap * (0.37 - 0.30));
    expect(move.impactCents).toBe(savings);
  });

  it('still produces a correct US move using the real (now-complete) 7-bracket US table', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    // Real usTaxBrackets bracket 4 is $100,525–$191,900 @ 24% (10_052_500–19_190_000 cents).
    taxEstimateFindFirst.mockResolvedValue({ netIncomeCents: 19_000_000 });

    const res = await GET(req());
    const body = await res.json();
    const move = body.data.find((m: { type: string }) => m.type === 'optimal_timing');

    expect(move).toBeTruthy();
    expect(move.description).toMatch(/24%/);
    const gap = 19_190_000 - 19_000_000;
    const savings = Math.round(gap * (0.32 - 0.24)); // next real US bracket is 32%, not the old hardcoded table's missing top brackets
    expect(move.impactCents).toBe(savings);
  });

  it('defaults to US brackets when jurisdiction is unset', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    taxEstimateFindFirst.mockResolvedValue({ netIncomeCents: 0 });

    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web-next && npx vitest run` filtered to the new/found test file path from Step 3.
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "money-moves"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/money-moves/route.ts apps/web-next/src/__tests__/api/v1/agentbook-core/money-moves-route.test.ts
git commit -m "fix(student): wire real AU/CA/US tax-bracket providers into money-moves"
```

---

### Task 2: AU-aware labels in the `tax-package/html` export

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/tax-package/html/route.ts`

**Interfaces:** none — self-contained string changes.

- [ ] **Step 1: Three-way form-name branch**

Find:
```ts
    const jurisdiction = config?.jurisdiction || 'us';
    const formName = jurisdiction === 'ca'
      ? 'T2125 — Statement of Business Activities'
      : 'Schedule C — Profit or Loss from Business';
```
Replace with:
```ts
    const jurisdiction = config?.jurisdiction || 'us';
    const formName = jurisdiction === 'ca'
      ? 'T2125 — Statement of Business Activities'
      : jurisdiction === 'au'
        ? 'Business and Professional Items Schedule (myTax individual tax return)'
        : 'Schedule C — Profit or Loss from Business';
```

- [ ] **Step 2: Three-way self-employment-tax row label**

Find:
```ts
    <tr><td>${jurisdiction === 'ca' ? 'CPP Self-Employed' : 'Self-Employment Tax'}</td><td class="amount">${fmt(estimate.seTaxCents)}</td></tr>
```
Replace with:
```ts
    <tr><td>${jurisdiction === 'ca' ? 'CPP Self-Employed' : jurisdiction === 'au' ? 'Medicare Levy' : 'Self-Employment Tax'}</td><td class="amount">${fmt(estimate.seTaxCents)}</td></tr>
```
(`estimate.seTaxCents` is already computed correctly for AU tenants via `auSelfEmploymentTax` in `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts` — this is a label-only fix, the underlying number needs no change.)

- [ ] **Step 3: Three-way expense-category-header**

Find:
```ts
  <h2>Expense Detail by ${jurisdiction === 'ca' ? 'T2125' : 'Schedule C'} Category</h2>
```
Replace with:
```ts
  <h2>Expense Detail by ${jurisdiction === 'ca' ? 'T2125' : jurisdiction === 'au' ? 'ITR Business Schedule' : 'Schedule C'} Category</h2>
```

- [ ] **Step 4: Write a test**

Check for an existing test file first: `find apps/web-next/src/__tests__ -ipath "*tax-package*html*"`. If none exists, create `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-package-html-route.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineFindMany = vi.fn();
const expenseCount = vi.fn();
const taxEstimateFindFirst = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abJournalLine: { findMany: (...a: unknown[]) => journalLineFindMany(...a) },
    abExpense: { count: (...a: unknown[]) => expenseCount(...a) },
    abTaxEstimate: { findFirst: (...a: unknown[]) => taxEstimateFindFirst(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-core/tax-package/html/route';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-core/tax-package/html?year=2026', { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset();
  tenantConfigFindUnique.mockReset();
  accountFindMany.mockReset();
  journalLineFindMany.mockReset();
  expenseCount.mockReset();
  taxEstimateFindFirst.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindMany.mockResolvedValue([]);
  journalLineFindMany.mockResolvedValue([]);
  expenseCount.mockResolvedValue(0);
});

describe('GET /api/v1/agentbook-core/tax-package/html — AU-aware labels', () => {
  it('uses AU-specific form name, Medicare Levy label, and ITR category header for an AU tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD' });
    taxEstimateFindFirst.mockResolvedValue({ seTaxCents: 250000, incomeTaxCents: 1000000, totalTaxCents: 1250000 });

    const res = await GET(req());
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Business and Professional Items Schedule (myTax individual tax return)');
    expect(html).toContain('Medicare Levy');
    expect(html).toContain('ITR Business Schedule Category');
    expect(html).not.toContain('Schedule C');
    expect(html).not.toContain('T2125');
    expect(html).not.toContain('Self-Employment Tax');
  });

  it('still uses the original Canada labels for a CA tenant (unchanged behavior)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', currency: 'CAD' });
    taxEstimateFindFirst.mockResolvedValue({ seTaxCents: 250000, incomeTaxCents: 1000000, totalTaxCents: 1250000 });

    const res = await GET(req());
    const html = await res.text();

    expect(html).toContain('T2125 — Statement of Business Activities');
    expect(html).toContain('CPP Self-Employed');
    expect(html).toContain('T2125 Category');
  });

  it('still uses the original US labels for a US tenant (unchanged behavior)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'USD' });
    taxEstimateFindFirst.mockResolvedValue({ seTaxCents: 250000, incomeTaxCents: 1000000, totalTaxCents: 1250000 });

    const res = await GET(req());
    const html = await res.text();

    expect(html).toContain('Schedule C — Profit or Loss from Business');
    expect(html).toContain('Self-Employment Tax');
    expect(html).toContain('Schedule C Category');
  });
});
```

- [ ] **Step 5: Run the tests**

Run the test file path from Step 4.
Expected: all pass.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "tax-package/html"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/tax-package/html/route.ts apps/web-next/src/__tests__/api/v1/agentbook-core/tax-package-html-route.test.ts
git commit -m "fix(student): AU-aware form name, Medicare Levy label, and category header in tax-package HTML export"
```

---

### Task 3: `scholarship-taxability` — real AU rules content (Division 51-10 exemption)

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts` (inside the `scholarship-taxability` handler, confirmed live production code via the import chain in Global Constraints)
- Test: `plugins/agentbook-core/backend/src/__tests__/scholarship-taxability-skill.test.ts` (new — check first: `find plugins/agentbook-core/backend/src/__tests__ -ipath "*scholarship*"`)

**Interfaces:** none new — same `selectedSkill`/`extractedParams`/`confidence`/`classification` inputs and `responseData` shape already used by this handler and its caller (`_executeClassificationCore`).

**Context:** the existing handler already has a real, well-hedged US block (IRS Pub 970) and Canada block (CRA line 13010, T2202, RESP) — only the AU content is missing, and only the jurisdiction-label ternary needs to become three-way. The AU content below is grounded in ITAA 1997 Division 51-10 (the actual, stable, non-numeric statutory scholarship exemption) — deliberately no dollar thresholds are stated, matching this file's own established discipline for content that would otherwise go stale.

- [ ] **Step 1: Add the AU rules block and make the jurisdiction label three-way**

Find (in `plugins/agentbook-core/backend/src/server.ts`, inside the `scholarship-taxability` handler):
```ts
      const jurisdiction = (classification.tenantConfig?.jurisdiction || 'us').toLowerCase();
      const rules = [
        'US rules (IRS Pub 970):',
        '- A scholarship/fellowship is tax-free only if the student is a degree candidate AND the money is spent on tuition, required fees, or required course materials.',
        '- Money spent on room/board, travel, or optional equipment is taxable — report it on Form 1040 line 1 with an "SCH" notation.',
        '- A stipend tied to teaching/research duties (e.g. a TA/RA position) is taxable as payment for services regardless of the label "fellowship" — this is the most common thing people get wrong.',
        '- Advanced note (mention only if relevant): some students deliberately report a bit of otherwise-tax-free scholarship as taxable to free up more tuition expense for the AOTC, since the credit can be worth more than the tax owed — flag this as something to calculate carefully, not a default recommendation.',
        '- US 529 withdrawals: qualified (tuition/fees/books/room-board up to cost of attendance) are tax-free. Non-qualified withdrawals — only the earnings portion, not original contributions — are taxable to the recipient plus typically a 10% penalty.',
        '- Education credits: if the student is claimed as someone else\'s dependent, the student CANNOT claim AOTC/LLC themselves regardless of who paid — only the person claiming the dependency can. AOTC is up to $2,500/student/year (100% of first $2,000 + 25% of next $2,000), first 4 years of a degree, at least half-time, 40% refundable. LLC is up to $2,000 per return (not per student), 20% of up to $10,000 of expenses, no degree/year-limit requirement — better fit for grad students or part-time enrollment. Expenses paid with tax-free scholarship or a tax-free 529 withdrawal cannot also be counted toward either credit.',
        '- Income phase-out thresholds change yearly — do not state a specific dollar figure as current; tell the user to verify this year\'s IRS figures.',
        '',
        'Canada rules (CRA):',
        '- A full-time student\'s scholarship/bursary/fellowship is fully tax-exempt if the program qualifies for the education amount (reported on T4A box 105, excluded via line 13010). Part-time students only get the exemption up to tuition plus program-material costs.',
        '- The T2202 tuition credit is non-refundable (15% federal) and most students with low income can\'t use it all right away — but it carries forward indefinitely, or up to $5,000 (minus any amount the student already used) can be transferred to a spouse, parent, or grandparent. Mention this proactively — it is genuinely useful and under-known.',
        '- RESP: the EAP portion (accumulated growth + government grants) is taxable to the STUDENT (reported on T4A) but usually results in little or no tax owed because of the student\'s low income plus the basic personal amount and tuition credit. The original contribution (PSE) portion is never taxable to anyone.',
      ].join('\n');

      const system = [
        'You are AgentBook, explaining a student\'s tax question about a scholarship, grant, stipend, or RESP/529 withdrawal.',
        `The user's tax jurisdiction is ${jurisdiction === 'ca' ? 'Canada' : 'the United States'} — answer using only that jurisdiction\'s rules below unless the user explicitly asks about the other one.`,
        'Use ONLY the rules given below — do not invent dollar thresholds or rules not listed here.',
        'Lead with the plain-English answer (tax-free vs taxable, and which part) before explaining the mechanism.',
        'End with one sentence noting AgentBook is not a CPA or e-file agent and to verify current-year dollar figures.',
        'Plain text, 3-6 sentences, no markdown headers.',
        '',
        rules,
      ].join('\n');

      const question = String(extractedParams.question || text || 'Is my scholarship taxable?');
      const reply = await callGemini(system, question, 400)
        ?? "I couldn't work through that just now — try asking again in a moment, or check the IRS Pub 970 (US) / CRA line 13010 (Canada) guidance directly.";
```
Replace with:
```ts
      const jurisdiction = (classification.tenantConfig?.jurisdiction || 'us').toLowerCase();
      const rules = [
        'US rules (IRS Pub 970):',
        '- A scholarship/fellowship is tax-free only if the student is a degree candidate AND the money is spent on tuition, required fees, or required course materials.',
        '- Money spent on room/board, travel, or optional equipment is taxable — report it on Form 1040 line 1 with an "SCH" notation.',
        '- A stipend tied to teaching/research duties (e.g. a TA/RA position) is taxable as payment for services regardless of the label "fellowship" — this is the most common thing people get wrong.',
        '- Advanced note (mention only if relevant): some students deliberately report a bit of otherwise-tax-free scholarship as taxable to free up more tuition expense for the AOTC, since the credit can be worth more than the tax owed — flag this as something to calculate carefully, not a default recommendation.',
        '- US 529 withdrawals: qualified (tuition/fees/books/room-board up to cost of attendance) are tax-free. Non-qualified withdrawals — only the earnings portion, not original contributions — are taxable to the recipient plus typically a 10% penalty.',
        '- Education credits: if the student is claimed as someone else\'s dependent, the student CANNOT claim AOTC/LLC themselves regardless of who paid — only the person claiming the dependency can. AOTC is up to $2,500/student/year (100% of first $2,000 + 25% of next $2,000), first 4 years of a degree, at least half-time, 40% refundable. LLC is up to $2,000 per return (not per student), 20% of up to $10,000 of expenses, no degree/year-limit requirement — better fit for grad students or part-time enrollment. Expenses paid with tax-free scholarship or a tax-free 529 withdrawal cannot also be counted toward either credit.',
        '- Income phase-out thresholds change yearly — do not state a specific dollar figure as current; tell the user to verify this year\'s IRS figures.',
        '',
        'Canada rules (CRA):',
        '- A full-time student\'s scholarship/bursary/fellowship is fully tax-exempt if the program qualifies for the education amount (reported on T4A box 105, excluded via line 13010). Part-time students only get the exemption up to tuition plus program-material costs.',
        '- The T2202 tuition credit is non-refundable (15% federal) and most students with low income can\'t use it all right away — but it carries forward indefinitely, or up to $5,000 (minus any amount the student already used) can be transferred to a spouse, parent, or grandparent. Mention this proactively — it is genuinely useful and under-known.',
        '- RESP: the EAP portion (accumulated growth + government grants) is taxable to the STUDENT (reported on T4A) but usually results in little or no tax owed because of the student\'s low income plus the basic personal amount and tuition credit. The original contribution (PSE) portion is never taxable to anyone.',
        '',
        'Australia rules (ATO, Income Tax Assessment Act 1997 Division 51-10):',
        '- A scholarship, bursary, or educational allowance paid to a full-time student is exempt from income tax under Division 51-10 — there is no spending category to track (unlike the US rules above), the exemption is on the payment itself.',
        '- The exemption does NOT apply if the scholarship is conditional on the recipient providing services to the payer — a "bonded" scholarship or industry cadetship with a return-of-service requirement (e.g. must work for the sponsor after graduating) is taxable. This is the single most common thing people get wrong here, the same shape of trap as the US TA/RA stipend confusion above.',
        '- Government income-support payments such as Youth Allowance, Austudy, or ABSTUDY are a DIFFERENT thing from a scholarship even though students often mention them in the same breath — these are taxable income, reported on the recipient\'s own tax return.',
        '- HECS-HELP / HELP loans are not a scholarship-taxability question at all — they are a government loan for tuition, repaid later through the tax system once income passes a threshold. If the user mentions a HECS-HELP debt alongside a scholarship, treat them as two separate topics, not one.',
        '- Australia has no direct equivalent of the US AOTC/LLC education tax credits, and no RESP/529-style dedicated education savings account — if asked about either, say plainly that Australia\'s system does not have that mechanism rather than inventing an analog.',
        '- If a scholarship\'s terms are genuinely ambiguous (mixed scholarship + some service expectation), say what\'s clear and suggest the student check the scholarship\'s actual terms or ask a registered tax agent, rather than guessing which side of the Division 51-10 line it falls on.',
      ].join('\n');

      const system = [
        'You are AgentBook, explaining a student\'s tax question about a scholarship, grant, stipend, or RESP/529 withdrawal.',
        `The user's tax jurisdiction is ${jurisdiction === 'ca' ? 'Canada' : jurisdiction === 'au' ? 'Australia' : 'the United States'} — answer using only that jurisdiction\'s rules below unless the user explicitly asks about a different one.`,
        'Use ONLY the rules given below — do not invent dollar thresholds or rules not listed here.',
        'Lead with the plain-English answer (tax-free vs taxable, and which part) before explaining the mechanism.',
        'End with one sentence noting AgentBook is not a CPA or e-file agent and to verify current-year dollar figures.',
        'Plain text, 3-6 sentences, no markdown headers.',
        '',
        rules,
      ].join('\n');

      const question = String(extractedParams.question || text || 'Is my scholarship taxable?');
      const reply = await callGemini(system, question, 400)
        ?? "I couldn't work through that just now — try asking again in a moment, or check the IRS Pub 970 (US), CRA line 13010 (Canada), or ATO Division 51-10 (Australia) guidance directly.";
```

- [ ] **Step 2: Write the test file**

Check whether a test harness/mocking pattern for `_executeClassificationCore` or this specific skill already exists in `plugins/agentbook-core/backend/src/__tests__/` (e.g. `skill-routing-canonical.test.ts` or similar) before writing this from scratch — reuse its `callGemini`/`db` mocking conventions if one exists. Create `plugins/agentbook-core/backend/src/__tests__/scholarship-taxability-skill.test.ts` with tests covering: an AU-jurisdiction request's `system` prompt sent to `callGemini` contains `'Australia'` (not `'the United States'` or `'Canada'`) as the jurisdiction label, and contains the string `'Division 51-10'` in its rules; a CA-jurisdiction request's prompt is unchanged (still contains `'Canada'` and the existing CRA content, not the new AU block's presence altering CA's own answer); a US-jurisdiction request's prompt is unchanged. Mock `callGemini` to capture its `system` argument via `vi.fn()` rather than actually calling Gemini.

- [ ] **Step 3: Run the tests**

Run the new test file.
Expected: all pass.

- [ ] **Step 4: Typecheck**

Run: `cd plugins/agentbook-core/backend && npx tsc --noEmit 2>&1 | grep -i "server.ts"` (or this package's equivalent typecheck command — check `package.json` first).
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/scholarship-taxability-skill.test.ts
git commit -m "feat(student): AU (Division 51-10) scholarship-taxability content"
```

---

### Task 4: `international-student-tax-help` — AU residency/visa content + treaty-note jurisdiction bug fix

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts` (inside the `international-student-tax-help` handler)
- Test: `plugins/agentbook-core/backend/src/__tests__/international-student-tax-help-skill.test.ts` (new)

**Interfaces:** none new.

**Context — two distinct problems being fixed together, both inside this one handler:**
1. The jurisdiction-label ternary and the entire `rules` array are US-only regardless of jurisdiction (the AU gap this PR exists to close).
2. **A pre-existing, jurisdiction-independent bug**: `treatyNote` is chosen purely by `homeCountry`, never checked against `jurisdiction` — so a Canada-jurisdiction student from China is *already*, today, incorrectly told about "the US-China tax treaty." This task fixes that by gating the two verified treaty specifics (US-China, US-India — the only two this codebase has ever had verified content for) to `jurisdiction === 'us'`, and giving Canada its own honest fallback alongside the new Australia one — **this plan does not author real Canada-specific international-student content** (a separate, comparably-sized effort); Canada gets an honest "not available yet" message instead of either the pre-existing silent bug or fabricated content.

- [ ] **Step 1: Fix the jurisdiction-independent treaty bug and add the AU rules block**

Find (in `plugins/agentbook-core/backend/src/server.ts`, inside the `international-student-tax-help` handler):
```ts
      const homeCountry = (classification.tenantConfig?.homeCountry || '').toLowerCase();
      const jurisdiction = (classification.tenantConfig?.jurisdiction || 'us').toLowerCase();

      const treatyNote = homeCountry === 'cn'
        ? "Since you're from China: the US-China tax treaty (Article 20) can exempt scholarship income and a limited amount of wages from US tax — worth specifically asking Sprintax/GLACIER to check this for you."
        : homeCountry === 'in'
          ? "Since you're from India: the US-India tax treaty (Article 21) is unusual in letting Indian nonresident students claim the US standard deduction, which almost no other treaty nationality can do — make sure whichever tool you file with applies this."
          : "I don't have verified treaty specifics for your country memorized — treaty terms vary a lot and I'd rather send you to the real table than guess. Check IRS Publication 901 (tax treaty tables) or ask Sprintax/GLACIER directly; they apply this automatically when you file.";

      const rules = [
        `The user is on an international student visa (F-1/J-1 or similar), tax jurisdiction ${jurisdiction === 'ca' ? 'Canada' : 'the United States'}.`,
        'US nonresident-alien basics: F-1/J-1 students are "exempt individuals" under the Substantial Presence Test for their first 5 calendar years in the US, which means they file Form 1040-NR, not the regular 1040 that domestic students use, and generally CANNOT claim the standard deduction (an unusual exception exists for India, per treaty — see below).',
        'FICA exemption: on-campus employment, and work authorized under CPT/OPT, is exempt from FICA (Social Security + Medicare) tax withholding during nonresident status. If an employer withheld it anyway, that\'s refundable via Form 843 + Form 8316.',
        'Form 8843 is required for every F-1/J-1 visa holder every year, even with zero US income — it\'s the form that establishes exempt-individual status, not an income tax return by itself.',
        'Form 1042-S is issued instead of (or alongside) a W-2 when income is treaty-exempt or otherwise subject to nonresident withholding — if the user mentions getting one, it means some or all of that income has already had treaty rules applied by the payer.',
        `Treaty specifics: ${treatyNote}`,
        'AgentBook is not a 1040-NR filing engine — that\'s a different form with different rules than domestic tools (TurboTax/H&R Block/FreeTaxUSA) even support, and most universities already provide a licensed Sprintax or GLACIER Tax Prep seat through the international student office. Point the user there for the actual filing; AgentBook\'s job is explaining what these terms mean and tracking everyday spending in the meantime.',
        'Visa-work-authorization caveat: unlike a domestic side-hustle, F-1/J-1 students generally cannot take on arbitrary gig-platform or freelance income — only specific authorized categories (on-campus, CPT, OPT). Do not encourage untracked "side income" the way you might for a domestic student.',
      ].join('\n');

      const system = [
        'You are AgentBook, explaining nonresident-alien tax status to an international student on a visa.',
        'Use ONLY the facts given below — do not invent treaty terms, dollar thresholds, or filing mechanics not listed here.',
        'Lead with the plain-English answer to what they actually asked, then the relevant background.',
        'If the question is really "how do I file my 1040-NR," say plainly that AgentBook doesn\'t do that and point to Sprintax/GLACIER (usually free through their university).',
        'End with one sentence noting AgentBook is not a CPA, immigration advisor, or e-file agent.',
        'Plain text, 3-6 sentences, no markdown headers.',
        '',
        rules,
      ].join('\n');

      const question = String(extractedParams.question || text || 'What does nonresident alien status mean for my taxes?');
      const reply = await callGemini(system, question, 400)
        ?? "I couldn't work through that just now — Sprintax (sprintax.com) and GLACIER Tax Prep are the two main tools for nonresident student tax filing, often free through your university's international student office.";
```
Replace with:
```ts
      const homeCountry = (classification.tenantConfig?.homeCountry || '').toLowerCase();
      const jurisdiction = (classification.tenantConfig?.jurisdiction || 'us').toLowerCase();

      // Treaty specifics are US-specific facts (Article numbers, IRS treaty
      // tables) — they must never be shown to a Canada- or Australia-
      // jurisdiction student, which was a real, pre-existing bug: this used
      // to key off homeCountry alone, so a Canada-jurisdiction student from
      // China was already being told about "the US-China tax treaty."
      const treatyNote = jurisdiction !== 'us'
        ? null
        : homeCountry === 'cn'
          ? "Since you're from China: the US-China tax treaty (Article 20) can exempt scholarship income and a limited amount of wages from US tax — worth specifically asking Sprintax/GLACIER to check this for you."
          : homeCountry === 'in'
            ? "Since you're from India: the US-India tax treaty (Article 21) is unusual in letting Indian nonresident students claim the US standard deduction, which almost no other treaty nationality can do — make sure whichever tool you file with applies this."
            : "I don't have verified treaty specifics for your country memorized — treaty terms vary a lot and I'd rather send you to the real table than guess. Check IRS Publication 901 (tax treaty tables) or ask Sprintax/GLACIER directly; they apply this automatically when you file.";

      const jurisdictionLabel = jurisdiction === 'ca' ? 'Canada' : jurisdiction === 'au' ? 'Australia' : 'the United States';

      const rules = jurisdiction === 'au'
        ? [
            `The user is an international student on an Australian student visa (subclass 500 or similar), tax jurisdiction Australia.`,
            'Australian tax residency for international students is NOT determined by visa category the way the US treats F-1/J-1 status — the ATO applies the same residency tests to everyone, visa holders included (the "resides" test, the domicile test, the 183-day test). A student physically living in Australia for the duration of their course very often DOES meet the resides test and IS an Australian tax resident for tax purposes — a real structural difference from the US, where F-1/J-1 holders are automatically treated as nonresident "exempt individuals" for their first 5 calendar years regardless of how settled they are.',
            'If the student IS an Australian tax resident: they get the same tax-free threshold and file the same individual tax return via myTax as any other resident — there is no special nonresident form. If they are instead a foreign resident for tax purposes (uncommon for a full degree-length stay, but possible for a short exchange program), foreign residents are taxed from the first dollar with no tax-free threshold, at different rates on the same income — this residency-status question is the single biggest practical thing to get right, and it should be checked (via the ATO\'s own residency tests or a registered tax agent) rather than assumed from visa type alone.',
            'There is no Australian equivalent of FICA, Form 8843, or Form 1042-S — Australian tax residency isn\'t established by a standalone form the way the US uses Form 8843. Superannuation guarantee (compulsory employer retirement contributions) generally still applies to eligible student employees regardless of visa status; some temporary visa holders can claim a refund of their accumulated super — a Departing Australia Superannuation Payment (DASP) — but only after they permanently leave Australia, i.e. it\'s money returned on departure, not an upfront exemption the way the FICA carve-out is.',
            'Filing is generally simpler than the US nonresident system: myTax (via myGov) is a free ATO e-lodgment portal most students can use to self-file directly, without needing a paid specialist tool the way F-1/J-1 students effectively need Sprintax/GLACIER for Form 1040-NR. A registered tax agent is worth using if the situation is genuinely complex (multiple income sources, ambiguous residency status), not as a default requirement.',
            'Work rights: student visa holders have a capped number of work hours per fortnight during term time, but the exact cap is set by government policy and changes — don\'t state a specific number as current; tell the user to check their visa grant notice or the Department of Home Affairs website. Once working within their visa conditions, income is taxed under normal Australian rules — there is no special visa-based tax exemption for the work itself the way the US FICA exemption works.',
            `Treaty specifics: I don't have verified Australian tax-treaty specifics memorized for any home country — Australia's treaty network is entirely separate from the US's (different articles, different terms). Check the ATO's own tax treaty guidance (ato.gov.au) or ask a registered tax agent rather than trust a guess here.`,
            'AgentBook is not a myTax filing engine and is not an immigration advisor — its job here is explaining what these residency/visa/superannuation terms mean and tracking everyday spending; point the user to myTax directly, or a registered tax agent for anything genuinely complex.',
          ].join('\n')
        : jurisdiction === 'ca'
          ? [
              `The user is an international student on a Canadian study permit, tax jurisdiction Canada.`,
              "AgentBook does not yet have verified, Canada-specific international-student tax content (study-permit tax-residency rules, CRA's equivalent of the US Substantial Presence Test, or a CPP/EI exemption analog) — rather than guess or reuse US rules that do not apply in Canada, say plainly that this guidance isn't available for Canada yet and point the user to the CRA's own newcomer/international-student resources (canada.ca, search \"international students and income tax\") or a Canadian tax preparer familiar with study permits.",
            ].join('\n')
          : [
              `The user is on an international student visa (F-1/J-1 or similar), tax jurisdiction ${jurisdictionLabel}.`,
              'US nonresident-alien basics: F-1/J-1 students are "exempt individuals" under the Substantial Presence Test for their first 5 calendar years in the US, which means they file Form 1040-NR, not the regular 1040 that domestic students use, and generally CANNOT claim the standard deduction (an unusual exception exists for India, per treaty — see below).',
              'FICA exemption: on-campus employment, and work authorized under CPT/OPT, is exempt from FICA (Social Security + Medicare) tax withholding during nonresident status. If an employer withheld it anyway, that\'s refundable via Form 843 + Form 8316.',
              'Form 8843 is required for every F-1/J-1 visa holder every year, even with zero US income — it\'s the form that establishes exempt-individual status, not an income tax return by itself.',
              'Form 1042-S is issued instead of (or alongside) a W-2 when income is treaty-exempt or otherwise subject to nonresident withholding — if the user mentions getting one, it means some or all of that income has already had treaty rules applied by the payer.',
              `Treaty specifics: ${treatyNote}`,
              'AgentBook is not a 1040-NR filing engine — that\'s a different form with different rules than domestic tools (TurboTax/H&R Block/FreeTaxUSA) even support, and most universities already provide a licensed Sprintax or GLACIER Tax Prep seat through the international student office. Point the user there for the actual filing; AgentBook\'s job is explaining what these terms mean and tracking everyday spending in the meantime.',
              'Visa-work-authorization caveat: unlike a domestic side-hustle, F-1/J-1 students generally cannot take on arbitrary gig-platform or freelance income — only specific authorized categories (on-campus, CPT, OPT). Do not encourage untracked "side income" the way you might for a domestic student.',
            ].join('\n');

      const system = [
        'You are AgentBook, explaining nonresident/international-student tax status to a student on a visa.',
        'Use ONLY the facts given below — do not invent treaty terms, dollar thresholds, or filing mechanics not listed here.',
        'Lead with the plain-English answer to what they actually asked, then the relevant background.',
        'If the rules below say this jurisdiction\'s guidance isn\'t available yet, say that plainly and give the pointer provided — do not fall back to US rules.',
        'End with one sentence noting AgentBook is not a CPA, immigration advisor, or e-file agent.',
        'Plain text, 3-6 sentences, no markdown headers.',
        '',
        rules,
      ].join('\n');

      const question = String(extractedParams.question || text || 'What does my visa/residency status mean for my taxes?');
      const reply = await callGemini(system, question, 400)
        ?? (jurisdiction === 'au'
          ? "I couldn't work through that just now — myTax (via myGov) is the ATO's free e-lodgment portal most students can use directly; a registered tax agent can help with anything complex."
          : jurisdiction === 'ca'
            ? "I couldn't work through that just now — check the CRA's international-student tax resources at canada.ca, or ask a Canadian tax preparer familiar with study permits."
            : "I couldn't work through that just now — Sprintax (sprintax.com) and GLACIER Tax Prep are the two main tools for nonresident student tax filing, often free through your university's international student office.");
```

- [ ] **Step 2: Write the test file**

Create `plugins/agentbook-core/backend/src/__tests__/international-student-tax-help-skill.test.ts`, mirroring Task 3's test structure (mock `callGemini` to capture its `system` argument). Cover:
- AU jurisdiction: `system` contains `'Australia'`, `'myTax'`, `'DASP'`, and does NOT contain `'F-1/J-1'`, `'FICA'`, or `'Form 8843'`.
- CA jurisdiction: `system` contains the new honest "not yet available for Canada" message and does NOT contain any US-specific fact (`'FICA'`, `'1040-NR'`, `'Form 8843'`) — this is the regression test for the pre-existing bug this task fixes (before this task, CA got 100% US content).
- US jurisdiction + `homeCountry: 'cn'`: `system` still contains the exact existing "US-China tax treaty (Article 20)" sentence — confirms the fix didn't break the one case it must not regress.
- US jurisdiction + `homeCountry: 'ca'` (i.e. a US-jurisdiction student who happens to be a Canadian citizen — a real, plausible case distinct from CA *tax jurisdiction*): `system` contains the honest "I don't have verified treaty specifics for your country" fallback, not a fabricated one.
- CA jurisdiction + `homeCountry: 'cn'`: `system` does NOT contain "US-China tax treaty" anywhere — this is the exact bug scenario from Global Constraints, confirmed fixed.

- [ ] **Step 3: Run the tests**

Run the new test file.
Expected: all pass.

- [ ] **Step 4: Typecheck**

Run the same command as Task 3 Step 4.
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/international-student-tax-help-skill.test.ts
git commit -m "feat(student): AU residency/visa content + fix treaty-note jurisdiction bug in international-student-tax-help"
```

- [ ] **Step 6: STOP — present the new AU (and CA-honest-fallback) content to the user for review**

This step is not optional and is not satisfied by anything automated. Per this repo's own established practice for this exact class of content (see `docs/superpowers/specs/2026-07-03-scholarship-taxability-skill-content.md`, which drafted the existing US/CA content explicitly "for your review before anything ships"), show the user:
- The full new AU rules text from both Task 3 and Task 4, and the new CA-honest-fallback text from Task 4.
- A short summary of the two adjacent bugs fixed along the way (the incomplete US tax-bracket table in Task 1, and the jurisdiction-independent treaty-note bug in Task 4).
- An explicit call-out that this plan deliberately does NOT author real Canada-specific international-student content (study permits, CRA residency tests) and instead gives Canada an honest "not available yet" message in the `international-student-tax-help` skill — flag this as an accepted, tracked gap, not a hidden one, and invite the user to say if they'd rather see that authored now instead.

Wait for the user's explicit response before proceeding to Task 5's Step 2 (merge-adjacent work) or Task 6. If they request wording changes, make them, re-commit, and re-present.

---

### Task 5: Fix the two adjacent hardcoded "US/Canada forms" fallback strings

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts`

**Interfaces:** none — self-contained string changes.

**Context:** these two strings are static (not jurisdiction-conditional at all) fallback replies used when the LLM classification path is unavailable — found adjacent to the main gap during investigation, in two different files. `agent-brain.ts`'s `handleAgentMessage` is independently live production code (imported directly by 3 Next.js routes, confirmed in Global Constraints), so both are real, reachable strings.

- [ ] **Step 1: Fix `server.ts`'s fallback string**

Find:
```ts
    return "I can prep your books for filing — P&L, tax summary, and a CPA-ready export. If you want self-serve filing, AgentBook supports US/Canada forms (T1, T2125, GST/HST). Which jurisdiction are you in?";
```
Replace with:
```ts
    return "I can prep your books for filing — P&L, tax summary, and a CPA-ready export. If you want self-serve filing, AgentBook supports US, Canada, and Australia (1040, T2125, myTax/BAS). Which jurisdiction are you in?";
```

- [ ] **Step 2: Fix `agent-brain.ts`'s fallback string**

Find:
```ts
    return 'I can prep your books for filing — P&L, tax summary, and a CPA-ready export. AgentBook also supports US/Canada self-serve forms (T1, T2125, GST/HST). Which jurisdiction?';
```
Replace with:
```ts
    return 'I can prep your books for filing — P&L, tax summary, and a CPA-ready export. AgentBook also supports US, Canada, and Australia self-serve forms (1040, T2125, myTax/BAS). Which jurisdiction?';
```

- [ ] **Step 3: Check for existing tests pinning these exact strings**

Run: `grep -rn "US/Canada forms\|US/Canada self-serve" plugins/agentbook-core/backend/src/__tests__ tests/e2e 2>/dev/null`
If any test asserts on the old string verbatim, update it to the new string in the same commit. Expected: likely no hits (these are unassserted fallback strings), but verify rather than assume.

- [ ] **Step 4: Typecheck**

Run: `cd plugins/agentbook-core/backend && npx tsc --noEmit 2>&1 | grep -iE "server\.ts|agent-brain\.ts"` (adjust to this package's actual typecheck command if different).
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/agent-brain.ts
git commit -m "fix(student): mention Australia in the two static US/Canada-only fallback replies"
```

---

### Task 6: Full verification, PR, and rollout

**Files:** none (verification-only task).

- [ ] **Step 1: Confirm Task 4's review checkpoint cleared**

Before doing anything else in this task, confirm the user has explicitly approved (or approved-with-edits, already applied) the Task 4 content, per its Step 6. If not, stop and go back to Task 4 — do not proceed.

- [ ] **Step 2: Run the full affected test suites**

Run: `cd apps/web-next && npx vitest run` and (from this package's actual test command — check `plugins/agentbook-core/backend/package.json`) the agentbook-core backend's own test suite.
Expected: no failures beyond the same pre-existing/unrelated pattern already established this session (confirm any failure exists on a clean `origin/main` checkout, and isn't in a file this branch touches, before treating it as pre-existing).

- [ ] **Step 3: Typecheck both affected packages**

Run: `cd apps/web-next && npx tsc --noEmit` and the agentbook-core backend's typecheck command.
Expected: no new errors in any file this branch touches.

- [ ] **Step 4: Manual local verification**

Start the local dev servers (see this repo's `CLAUDE.md` Quick Start, including the `agentbook-core` backend on :4050 even though its Express routes for money-moves/tax-package aren't what's being changed — the chat-skill handlers this branch DOES change run through this same process when `_executeClassificationCore` is invoked). Using an AU-jurisdiction test tenant (create one or reuse `sydney@agentbook.test` if it already exists as an AU persona — check `agentbook/users.md`), confirm via the chat/agent UI:
- Asking a scholarship-taxability-triggering question (e.g. "is my scholarship taxable") gets an answer referencing Australian rules (Division 51-10, ATO), not US or Canada content.
- Asking an international-student-tax-help-triggering question gets an answer referencing Australian residency tests / myTax / superannuation, not F-1/J-1 or FICA.
- The `money-moves` proactive nudge (if triggered by seeded data close to an AU bracket boundary) shows a bracket rate matching the real AU brackets (e.g. 30%, not a US/CA rate).
- The tax-package HTML export (`/api/v1/agentbook-core/tax-package/html`) for the AU tenant shows "Medicare Levy," not "Self-Employment Tax" or "CPP Self-Employed."

- [ ] **Step 5: Final whole-branch review**

Dispatch a code-reviewer subagent pointed at the full diff from `origin/main` to this branch's HEAD. Ask it to specifically verify: (a) every claim re-derive independently which of the 6 original occurrences plus the 2 adjacent fallback strings were actually fixed, cross-checked against this plan's own Task list, so nothing was silently skipped; (b) the `international-student-tax-help` treaty-note fix genuinely eliminates the pre-existing CA+China bug (re-derive by tracing the `jurisdiction !== 'us' ? null : ...` logic by hand for every jurisdiction × home-country combination this handler can see); (c) confirm the two Next.js route files (Tasks 1–2) are genuinely what's served in production and the `server.ts` Express duplicates were correctly left untouched, by independently re-tracing the import chain from Global Constraints rather than trusting this plan's own claim; (d) confirm no new AU/CA content anywhere invents a dollar figure, treaty article number, or ATO ruling that isn't either a stable structural fact or explicitly hedged as "verify/check."

- [ ] **Step 6: Push, open PR, wait for CI**

Follow this session's established pattern: push the branch, open a PR describing the fix (explicitly noting in the PR description that the new AU tax-guidance content was reviewed and approved by the user before merge — reference how/when that happened, matching Launch-gap PR-7's PR description pattern). Wait for CI. The chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure pattern (confirmed unrelated to this branch's diff) is expected and safe to merge past once independently re-confirmed via `gh run view --job --log` for this specific PR's run.

- [ ] **Step 7: Production rollout**

This PR has no schema migration and no production-data write of any kind — it's a pure code/content deploy. After merge: deploy via the established `vercel build --prod` + `vercel deploy --prebuilt --prod` flow (no plugin frontend rebuild needed — this PR touches no frontend/UI files, only backend route handlers and the shared agent-brain skill-dispatch logic). Manually verify in production: log in as an AU persona (or a tenant with `jurisdiction: 'au'` set) and ask the scholarship-taxability and international-student-tax-help questions via the real chat interface, confirming Australian content comes back, not US/Canada content.
