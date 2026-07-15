# Tax Fast-Track AU Jurisdiction Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register Australia as a third supported jurisdiction for the tax fast-track feature (questionnaire + filing draft + client letter), mirroring the existing `us`/`ca` pattern exactly, with zero UK work.

**Architecture:** Two new pure prompt-builder classes (`AuTaxQuestionnairePack`, `AuFilingDraftPack`) implementing the same interfaces `Us`/`Ca` already implement, registered in the two existing loader modules, plus a one-line addition wiring the already-implemented `auTaxBrackets` into the fast-track compute module's hardcoded provider map. No schema changes, no new routes, no new UI — the feature is already fully jurisdiction-generic once a jurisdiction is registered.

**Tech Stack:** TypeScript, vitest (existing `packages/agentbook-jurisdictions` test setup).

## Global Constraints

- The numeric tax estimate must NEVER come from the LLM. `AuFilingDraftPack.extractDeltasPrompt` only extracts structured deltas (`incomeDeltaPercent`, etc.); the real number comes from `auTaxBrackets.calculateTax()`, wired in via `tax-fast-track-draft-compute.ts`'s `TAX_BRACKET_PROVIDERS` map (Task 3). This is the single most important invariant in this feature (see `interfaces.ts`'s own comment above `FilingDraftDeltas`).
- Both new pack classes must be pure and synchronous — no LLM calls, no I/O, no imports beyond `../interfaces.js` and (for `AuFilingDraftPack`, not needed here) nothing else. Exactly like `Ca`/`UsTaxQuestionnairePack`/`FilingDraftPack`.
- Currency formatting uses `en-AU` locale (`$${(cents / 100).toLocaleString('en-AU')}`), matching `AuPastFilingPack`'s own convention (`packages/agentbook-jurisdictions/src/au/past-filing-pack.ts`).
- Terminology must match what's already established elsewhere in this codebase's AU modules: "ATO", "myGov" (income statement), "Medicare Levy" (not "self-employment tax"), "GST" (not "sales tax"), "superannuation"/"super guarantee", "BAS" (Business Activity Statement, quarterly), "sole trader" (not "self-employed individual").
- AU's GST compulsory-registration threshold is **$75,000** annual turnover — this is a real, checkable number (do not confuse with CA's $30,000 GST/HST threshold or any other jurisdiction's figure).
- No UK code is added, modified, or referenced anywhere in this plan.
- No changes to `us/*`, `ca/*`, `au/tax-brackets.ts`, `au/self-employment-tax.ts`, `au/sales-tax.ts`, `au/past-filing-pack.ts`, or any other existing file beyond the three named in Task 3's Files section.

---

### Task 1: `AuTaxQuestionnairePack`

**Files:**
- Create: `packages/agentbook-jurisdictions/src/au/tax-questionnaire-pack.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/au-tax-questionnaire-pack.test.ts`

**Interfaces:**
- Consumes: `TaxQuestionnairePack`, `StandardTaxExtract` from `../interfaces.js` (existing, unmodified).
- Produces: `AuTaxQuestionnairePack` class, consumed by Task 3's loader registration.

- [ ] **Step 1: Write the failing test**

Create `packages/agentbook-jurisdictions/src/__tests__/au-tax-questionnaire-pack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AuTaxQuestionnairePack } from '../au/tax-questionnaire-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const pack = new AuTaxQuestionnairePack();

describe('AuTaxQuestionnairePack', () => {
  it('has jurisdiction set to "au"', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  describe('nextQuestionPrompt', () => {
    it('reflects the qaHistory entries passed in', () => {
      const prompt = pack.nextQuestionPrompt({
        qaHistory: [
          { question: 'Are you still trading as a sole trader?', answer: 'Yes, same as last year' },
        ],
      });
      expect(prompt).toContain('Are you still trading as a sole trader?');
      expect(prompt).toContain('Yes, same as last year');
    });

    it('reflects a priorFiling known field', () => {
      const priorFiling: StandardTaxExtract = {
        formType: 'income-statement',
        taxYear: 2025,
        jurisdiction: 'au',
        region: 'NSW',
        totalIncomeCents: 9500000,
        taxableIncomeCents: 8800000,
        savingsRoomCents: 600000,
        formFields: {},
        attachedForms: {},
        confidence: 0.9,
      };
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], priorFiling });
      expect(prompt).toContain('$95,000');
      expect(prompt).toContain('$88,000');
      expect(prompt).toContain('NSW');
      expect(prompt).toContain('$6,000');
    });

    it('reflects the profile block when provided', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], profile: 'Client is a sole trader graphic designer in Sydney, NSW.' });
      expect(prompt).toContain('Client is a sole trader graphic designer in Sydney, NSW.');
    });

    it('instructs the LLM to skip anything already answered or already known', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toMatch(/do not ask|Do NOT ask/i);
    });

    it('instructs the LLM to reply with exactly one line of JSON, no markdown fences', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toContain('{"question"');
      expect(prompt).toContain('{"done": true}');
      expect(prompt).toMatch(/no markdown code fences/i);
    });

    it('is Australia-specific in content (ATO, myGov, GST $75,000 threshold, superannuation, Medicare Levy)', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toContain('ATO');
      expect(prompt).toContain('myGov');
      expect(prompt).toContain('$75,000');
      expect(prompt).toContain('superannuation');
      expect(prompt).toContain('Medicare Levy');
      expect(prompt).toContain('sole trader');
    });
  });

  describe('parseNextQuestionResponse', () => {
    it('returns {question} for a valid question shape', () => {
      expect(pack.parseNextQuestionResponse({ question: 'Did your business structure change this year?' })).toEqual({
        question: 'Did your business structure change this year?',
      });
    });

    it('returns {done: true} for a valid done shape', () => {
      expect(pack.parseNextQuestionResponse({ done: true })).toEqual({ done: true });
    });

    it('throws on a malformed shape missing both fields', () => {
      expect(() => pack.parseNextQuestionResponse({ foo: 'bar' })).toThrow(/Unexpected questionnaire response shape/);
    });

    it('throws on a completely different shape', () => {
      expect(() => pack.parseNextQuestionResponse('just a string')).toThrow(/Unexpected questionnaire response shape/);
      expect(() => pack.parseNextQuestionResponse(null)).toThrow(/Unexpected questionnaire response shape/);
      expect(() => pack.parseNextQuestionResponse({ question: '' })).toThrow(/Unexpected questionnaire response shape/);
      expect(() => pack.parseNextQuestionResponse({ done: false })).toThrow(/Unexpected questionnaire response shape/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-tax-questionnaire-pack.test.ts`
Expected: FAIL — `Cannot find module '../au/tax-questionnaire-pack.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/agentbook-jurisdictions/src/au/tax-questionnaire-pack.ts`:

```ts
import type { TaxQuestionnairePack, StandardTaxExtract } from '../interfaces.js';

export class AuTaxQuestionnairePack implements TaxQuestionnairePack {
  jurisdiction = 'au';

  nextQuestionPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling?: StandardTaxExtract;
    profile?: string;
  }): string {
    const { qaHistory, priorFiling, profile } = input;

    const qaBlock = qaHistory.length
      ? qaHistory.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join('\n')
      : '(none yet — this is the first question)';

    const priorFilingBlock = priorFiling
      ? `- Form type: ${priorFiling.formType} (tax year ${priorFiling.taxYear})
- State/territory: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Prior-year tax payable: ${priorFiling.taxPayableCents != null ? `$${(priorFiling.taxPayableCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Super guarantee contributions on file: ${priorFiling.savingsRoomCents != null ? `$${(priorFiling.savingsRoomCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`
      : '(no prior filing on file)';

    const profileBlock = profile ? profile : '(no profile on file)';

    return `You are an experienced Australian tax agent (registered with the ATO) conducting a short intake interview with a client to fast-track this year's individual tax return, using last year's myGov/ATO-assessed filing as your starting point. You ask ONE short, natural, conversational question at a time — never a list, never more than one question per turn.

Your job this turn: look at what's already known (below) and ask the single most useful next question to fill the biggest remaining gap. Typical topics an Australian tax agent needs to nail down, roughly in the order they usually matter (skip any of these you can already answer from the information below):
- Business structure this year — whether the client is still trading as a sole trader, or whether they've since incorporated as a company, formed a partnership, or set up a trust, since this changes which return type applies.
- Income sources this year — the same employer(s) issuing a myGov income statement as last year, any new business or freelance income, any investment income (dividends, interest, managed funds).
- GST registration status — whether the client's business turnover has crossed (or is about to cross) the $75,000 compulsory GST-registration threshold this year, if they weren't already registered.
- Superannuation — any extra voluntary super contributions made this year (concessional or non-concessional), beyond the employer super guarantee already on file.
- Private health insurance status changes this year, since this affects Medicare Levy Surcharge liability.
- Anything else materially different from last year's return that would change the filing (a property sale/purchase, a change in HECS-HELP balance, new work-related deductions, an ABN registered or cancelled).

Do NOT ask about anything already answered in the Q&A history below, and do NOT ask about anything already present in the prior filing or profile summary below — treat those as known facts, not things to re-confirm. If, having reviewed everything below, there is nothing further worth asking, say you're done instead of manufacturing a question.

--- Q&A so far this session ---
${qaBlock}

--- Prior year's confirmed filing (already known — do not re-ask) ---
${priorFilingBlock}

--- Client profile summary (already known — do not re-ask) ---
${profileBlock}

Respond with EXACTLY one line of JSON and nothing else — no markdown code fences, no explanation, no extra prose before or after it. Shape it as either:
{"question": "<your single next question, in plain conversational English>"}
or, if you now have enough information to proceed:
{"done": true}`;
  }

  parseNextQuestionResponse(parsed: unknown): { question: string } | { done: true } {
    const r = parsed as any;
    if (r && typeof r.question === 'string' && r.question.trim().length > 0) {
      return { question: r.question };
    }
    if (r && r.done === true) {
      return { done: true };
    }
    throw new Error('Unexpected questionnaire response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-tax-questionnaire-pack.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agentbook-jurisdictions/src/au/tax-questionnaire-pack.ts packages/agentbook-jurisdictions/src/__tests__/au-tax-questionnaire-pack.test.ts
git commit -m "feat(tax-fast-track): AuTaxQuestionnairePack (PR-7, Task 1)"
```

---

### Task 2: `AuFilingDraftPack`

**Files:**
- Create: `packages/agentbook-jurisdictions/src/au/filing-draft-pack.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/au-filing-draft-pack.test.ts`

**Interfaces:**
- Consumes: `FilingDraftPack`, `FilingDraftDeltas`, `FilingDraftSummary`, `StandardTaxExtract` from `../interfaces.js` (existing, unmodified).
- Produces: `AuFilingDraftPack` class, consumed by Task 3's loader registration.

- [ ] **Step 1: Write the failing test**

Create `packages/agentbook-jurisdictions/src/__tests__/au-filing-draft-pack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AuFilingDraftPack } from '../au/filing-draft-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const priorFiling: StandardTaxExtract = {
  formType: 'income-statement', taxYear: 2025, jurisdiction: 'au', region: 'NSW',
  totalIncomeCents: 9500000, taxableIncomeCents: 8800000,
  formFields: {}, attachedForms: {}, confidence: 0.9,
};

describe('AuFilingDraftPack', () => {
  const pack = new AuFilingDraftPack();

  it('has jurisdiction set to "au"', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  it('extractDeltasPrompt includes the prior filing baseline and qa history', () => {
    const prompt = pack.extractDeltasPrompt({
      qaHistory: [{ question: 'Still a sole trader?', answer: 'Yes, same as last year' }],
      priorFiling,
    });
    expect(prompt).toContain('$95,000');
    expect(prompt).toContain('Still a sole trader?');
    expect(prompt).toContain('Yes, same as last year');
    expect(prompt).toContain('income-statement');
    expect(prompt).toContain('State/territory');
  });

  it('extractDeltasPrompt asks about GST threshold and super contribution changes as bullet topics', () => {
    const prompt = pack.extractDeltasPrompt({ qaHistory: [], priorFiling });
    expect(prompt).toContain('$75,000');
    expect(prompt).toMatch(/superannuation|super contribution/i);
  });

  it('parseDeltas extracts a full response', () => {
    const deltas = pack.parseDeltas({
      incomeDeltaPercent: 8, dependentsDelta: 0,
      changesFromLastYear: ['Crossed the $75,000 GST threshold, now registered'],
      openQuestions: ['Confirm first BAS lodgment date'],
    });
    expect(deltas.incomeDeltaPercent).toBe(8);
    expect(deltas.changesFromLastYear).toEqual(['Crossed the $75,000 GST threshold, now registered']);
  });

  it('parseDeltas defaults missing arrays to empty rather than throwing', () => {
    const deltas = pack.parseDeltas({});
    expect(deltas.changesFromLastYear).toEqual([]);
    expect(deltas.openQuestions).toEqual([]);
    expect(deltas.incomeDeltaPercent).toBeUndefined();
  });

  it('parseDeltas throws on a non-object response', () => {
    expect(() => pack.parseDeltas('not an object')).toThrow('Unexpected delta-extraction response shape');
  });

  it('clientLetterPrompt includes the estimated figures when present, in AU terms', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [],
      priorFiling,
      summary: {
        estimatedTotalIncomeCents: 10200000, estimatedTaxableIncomeCents: 9400000,
        estimatedTaxPayableCents: 1800000, taxPayableDeltaVsLastYearCents: 60000,
        changesFromLastYear: ['Crossed the $75,000 GST threshold, now registered'], openQuestions: [], caveat: 'This is an estimate.',
      },
    });
    expect(prompt).toContain('$18,000');
    expect(prompt).toContain('up $600');
    expect(prompt).toContain('ATO');
    expect(prompt).toMatch(/BAS/);
  });

  it('clientLetterPrompt degrades gracefully when no numeric estimate is available', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [], priorFiling,
      summary: { changesFromLastYear: [], openQuestions: [], caveat: 'This is an estimate.' },
    });
    expect(prompt).toContain('no numeric estimate available');
  });

  it('parseClientLetter extracts letterBody', () => {
    const result = pack.parseClientLetter({ letterBody: 'Dear Accountant,\n\nHere is my summary.' });
    expect(result.letterBody).toContain('Dear Accountant');
  });

  it('parseClientLetter throws on a missing letterBody', () => {
    expect(() => pack.parseClientLetter({})).toThrow('Unexpected client-letter response shape');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-filing-draft-pack.test.ts`
Expected: FAIL — `Cannot find module '../au/filing-draft-pack.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/agentbook-jurisdictions/src/au/filing-draft-pack.ts`:

```ts
import type { FilingDraftPack, FilingDraftDeltas, FilingDraftSummary, StandardTaxExtract } from '../interfaces.js';

export class AuFilingDraftPack implements FilingDraftPack {
  jurisdiction = 'au';

  extractDeltasPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
  }): string {
    const { qaHistory, priorFiling } = input;
    const qaBlock = qaHistory.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join('\n');
    const priorFilingBlock = `- Form type: ${priorFiling.formType} (tax year ${priorFiling.taxYear})
- State/territory: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`;

    return `You are an experienced Australian tax agent reviewing a completed client intake interview to identify what's DIFFERENT about this year's individual tax return compared to last year's confirmed ATO-assessed filing. You do NOT calculate any tax figures yourself — that happens separately from the real ATO bracket table. Your only job is to extract structured signal from the interview answers below.

--- Prior year's confirmed filing (baseline) ---
${priorFilingBlock}

--- This year's intake interview ---
${qaBlock}

From the interview, determine:
- Roughly how this year's total income compares to last year's, as a signed percentage (e.g. +5 for "a little higher", -10 for "noticeably lower", omit entirely if the client gave no usable signal on income).
- The net change in number of dependents (a signed integer; 0 if explicitly unchanged, omit if not discussed).
- A short list of plain-language bullets describing what's materially different from last year — a change in business structure (sole trader to company/partnership/trust or vice versa), crossing the $75,000 GST compulsory-registration threshold, extra voluntary superannuation contributions made this year, a change in private health insurance affecting the Medicare Levy Surcharge, or any other material change (skip this if nothing changed).
- A short list of open questions this client's accountant/tax agent should double-check before lodging.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"incomeDeltaPercent": <number, optional>, "dependentsDelta": <number, optional>, "changesFromLastYear": ["<bullet>", ...], "openQuestions": ["<bullet>", ...]}`;
  }

  parseDeltas(parsed: unknown): FilingDraftDeltas {
    const r = parsed as any;
    if (!r || typeof r !== 'object') {
      throw new Error('Unexpected delta-extraction response shape: ' + JSON.stringify(parsed));
    }
    return {
      incomeDeltaPercent: typeof r.incomeDeltaPercent === 'number' ? r.incomeDeltaPercent : undefined,
      dependentsDelta: typeof r.dependentsDelta === 'number' ? r.dependentsDelta : undefined,
      changesFromLastYear: Array.isArray(r.changesFromLastYear) ? r.changesFromLastYear.filter((x: unknown) => typeof x === 'string') : [],
      openQuestions: Array.isArray(r.openQuestions) ? r.openQuestions.filter((x: unknown) => typeof x === 'string') : [],
    };
  }

  clientLetterPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
    summary: FilingDraftSummary;
  }): string {
    const { summary } = input;
    const numbersBlock = summary.estimatedTaxPayableCents != null
      ? `- Estimated total income: ${summary.estimatedTotalIncomeCents != null ? `$${(summary.estimatedTotalIncomeCents / 100).toLocaleString('en-AU')}` : 'not estimated'}
- Estimated taxable income: ${summary.estimatedTaxableIncomeCents != null ? `$${(summary.estimatedTaxableIncomeCents / 100).toLocaleString('en-AU')}` : 'not estimated'}
- Estimated tax payable: $${(summary.estimatedTaxPayableCents / 100).toLocaleString('en-AU')}
- Compared to last year's actual tax payable: ${summary.taxPayableDeltaVsLastYearCents != null ? `${summary.taxPayableDeltaVsLastYearCents >= 0 ? 'up' : 'down'} $${Math.abs(summary.taxPayableDeltaVsLastYearCents / 100).toLocaleString('en-AU')}` : 'not available (no prior-year tax payable on file to compare against)'}
(Note: this does NOT account for PAYG withholding or instalments made this year, so it is not a refund-or-balance-owing figure — just how the underlying tax liability compares to last year. This estimate also does not include the Medicare Levy or any Medicare Levy Surcharge, which are calculated separately.)`
      : '(no numeric estimate available — the prior filing on file did not have enough baseline data to compute one)';

    return `Write a short, professional cover letter from a sole trader/individual taxpayer to their own registered tax agent or accountant, to accompany this year's tax return preparation. The letter should:
- Be addressed generically ("Dear [Tax agent's name]," is fine as a placeholder)
- State plainly that this is a fast-tracked estimate prepared with the help of an AI assistant, based on last year's ATO-assessed return plus this year's changes — not a final calculation, and not a lodged return
- Summarize what changed this year (below)
- Include the estimated figures (below), clearly labeled as estimates
- If the changes mention new GST registration, note that quarterly BAS lodgment obligations will now apply and the tax agent should confirm the first lodgment date
- List the open questions the tax agent should double-check
- Close politely, offering to answer any follow-up questions

--- What changed this year ---
${summary.changesFromLastYear.length ? summary.changesFromLastYear.map((c) => `- ${c}`).join('\n') : '- No material changes identified'}

--- Estimated figures ---
${numbersBlock}

--- Open questions for the tax agent ---
${summary.openQuestions.length ? summary.openQuestions.map((q) => `- ${q}`).join('\n') : '- None identified'}

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"letterBody": "<the full letter text, with \\n for paragraph breaks>"}`;
  }

  parseClientLetter(parsed: unknown): { letterBody: string } {
    const r = parsed as any;
    if (r && typeof r.letterBody === 'string' && r.letterBody.trim().length > 0) {
      return { letterBody: r.letterBody };
    }
    throw new Error('Unexpected client-letter response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-filing-draft-pack.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agentbook-jurisdictions/src/au/filing-draft-pack.ts packages/agentbook-jurisdictions/src/__tests__/au-filing-draft-pack.test.ts
git commit -m "feat(tax-fast-track): AuFilingDraftPack (PR-7, Task 2)"
```

---

### Task 3: Register AU + verify end-to-end

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/tax-questionnaire-loader.ts`
- Modify: `packages/agentbook-jurisdictions/src/filing-draft-loader.ts`
- Modify: `plugins/agentbook-core/backend/src/tax-fast-track-draft-compute.ts`

**Interfaces:**
- Consumes: `AuTaxQuestionnairePack` (Task 1), `AuFilingDraftPack` (Task 2), `auTaxBrackets` (existing, unmodified, from `packages/agentbook-jurisdictions/src/au/tax-brackets.ts`).
- Produces: `au` becomes a member of `listSupportedJurisdictions()`'s return value and `TAX_BRACKET_PROVIDERS`'s keys — nothing downstream needs new interfaces, since both loaders and the compute module were already written generically.

- [ ] **Step 1: Update `tax-questionnaire-loader.ts`**

Find:
```ts
import type { TaxQuestionnairePack } from './interfaces.js';
import { CaTaxQuestionnairePack } from './ca/tax-questionnaire-pack.js';
import { UsTaxQuestionnairePack } from './us/tax-questionnaire-pack.js';
// au/uk deliberately NOT registered — matching past-filing-loader.ts's stated
// scope for this new capability (see the design spec's "Revised: pack interface").

const PACKS: Record<string, TaxQuestionnairePack> = {
  ca: new CaTaxQuestionnairePack(),
  us: new UsTaxQuestionnairePack(),
};
```

Replace with:
```ts
import type { TaxQuestionnairePack } from './interfaces.js';
import { CaTaxQuestionnairePack } from './ca/tax-questionnaire-pack.js';
import { UsTaxQuestionnairePack } from './us/tax-questionnaire-pack.js';
import { AuTaxQuestionnairePack } from './au/tax-questionnaire-pack.js';
// uk deliberately NOT registered — no UK TaxQuestionnairePack/FilingDraftPack
// exists yet (out of scope for PR-7; see docs/superpowers/specs/2026-07-14-tax-fast-track-au-design.md).

const PACKS: Record<string, TaxQuestionnairePack> = {
  ca: new CaTaxQuestionnairePack(),
  us: new UsTaxQuestionnairePack(),
  au: new AuTaxQuestionnairePack(),
};
```

- [ ] **Step 2: Update `filing-draft-loader.ts`**

Find:
```ts
import type { FilingDraftPack } from './interfaces.js';
import { CaFilingDraftPack } from './ca/filing-draft-pack.js';
import { UsFilingDraftPack } from './us/filing-draft-pack.js';
// au/uk deliberately NOT registered — matching tax-questionnaire-loader.ts's
// scope (the questionnaire itself only supports us/ca, so a filing draft
// can never be generated for any other jurisdiction).

const PACKS: Record<string, FilingDraftPack> = {
  ca: new CaFilingDraftPack(),
  us: new UsFilingDraftPack(),
};
```

Replace with:
```ts
import type { FilingDraftPack } from './interfaces.js';
import { CaFilingDraftPack } from './ca/filing-draft-pack.js';
import { UsFilingDraftPack } from './us/filing-draft-pack.js';
import { AuFilingDraftPack } from './au/filing-draft-pack.js';
// uk deliberately NOT registered — no UK FilingDraftPack exists yet (out of
// scope for PR-7; see docs/superpowers/specs/2026-07-14-tax-fast-track-au-design.md).

const PACKS: Record<string, FilingDraftPack> = {
  ca: new CaFilingDraftPack(),
  us: new UsFilingDraftPack(),
  au: new AuFilingDraftPack(),
};
```

- [ ] **Step 3: Update `tax-fast-track-draft-compute.ts`**

Find:
```ts
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';
import { cleanJson, type CallGeminiFn } from './tax-questionnaire-core.js';

// Direct imports, NOT getJurisdictionPack()/loadBuiltInPacks() — see this
// plan's Global Constraints for why that loader is unsafe here.
const TAX_BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
};
```

Replace with:
```ts
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';
import { cleanJson, type CallGeminiFn } from './tax-questionnaire-core.js';

// Direct imports, NOT getJurisdictionPack()/loadBuiltInPacks() — see this
// plan's Global Constraints for why that loader is unsafe here.
const TAX_BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};
```

- [ ] **Step 4: Verify no other test needs updating**

Run: `grep -rn "listSupportedJurisdictions\|TAX_BRACKET_PROVIDERS" plugins/agentbook-core/backend/src/__tests__/ packages/agentbook-jurisdictions/src/__tests__/`

Confirm `start-tax-fast-track-skill.test.ts`'s `listSupportedJurisdictions: vi.fn(() => ['us', 'ca'])` mock is testing the skill's own gating logic against a *mocked* loader (not the real one) — it does not need `au` added, since it's verifying generic blocked/allowed behavior, not real jurisdiction content. Confirm this by reading the test assertions around that mock before concluding no change is needed; if any assertion specifically asserts on the *literal list* `['us', 'ca']` in a way that would now be misleading (e.g. asserting the blocked-message text lists exactly those two), note it but do not change the mock's jurisdiction list arbitrarily — that mock is intentionally independent of the real loader's contents.

- [ ] **Step 5: Run the full relevant test suites**

Run: `cd packages/agentbook-jurisdictions && npx vitest run`
Expected: all pass, including the two new AU test files, no regressions to `ca`/`us` tests.

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: no new failures beyond whatever pre-existing/unrelated failures already exist on this branch's base commit (confirm via `git stash`/`git stash pop` comparison if any unexpected failure appears).

- [ ] **Step 6: Manual verification**

Using a local dev environment (or the isolated verify DB per this session's established practice — never the shared local DB destructively), set a test tenant's `AbTenantConfig.jurisdiction` to `'au'` and call `POST /api/v1/agentbook-core/tax-fast-track/start`. Confirm the response is no longer the "isn't available for your jurisdiction yet" blocked message — it should proceed to create a session (or return whatever the next real gate is, e.g. requiring a prior AU past filing to exist, which is expected and correct — the AU past-filing pack already exists from a prior PR).

- [ ] **Step 7: Commit**

```bash
git add packages/agentbook-jurisdictions/src/tax-questionnaire-loader.ts packages/agentbook-jurisdictions/src/filing-draft-loader.ts plugins/agentbook-core/backend/src/tax-fast-track-draft-compute.ts
git commit -m "feat(tax-fast-track): register AU jurisdiction in both loaders + bracket map (PR-7, Task 3)"
```

---

## Post-implementation notes (not a task — for whoever runs the final verification)

- No schema migration, no billing/monetization change, no new routes, no new UI — this PR is purely additive registration of two new pure-function classes plus a one-line bracket-map addition.
- No manual production DB step expected; the normal build-time flow applies.
- Since there's no new e2e-observable surface (no new route, no new UI element), a full prod e2e re-verification is optional — the existing tax-fast-track e2e specs already exercise the generic flow, and this PR's correctness is entirely a unit-test concern (the prompt content and parsing). If desired, a lightweight manual check against a real AU-jurisdiction test tenant in production (per Step 6, run against the deployed environment) is sufficient confirmation.
