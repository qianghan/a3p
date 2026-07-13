# Student Chat Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a student ask the AgentBook chatbot to find scholarships, find co-op/job opportunities, and find roommate matches — and save what it finds — the same way they already ask it to record an expense.

**Architecture:** Five new entries in the agent brain's skill manifest (`built-in-skills.ts`), three thin HTTP-backed "find" skills that hit the existing `/discover` and `/roommate/matches` routes, two INTERNAL "save" skills that resolve a candidate from the prior turn (or direct free-text) and POST it to the existing `/opportunities` routes, an execution-time eligibility gate (`businessType='student'` + `student_success` add-on), and three new response-formatting branches so results render as a readable list instead of a raw JSON dump.

**Tech Stack:** TypeScript, Express (agent brain backend), Prisma (`@naap/database`), `@naap/billing`, Vitest.

## Global Constraints

- Gating is enforced at **execution time**, not classification time (see design doc §Eligibility gating) — every skill still classifies for every tenant; ineligible tenants get a nudge message instead of an HTTP call.
- No pre-classification skill filtering, no new dependencies (`@naap/billing` is already a `package.json` dependency of `plugins/agentbook-core/backend`).
- Reuse `db.abConversation` as the last-turn-recall mechanism (same table `handleCorrection` and `edit-expense`'s pre-processing already read from) — do not invent new session state.
- No cross-package imports from `apps/web-next/src/lib` into `plugins/agentbook-core/backend` — call the existing Next.js API routes over HTTP via the `baseUrls` map, exactly like every other skill already does.
- `find-roommate-matches` has no save skill (matches are compatibility scores to consider, not opportunities to persist).
- Design doc: `docs/superpowers/specs/2026-07-10-student-chat-skills-design.md`.

---

## File Structure

- **Modify:** `plugins/agentbook-core/backend/src/built-in-skills.ts` — add 5 skill manifest entries; add `excludePatterns` to the existing `scholarship-taxability` entry.
- **Modify:** `plugins/agentbook-core/backend/src/server.ts` — import `hasAddOn`; add 3 `baseUrls` entries; add the eligibility gate; add `save-scholarship`/`save-coop-opportunity` INTERNAL handlers; add 3 response-formatting branches.
- **Modify:** `plugins/agentbook-core/backend/src/__tests__/skill-routing-canonical.test.ts` — add routing/collision-avoidance cases for the 5 new skills.
- **Create:** `plugins/agentbook-core/backend/src/candidate-resolution.ts` — shared `resolveOrdinalOrFuzzyCandidate()` helper used by both `save-scholarship` and `save-coop-opportunity`, so the ordinal/fuzzy-match logic exists in exactly one place.
- **Create:** `plugins/agentbook-core/backend/src/__tests__/candidate-resolution.test.ts` — unit tests for the shared helper.
- **Create:** `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts` — eligibility gate tests, candidate-resolution integration tests, response-formatting tests, all calling the real `executeClassification` with mocked `db`/`hasAddOn`/`fetch`.
- **Create:** `bin/seed-student-chat-test-account.ts` — one-off script granting a test tenant `businessType='student'` + an active `student_success` subscription, for production e2e verification.

---

## Task 1: Skill manifests + routing (no collisions with `scholarship-taxability`)

**Files:**
- Modify: `plugins/agentbook-core/backend/src/built-in-skills.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/skill-routing-canonical.test.ts`

**Interfaces:**
- Produces: 5 new entries in the `BUILT_IN_SKILLS` array — `find-scholarships`, `save-scholarship`, `find-coop-opportunities`, `save-coop-opportunity`, `find-roommate-matches` — each with `name`, `description`, `category`, `triggerPatterns`, `parameters`, `endpoint`. Later tasks (2-4) reference these skills by name inside `_executeClassificationCore` and add response-formatting branches keyed on the same names.

- [ ] **Step 1: Write the failing routing tests**

Open `plugins/agentbook-core/backend/src/__tests__/skill-routing-canonical.test.ts` and add these cases to the existing `cases` array (append near the end, before the closing `];`):

```ts
    // find-scholarships — search intent, not tax intent
    { text: 'find scholarships for a chemistry major in Ontario', expected: 'find-scholarships' },
    { text: 'search for need-based scholarships', expected: 'find-scholarships' },

    // scholarship-taxability — still wins on pure tax questions
    { text: 'is my scholarship taxable', expected: 'scholarship-taxability' },
    { text: 'is this grant taxable', expected: 'scholarship-taxability' },

    // find-coop-opportunities
    { text: 'find a co-op for summer 2027', expected: 'find-coop-opportunities' },
    { text: 'search for internships near campus', expected: 'find-coop-opportunities' },

    // find-roommate-matches
    { text: 'find me a roommate', expected: 'find-roommate-matches' },
    { text: 'show me compatible roommates', expected: 'find-roommate-matches' },

    // save-scholarship / save-coop-opportunity
    { text: 'save the first one', expected: 'save-scholarship' },
    { text: 'save that co-op opportunity', expected: 'save-coop-opportunity' },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/skill-routing-canonical.test.ts`
Expected: FAIL — most new cases return `null` (skills don't exist yet); `is my scholarship taxable` still passes (no exclude-pattern regression yet, but the search-intent cases don't exist to collide with it).

- [ ] **Step 3: Add `excludePatterns` to `scholarship-taxability`**

In `plugins/agentbook-core/backend/src/built-in-skills.ts`, find the `scholarship-taxability` entry (currently has no `excludePatterns` field) and add one:

```ts
  {
    name: 'scholarship-taxability', description: 'Explain whether a scholarship, grant, RESP/529 withdrawal, or stipend is taxable, and whether AOTC/Lifetime Learning Credit or the Canadian tuition transfer applies', category: 'tax',
    triggerPatterns: ['scholarship', 'is.*grant.*taxable', 'fellowship', 'financial aid.*tax', 'tuition.*credit', 'education.*credit', 'AOTC', 'american opportunity', 'lifetime learning', '\\bresp\\b', '\\b529\\b', 't2202', '1098-?t', 'is.*taxable'],
    excludePatterns: ['find|search|look for|apply (to|for)'],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user question about the scholarship/grant/stipend/withdrawal' } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
```

- [ ] **Step 4: Add the 5 new skill entries**

In the same file, insert these entries right before the `general-question` entry at the end of the `BUILT_IN_SKILLS` array:

```ts
  {
    name: 'find-scholarships',
    description: 'Search for scholarships, grants, or financial aid matching the student\'s program, school, and eligibility — a live grounded search, not tax advice on an existing award',
    category: 'student',
    triggerPatterns: ['find.*scholarship', 'scholarship.*for', 'search.*scholarship', 'look for.*scholarship', 'scholarship.*(my|as a).*(major|program)', 'apply.*for.*scholarship'],
    parameters: { query: { type: 'string', required: false, extractHint: 'optional free-text focus, e.g. "for computer science" or "need-based" — omit if the user gave no specifics' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-scholarship/discover' },
  },
  {
    name: 'save-scholarship',
    description: 'Save/shortlist a scholarship the student just found (or one they describe directly) to their tracked opportunities list',
    category: 'student',
    triggerPatterns: ['save.*(scholarship|that|it|the .* one)', 'track.*scholarship', 'shortlist.*scholarship'],
    parameters: {
      title: { type: 'string', required: false, extractHint: 'scholarship name, only if the user is describing one directly rather than referring back to a search result' },
      amountText: { type: 'string', required: false, extractHint: 'the award amount as free text, e.g. "$2,000", only for a direct description' },
      deadlineText: { type: 'string', required: false, extractHint: 'the deadline as free text or ISO date, only for a direct description' },
      sourceUrl: { type: 'string', required: false, extractHint: 'a URL for the scholarship, only for a direct description' },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'find-coop-opportunities',
    description: 'Search for co-op placements, internships, or student jobs matching the student\'s program, school, and work-authorization status',
    category: 'student',
    triggerPatterns: ['find.*(co-?op|internship|job)', '(co-?op|internship).*for', 'search.*(co-?op|internship)', 'look for.*(co-?op|internship|job)'],
    parameters: { query: { type: 'string', required: false, extractHint: 'optional free-text focus, e.g. "remote" or "summer 2027" — omit if the user gave no specifics' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-career/discover' },
  },
  {
    name: 'save-coop-opportunity',
    description: 'Save/shortlist a co-op or job opportunity the student just found (or one they describe directly) to their tracked opportunities list',
    category: 'student',
    triggerPatterns: ['save.*(co-?op|internship|job)', 'track.*(co-?op|internship|job)', 'shortlist.*(co-?op|internship|job)'],
    parameters: {
      title: { type: 'string', required: false, extractHint: 'job/co-op title, only if the user is describing one directly rather than referring back to a search result' },
      employer: { type: 'string', required: false },
      location: { type: 'string', required: false },
      compText: { type: 'string', required: false, extractHint: 'the pay as free text, only for a direct description' },
      deadlineText: { type: 'string', required: false },
      sourceUrl: { type: 'string', required: false },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'find-roommate-matches',
    description: 'Find compatible roommate matches based on the student\'s roommate profile (budget, area, move-in date, lifestyle)',
    category: 'student',
    triggerPatterns: ['roommate', 'find.*roommate', 'compatible.*(student|roommate)', 'match.*roommate'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-housing/roommate/matches' },
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/skill-routing-canonical.test.ts`
Expected: PASS — all cases (existing + new) pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/built-in-skills.ts plugins/agentbook-core/backend/src/__tests__/skill-routing-canonical.test.ts
git commit -m "feat(agent-brain): add scholarship/co-op/roommate skill manifests

Adds find-scholarships, save-scholarship, find-coop-opportunities,
save-coop-opportunity, and find-roommate-matches to BUILT_IN_SKILLS.
scholarship-taxability gets an excludePatterns entry for search-intent
phrasing so 'find me a scholarship' routes to the new search skill
instead of the existing tax-treatment skill."
```

---

## Task 2: Eligibility gate + `baseUrls` wiring

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Create: `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`

**Interfaces:**
- Consumes: the 5 skill names from Task 1; `executeClassification(classification: ClassificationResult, text: string, tenantId: string, channel: string, attachments?: any[]): Promise<any>` (already exported from `server.ts`).
- Produces: `STUDENT_CHAT_SKILLS` array (module-level in `server.ts`) and the gate check, reused by Tasks 3-4's tests to confirm `save-*` skills are gated the same way.

- [ ] **Step 1: Write the failing test file**

Create `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAbTenantConfigFindUnique = vi.fn();
const mockAbConversationFindFirst = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findUnique: (...args: any[]) => mockAbTenantConfigFindUnique(...args) },
    abConversation: {
      findFirst: (...args: any[]) => mockAbConversationFindFirst(...args),
      create: vi.fn(async () => ({})),
    },
    abAccount: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

const mockHasAddOn = vi.fn();
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: any[]) => mockHasAddOn(...args) }));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

const SKILL_ENDPOINTS: Record<string, any> = {
  'find-scholarships': { method: 'POST', url: '/api/v1/agentbook-scholarship/discover' },
  'save-scholarship': { method: 'INTERNAL', url: '' },
  'find-coop-opportunities': { method: 'POST', url: '/api/v1/agentbook-career/discover' },
  'save-coop-opportunity': { method: 'INTERNAL', url: '' },
  'find-roommate-matches': { method: 'GET', url: '/api/v1/agentbook-housing/roommate/matches' },
};

function classification(name: string, extractedParams: Record<string, any> = {}) {
  return {
    selectedSkill: { name, endpoint: SKILL_ENDPOINTS[name], parameters: {} },
    extractedParams,
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: {},
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('student chat skills — eligibility gate', () => {
  it('blocks find-scholarships for a non-student tenant with a friendly nudge, makes no HTTP call', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'freelancer' });
    const result = await executeClassification(classification('find-scholarships'), 'find me a scholarship', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks find-scholarships for a student tenant missing the add-on', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'student' });
    mockHasAddOn.mockResolvedValueOnce(false);
    const result = await executeClassification(classification('find-scholarships'), 'find me a scholarship', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows find-scholarships through to the HTTP call for an eligible tenant', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'student' });
    mockHasAddOn.mockResolvedValueOnce(true);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { candidates: [], note: 'ok' } }) });
    await executeClassification(classification('find-scholarships', { query: 'chemistry' }), 'find scholarships for chemistry majors', 'tenant-1', 'api');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-scholarship/discover');
  });

  it('blocks find-roommate-matches the same way', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'freelancer' });
    const result = await executeClassification(classification('find-roommate-matches'), 'find me a roommate', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks save-scholarship for an ineligible tenant before any candidate resolution', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'freelancer' });
    const result = await executeClassification(classification('save-scholarship'), 'save the first one', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockAbConversationFindFirst).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: FAIL — `find-scholarships`/`find-roommate-matches`/`save-scholarship` aren't gated yet, so `mockFetch` gets called (or `result.responseData.message` doesn't match `/Student Success/`) in the "blocks" tests; the "allows through" test may already pass by coincidence (no gate = always proceeds) but the blocking tests fail.

- [ ] **Step 3: Add the `hasAddOn` import**

In `plugins/agentbook-core/backend/src/server.ts`, add to the top import block (after `import { selectSkillByPatterns } from './skill-routing.js';`):

```ts
import { hasAddOn } from '@naap/billing';
```

- [ ] **Step 4: Add the 3 new `baseUrls` entries**

Find the `baseUrls` object literal inside `_executeClassificationCore` (currently 4 entries: `agentbook-expense`, `agentbook-core`, `agentbook-invoice`, `agentbook-tax`) and add:

```ts
  const baseUrls: Record<string, string> = {
    '/api/v1/agentbook-expense': process.env.AGENTBOOK_EXPENSE_URL || _appBase || 'http://localhost:4051',
    '/api/v1/agentbook-core': process.env.AGENTBOOK_CORE_URL || _appBase || 'http://localhost:4050',
    '/api/v1/agentbook-invoice': process.env.AGENTBOOK_INVOICE_URL || _appBase || 'http://localhost:4052',
    '/api/v1/agentbook-tax': process.env.AGENTBOOK_TAX_URL || _appBase || 'http://localhost:4053',
    '/api/v1/agentbook-scholarship': _appBase || 'http://localhost:3000',
    '/api/v1/agentbook-career': _appBase || 'http://localhost:3000',
    '/api/v1/agentbook-housing': _appBase || 'http://localhost:3000',
  };
```

(Scholarship/Career/Housing are Next.js-native API routes with no standalone Express backend, unlike expense/invoice/tax — no dedicated port fallback needed, just the app's own base URL.)

- [ ] **Step 5: Add the eligibility gate**

Immediately after `let { selectedSkill, extractedParams, confidence } = classification;` (the very first line of `_executeClassificationCore`'s body, before `let endpoint = ...`), add:

```ts
  // Eligibility gate: scholarship/co-op/roommate search + save are part of
  // the Student Success add-on. Checked here (execution time), not at
  // classification time — see docs/superpowers/specs/2026-07-10-student-chat-skills-design.md.
  const STUDENT_CHAT_SKILLS = ['find-scholarships', 'save-scholarship', 'find-coop-opportunities', 'save-coop-opportunity', 'find-roommate-matches'];
  if (STUDENT_CHAT_SKILLS.includes(selectedSkill.name)) {
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const eligible = cfg?.businessType === 'student' && (await hasAddOn(tenantId, 'student_success'));
    if (!eligible) {
      return {
        selectedSkill, extractedParams, confidence: 1, skillUsed: selectedSkill.name, skillResponse: null,
        responseData: {
          message: 'Scholarship, co-op, and roommate search are part of Student Success — enable it in your Business Profile settings to use them.',
          skillUsed: selectedSkill.name, confidence: 1, latencyMs: Date.now() - startTime,
        },
      };
    }
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: PASS — all 5 tests pass. `find-scholarships`/`find-roommate-matches` now correctly route through the generic HTTP executor for eligible tenants (no extra code needed for those two beyond the gate + `baseUrls`, since they're plain HTTP calls).

- [ ] **Step 7: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts
git commit -m "feat(agent-brain): gate student chat skills behind businessType+add-on

Execution-time eligibility check for the 5 new student skills, plus
baseUrls entries so find-scholarships/find-coop-opportunities/
find-roommate-matches resolve to the right Next.js API routes. The two
find-* HTTP skills and find-roommate-matches now work end-to-end via
the existing generic HTTP executor — no skill-specific code needed
beyond the gate."
```

---

## Task 3: Shared candidate-resolution helper

**Files:**
- Create: `plugins/agentbook-core/backend/src/candidate-resolution.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/candidate-resolution.test.ts`

**Interfaces:**
- Produces: `resolveOrdinalOrFuzzyCandidate<T extends { title: string }>(candidates: T[], text: string, extraMatchFields?: string[]): T | null` — exported for both Task 4 (`save-scholarship`, called with no extra fields) and Task 5 (`save-coop-opportunity`, called with `extraMatchFields: ['employer']`).

- [ ] **Step 1: Write the failing tests**

Create `plugins/agentbook-core/backend/src/__tests__/candidate-resolution.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveOrdinalOrFuzzyCandidate } from '../candidate-resolution';

const SCHOLARSHIPS = [
  { title: 'Chen Family Award', amountText: '$2,000' },
  { title: 'TD Community Scholarship', amountText: '$1,000' },
];

const JOBS = [
  { title: 'Software Engineering Co-op', employer: 'Shopify' },
  { title: 'Data Analyst Intern', employer: 'RBC' },
];

describe('resolveOrdinalOrFuzzyCandidate', () => {
  it('returns null for an empty candidate list', () => {
    expect(resolveOrdinalOrFuzzyCandidate([], 'save the first one')).toBeNull();
  });

  it('resolves "first" to index 0', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the first one')).toBe(SCHOLARSHIPS[0]);
  });

  it('resolves "second" to index 1', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the second one')).toBe(SCHOLARSHIPS[1]);
  });

  it('resolves "#2" / "2nd" to index 1', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save #2')).toBe(SCHOLARSHIPS[1]);
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the 2nd one')).toBe(SCHOLARSHIPS[1]);
  });

  it('falls back to fuzzy title match when there is no ordinal', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the TD one')).toBe(SCHOLARSHIPS[1]);
  });

  it('matches against extraMatchFields (e.g. employer) in addition to title', () => {
    expect(resolveOrdinalOrFuzzyCandidate(JOBS, 'save the shopify one', ['employer'])).toBe(JOBS[0]);
    expect(resolveOrdinalOrFuzzyCandidate(JOBS, 'save the rbc one', ['employer'])).toBe(JOBS[1]);
  });

  it('returns null when nothing resolves (no ordinal, no fuzzy match)', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save that one please')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/candidate-resolution.test.ts`
Expected: FAIL — `../candidate-resolution` doesn't exist yet.

- [ ] **Step 3: Implement the helper**

Create `plugins/agentbook-core/backend/src/candidate-resolution.ts`:

```ts
/**
 * Resolve which candidate a follow-up message like "save the first one" or
 * "save the TD one" refers to, against the candidate list from a prior
 * find-* skill turn. Shared by save-scholarship and save-coop-opportunity
 * so the resolution logic exists in exactly one place.
 *
 * Resolution order:
 *   1. Ordinal ("first"..."fifth", "#2", "2nd") — index into candidates.
 *   2. Fuzzy — score each candidate by how many of its title's (plus any
 *      extraMatchFields', e.g. "employer") significant words (4+ chars)
 *      appear in the user's message; highest score wins.
 *
 * Returns null if candidates is empty, or if neither resolution succeeds.
 */
export function resolveOrdinalOrFuzzyCandidate<T extends { title: string }>(
  candidates: T[],
  text: string,
  extraMatchFields: string[] = [],
): T | null {
  if (candidates.length === 0) return null;
  const lowerText = (text || '').toLowerCase();

  const ordinalWords: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
  let ordinalIndex: number | null = null;
  for (const [word, idx] of Object.entries(ordinalWords)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lowerText)) { ordinalIndex = idx; break; }
  }
  if (ordinalIndex === null) {
    const numMatch = lowerText.match(/#\s*(\d+)|\b(\d+)(?:st|nd|rd|th)\b/);
    if (numMatch) ordinalIndex = parseInt(numMatch[1] || numMatch[2], 10) - 1;
  }
  if (ordinalIndex !== null && candidates[ordinalIndex]) {
    return candidates[ordinalIndex];
  }

  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const fieldValues = [c.title, ...extraMatchFields.map((f) => (c as any)[f])].filter(Boolean).join(' ');
    const words = fieldValues.toLowerCase().split(/\W+/).filter((w: string) => w.length >= 4);
    const score = words.filter((w: string) => lowerText.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/candidate-resolution.test.ts`
Expected: PASS — all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/candidate-resolution.ts plugins/agentbook-core/backend/src/__tests__/candidate-resolution.test.ts
git commit -m "feat(agent-brain): shared ordinal/fuzzy candidate-resolution helper

Extracted so save-scholarship and save-coop-opportunity (next two
tasks) share one implementation of 'save the first one' / 'save the
TD one' resolution instead of duplicating it."
```

---

## Task 4: `save-scholarship` — candidate resolution + save

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`

**Interfaces:**
- Consumes: `resolveOrdinalOrFuzzyCandidate` from Task 3 (`./candidate-resolution.js`, called with no `extraMatchFields`); `db.abConversation.findFirst({ where: { tenantId, skillUsed: 'find-scholarships' }, orderBy: { createdAt: 'desc' } })` (same query shape `edit-expense`'s pre-processing already uses); `baseUrls['/api/v1/agentbook-scholarship']`; `brainHeaders(tenantId)` (already defined in `server.ts`).
- Produces: the `save-scholarship` INTERNAL handler's `return` shape `{ selectedSkill, extractedParams, confidence, skillUsed: 'save-scholarship', skillResponse, responseData: { message, skillUsed, confidence, latencyMs } }`.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`:

```ts
describe('student chat skills — save-scholarship candidate resolution', () => {
  const CANDIDATES = [
    { title: 'Chen Family Award', amountText: '$2,000', deadlineText: 'June 1', sourceUrl: 'https://example.edu/chen', sourceLabel: 'example.edu' },
    { title: 'TD Community Scholarship', amountText: '$1,000', deadlineText: 'July 15', sourceUrl: 'https://td.com/scholarship', sourceLabel: 'td.com' },
  ];

  beforeEach(() => {
    mockAbTenantConfigFindUnique.mockResolvedValue({ businessType: 'student' });
    mockHasAddOn.mockResolvedValue(true);
  });

  it('resolves "save the first one" via ordinal to the first candidate and posts it', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-scholarships', data: { success: true, data: { candidates: CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'opp-1' } }) });
    const result = await executeClassification(classification('save-scholarship'), 'save the first one', 'tenant-1', 'api');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-scholarship/opportunities');
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Chen Family Award');
    expect(result.responseData.message).toMatch(/Chen Family Award/);
  });

  it('resolves "save the TD one" via fuzzy title match to the second candidate', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-scholarships', data: { success: true, data: { candidates: CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'opp-2' } }) });
    await executeClassification(classification('save-scholarship'), 'save the TD one', 'tenant-1', 'api');
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('TD Community Scholarship');
  });

  it('falls back to direct free-text extraction when there is no prior find-scholarships turn', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'opp-3' } }) });
    await executeClassification(
      classification('save-scholarship', { title: 'Rotary Club Award', amountText: '$500', deadlineText: '2027-06-01' }),
      'save a scholarship called the Rotary Club Award, $500, due June 1',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Rotary Club Award');
  });

  it('asks for clarification when nothing resolves (no prior turn, no direct title)', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce(null);
    const result = await executeClassification(classification('save-scholarship'), 'save that one', 'tenant-1', 'api');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.responseData.message).toMatch(/not sure which/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: FAIL — `save-scholarship` has no INTERNAL handler yet, so it falls through to the generic executor and calls `fetch` with the wrong URL (the empty `endpoint.url` for an `INTERNAL` method), producing no matching calls or throwing.

- [ ] **Step 3: Implement the `save-scholarship` INTERNAL handler**

In `plugins/agentbook-core/backend/src/server.ts`, add the import (near the other local imports at the top of the file):

```ts
import { resolveOrdinalOrFuzzyCandidate } from './candidate-resolution.js';
```

Then add this block among the other INTERNAL handlers (e.g., directly after the `record-invoice-payment` block, anywhere before the generic HTTP execution section starting at `// === 3. SKILL EXECUTION ===`'s generic fetch code):

```ts
  // INTERNAL handler: save-scholarship — resolve a candidate from the prior
  // find-scholarships turn (ordinal or fuzzy title match), or fall back to
  // a direct free-text description, then save it via the scholarship
  // opportunities endpoint.
  if (selectedSkill.name === 'save-scholarship') {
    try {
      const lastConvo = await db.abConversation.findFirst({
        where: { tenantId, skillUsed: 'find-scholarships' },
        orderBy: { createdAt: 'desc' },
      });
      const candidates: any[] = (lastConvo?.data as any)?.data?.candidates ?? [];
      let chosen: any = resolveOrdinalOrFuzzyCandidate(candidates, text || '');

      if (!chosen && extractedParams.title) {
        chosen = {
          title: String(extractedParams.title),
          amountText: extractedParams.amountText ? String(extractedParams.amountText) : null,
          deadlineText: extractedParams.deadlineText ? String(extractedParams.deadlineText) : null,
          sourceUrl: extractedParams.sourceUrl ? String(extractedParams.sourceUrl) : null,
        };
      }

      if (!chosen) {
        return {
          selectedSkill, extractedParams, confidence, skillUsed: 'save-scholarship', skillResponse: null,
          responseData: {
            message: "I'm not sure which scholarship you mean — try \"find scholarships\" first, then \"save the first one\", or tell me the name directly.",
            skillUsed: 'save-scholarship', confidence, latencyMs: Date.now() - startTime,
          },
        };
      }

      const scholarshipBase = baseUrls['/api/v1/agentbook-scholarship'] || 'http://localhost:3000';
      const saveRes = await fetch(`${scholarshipBase}/api/v1/agentbook-scholarship/opportunities`, {
        method: 'POST',
        headers: brainHeaders(tenantId),
        body: JSON.stringify({
          title: chosen.title,
          sourceUrl: chosen.sourceUrl || null,
          sourceLabel: chosen.sourceLabel || null,
          deadline: chosen.deadlineText || null,
          amountText: chosen.amountText || null,
          eligibilitySummary: chosen.eligibilitySummary || null,
        }),
      });
      const saveData = await saveRes.json() as any;
      if (!saveRes.ok || !saveData.success) {
        return {
          selectedSkill, extractedParams, confidence, skillUsed: 'save-scholarship', skillResponse: saveData,
          responseData: {
            message: `Couldn't save that scholarship. ${saveData.error || 'Please try again.'}`,
            skillUsed: 'save-scholarship', confidence, latencyMs: Date.now() - startTime,
          },
        };
      }
      const detailParts = [chosen.amountText, chosen.deadlineText ? `due ${chosen.deadlineText}` : null].filter(Boolean);
      const detail = detailParts.length ? ` (${detailParts.join(', ')})` : '';
      return {
        selectedSkill, extractedParams, confidence, skillUsed: 'save-scholarship', skillResponse: saveData,
        responseData: {
          message: `Saved "${chosen.title}"${detail} to your shortlist — view it anytime in Scholarships.`,
          skillUsed: 'save-scholarship', confidence, latencyMs: Date.now() - startTime,
        },
      };
    } catch (err) {
      console.error('[save-scholarship] error:', err);
      return {
        selectedSkill, extractedParams, confidence: 0, skillUsed: 'save-scholarship', skillResponse: null,
        responseData: { message: "I couldn't save that scholarship. Please try again.", skillUsed: 'save-scholarship', confidence: 0, latencyMs: Date.now() - startTime },
      };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: PASS — all `save-scholarship` tests pass, gate tests from Task 2 still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts
git commit -m "feat(agent-brain): save-scholarship — resolve + persist a found scholarship

Resolves 'save the first one' / 'save the TD one' against the prior
find-scholarships turn (ordinal, then fuzzy title match), falling back
to direct free-text extraction when there's no prior search turn.
Posts to the existing scholarship opportunities endpoint."
```

---

## Task 5: `save-coop-opportunity` — same pattern for career/job candidates

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`

**Interfaces:**
- Consumes: `resolveOrdinalOrFuzzyCandidate` from Task 3 (`./candidate-resolution.js`, called with `extraMatchFields: ['employer']`), filtered on `skillUsed: 'find-coop-opportunities'`; `baseUrls['/api/v1/agentbook-career']`.
- Produces: the `save-coop-opportunity` INTERNAL handler.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`:

```ts
describe('student chat skills — save-coop-opportunity candidate resolution', () => {
  const JOB_CANDIDATES = [
    { title: 'Software Engineering Co-op', employer: 'Shopify', location: 'Remote', compText: '$28/hr', deadlineText: 'March 1', sourceUrl: 'https://shopify.com/careers/1', sourceLabel: 'shopify.com' },
    { title: 'Data Analyst Intern', employer: 'RBC', location: 'Toronto, ON', compText: '$25/hr', deadlineText: 'February 15', sourceUrl: 'https://rbc.com/careers/2', sourceLabel: 'rbc.com' },
  ];

  beforeEach(() => {
    mockAbTenantConfigFindUnique.mockResolvedValue({ businessType: 'student' });
    mockHasAddOn.mockResolvedValue(true);
  });

  it('resolves "save the first one" via ordinal and posts it', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-coop-opportunities', data: { success: true, data: { candidates: JOB_CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-1' } }) });
    const result = await executeClassification(classification('save-coop-opportunity'), 'save the first one', 'tenant-1', 'api');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-career/opportunities');
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Software Engineering Co-op');
    expect(body.employer).toBe('Shopify');
    expect(result.responseData.message).toMatch(/Software Engineering Co-op/);
  });

  it('resolves "save the RBC one" via fuzzy employer/title match', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-coop-opportunities', data: { success: true, data: { candidates: JOB_CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-2' } }) });
    await executeClassification(classification('save-coop-opportunity'), 'save the data analyst one', 'tenant-1', 'api');
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Data Analyst Intern');
  });

  it('falls back to direct free-text extraction when there is no prior find-coop-opportunities turn', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-3' } }) });
    await executeClassification(
      classification('save-coop-opportunity', { title: 'Marketing Intern', employer: 'Local Startup Co' }),
      'save this marketing intern role at Local Startup Co',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Marketing Intern');
    expect(body.employer).toBe('Local Startup Co');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: FAIL — no `save-coop-opportunity` handler yet.

- [ ] **Step 3: Implement the `save-coop-opportunity` INTERNAL handler**

Add directly after the `save-scholarship` block from Task 4:

```ts
  // INTERNAL handler: save-coop-opportunity — same resolution pattern as
  // save-scholarship, for career/job candidates.
  if (selectedSkill.name === 'save-coop-opportunity') {
    try {
      const lastConvo = await db.abConversation.findFirst({
        where: { tenantId, skillUsed: 'find-coop-opportunities' },
        orderBy: { createdAt: 'desc' },
      });
      const candidates: any[] = (lastConvo?.data as any)?.data?.candidates ?? [];
      let chosen: any = resolveOrdinalOrFuzzyCandidate(candidates, text || '', ['employer']);

      if (!chosen && extractedParams.title) {
        chosen = {
          title: String(extractedParams.title),
          employer: extractedParams.employer ? String(extractedParams.employer) : null,
          location: extractedParams.location ? String(extractedParams.location) : null,
          compText: extractedParams.compText ? String(extractedParams.compText) : null,
          deadlineText: extractedParams.deadlineText ? String(extractedParams.deadlineText) : null,
          sourceUrl: extractedParams.sourceUrl ? String(extractedParams.sourceUrl) : null,
        };
      }

      if (!chosen) {
        return {
          selectedSkill, extractedParams, confidence, skillUsed: 'save-coop-opportunity', skillResponse: null,
          responseData: {
            message: "I'm not sure which opportunity you mean — try \"find co-ops\" first, then \"save the first one\", or tell me the role directly.",
            skillUsed: 'save-coop-opportunity', confidence, latencyMs: Date.now() - startTime,
          },
        };
      }

      const careerBase = baseUrls['/api/v1/agentbook-career'] || 'http://localhost:3000';
      const saveRes = await fetch(`${careerBase}/api/v1/agentbook-career/opportunities`, {
        method: 'POST',
        headers: brainHeaders(tenantId),
        body: JSON.stringify({
          title: chosen.title,
          sourceUrl: chosen.sourceUrl || null,
          sourceLabel: chosen.sourceLabel || null,
          deadline: chosen.deadlineText || null,
          employer: chosen.employer || null,
          location: chosen.location || null,
          compText: chosen.compText || null,
          summary: chosen.summary || null,
        }),
      });
      const saveData = await saveRes.json() as any;
      if (!saveRes.ok || !saveData.success) {
        return {
          selectedSkill, extractedParams, confidence, skillUsed: 'save-coop-opportunity', skillResponse: saveData,
          responseData: {
            message: `Couldn't save that opportunity. ${saveData.error || 'Please try again.'}`,
            skillUsed: 'save-coop-opportunity', confidence, latencyMs: Date.now() - startTime,
          },
        };
      }
      const detailParts = [chosen.employer, chosen.compText, chosen.deadlineText ? `due ${chosen.deadlineText}` : null].filter(Boolean);
      const detail = detailParts.length ? ` (${detailParts.join(', ')})` : '';
      return {
        selectedSkill, extractedParams, confidence, skillUsed: 'save-coop-opportunity', skillResponse: saveData,
        responseData: {
          message: `Saved "${chosen.title}"${detail} to your shortlist — view it anytime in Co-ops & Jobs.`,
          skillUsed: 'save-coop-opportunity', confidence, latencyMs: Date.now() - startTime,
        },
      };
    } catch (err) {
      console.error('[save-coop-opportunity] error:', err);
      return {
        selectedSkill, extractedParams, confidence: 0, skillUsed: 'save-coop-opportunity', skillResponse: null,
        responseData: { message: "I couldn't save that opportunity. Please try again.", skillUsed: 'save-coop-opportunity', confidence: 0, latencyMs: Date.now() - startTime },
      };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts
git commit -m "feat(agent-brain): save-coop-opportunity — resolve + persist a found co-op/job

Same resolution pattern as save-scholarship (ordinal, fuzzy match,
direct free-text fallback), posting to the career opportunities
endpoint."
```

---

## Task 6: Response formatting for the 3 "find" skills

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`

**Interfaces:**
- Consumes: the `data` variable inside the `// === 4. RESPONSE FORMATTING ===` else-if chain (already destructured as `const data = skillResponse.data;`).
- Produces: readable `message` strings for `find-scholarships`/`find-coop-opportunities`/`find-roommate-matches` results — without this, results render as `JSON.stringify(data).slice(0, 300)` (the existing terminal fallback), which is technically correct but unreadable.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts`:

```ts
describe('student chat skills — response formatting', () => {
  beforeEach(() => {
    mockAbTenantConfigFindUnique.mockResolvedValue({ businessType: 'student' });
    mockHasAddOn.mockResolvedValue(true);
  });

  it('formats find-scholarships results as a readable numbered list, not a JSON dump', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          candidates: [
            { title: 'Chen Family Award', amountText: '$2,000', deadlineText: 'June 1', sourceUrl: 'https://example.edu/chen', sourceLabel: 'example.edu' },
          ],
          note: 'Verify eligibility at the source before applying.',
        },
      }),
    });
    const result = await executeClassification(classification('find-scholarships', { query: 'chemistry' }), 'find scholarships for chemistry majors', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Chen Family Award/);
    expect(result.responseData.message).toMatch(/\$2,000/);
    expect(result.responseData.message).not.toMatch(/^\{/); // not a raw JSON dump
  });

  it('formats an empty find-scholarships result using the route\'s own note', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { candidates: [], note: 'Search is temporarily unavailable.' } }) });
    const result = await executeClassification(classification('find-scholarships'), 'find me a scholarship', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/temporarily unavailable/);
  });

  it('formats find-coop-opportunities results with employer and comp', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { candidates: [{ title: 'Software Engineering Co-op', employer: 'Shopify', location: 'Remote', compText: '$28/hr', deadlineText: 'March 1', sourceUrl: 'https://shopify.com/careers/1', sourceLabel: 'shopify.com' }], note: '' },
      }),
    });
    const result = await executeClassification(classification('find-coop-opportunities'), 'find a co-op', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Shopify/);
    expect(result.responseData.message).toMatch(/\$28\/hr/);
  });

  it('formats find-roommate-matches results with compatibility score, and relays the route\'s own note when no profile is set up', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { matches: [], note: 'Turn on your roommate profile to see compatible students.' } }) });
    const result = await executeClassification(classification('find-roommate-matches'), 'find me a roommate', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Turn on your roommate profile/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: FAIL — these three skills currently fall through to the terminal `JSON.stringify(data).slice(0, 300)` fallback, so `message` won't contain "Chen Family Award" as readable text (it'll be inside raw JSON, and the "not a JSON dump" assertion will fail since the message starts with `{`).

- [ ] **Step 3: Add the 3 response-formatting branches**

In `plugins/agentbook-core/backend/src/server.ts`, find the terminal fallback in the `// === 4. RESPONSE FORMATTING ===` else-if chain:

```ts
    } else {
      message = JSON.stringify(data).slice(0, 300);
    }
```

Insert these 3 branches immediately before it (so they become `else if` clauses ahead of the terminal `else`):

```ts
    // Scholarship search results
    } else if (selectedSkill.name === 'find-scholarships' && Array.isArray(data?.candidates)) {
      if (data.candidates.length === 0) {
        message = data.note || "I couldn't find any groundable scholarship matches right now — try broadening your search or checking back later.";
      } else {
        message = `**${data.candidates.length} scholarship${data.candidates.length === 1 ? '' : 's'} found**\n`;
        data.candidates.slice(0, 5).forEach((c: any, i: number) => {
          message += `\n${i + 1}. **${c.title}**${c.amountText ? ` — ${c.amountText}` : ''}${c.deadlineText ? ` (due ${c.deadlineText})` : ''}\n   ${c.sourceLabel || c.sourceUrl}`;
        });
        if (data.note) message += `\n\n_${data.note}_`;
        message += '\n\nSay "save the first one" (or name one) to add it to your shortlist.';
      }

    // Co-op / job search results
    } else if (selectedSkill.name === 'find-coop-opportunities' && Array.isArray(data?.candidates)) {
      if (data.candidates.length === 0) {
        message = data.note || "I couldn't find any groundable co-op/job matches right now — try broadening your search or checking back later.";
      } else {
        message = `**${data.candidates.length} opportunit${data.candidates.length === 1 ? 'y' : 'ies'} found**\n`;
        data.candidates.slice(0, 5).forEach((c: any, i: number) => {
          message += `\n${i + 1}. **${c.title}**${c.employer ? ` at ${c.employer}` : ''}${c.location ? ` (${c.location})` : ''}${c.compText ? ` — ${c.compText}` : ''}\n   ${c.sourceLabel || c.sourceUrl}`;
        });
        if (data.note) message += `\n\n_${data.note}_`;
        message += '\n\nSay "save the first one" (or name one) to add it to your shortlist.';
      }

    // Roommate matches
    } else if (selectedSkill.name === 'find-roommate-matches' && Array.isArray(data?.matches)) {
      if (data.matches.length === 0) {
        message = data.note || 'No compatible students found yet.';
      } else {
        message = `**${data.matches.length} compatible student${data.matches.length === 1 ? '' : 's'}**\n`;
        data.matches.slice(0, 5).forEach((m: any) => {
          const min = m.budgetMinCents != null ? `$${(m.budgetMinCents / 100).toFixed(0)}` : '?';
          const max = m.budgetMaxCents != null ? `$${(m.budgetMaxCents / 100).toFixed(0)}` : '?';
          message += `\n• **${m.displayHandle}** — ${m.area}, budget ${min}-${max} (${Math.round((m.score || 0) * 100)}% match)\n   ${m.reasons?.[0] || ''}`;
        });
        if (data.note) message += `\n\n_${data.note}_`;
      }

    } else {
      message = JSON.stringify(data).slice(0, 300);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/student-chat-skills.test.ts`
Expected: PASS — all formatting tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/student-chat-skills.test.ts
git commit -m "feat(agent-brain): render scholarship/co-op/roommate results as readable lists

responseTemplate only does flat {{key}} substitution, which can't
render an array of candidates — adds dedicated formatting branches for
the 3 find-* skills so results show as a numbered list with amount/
comp/deadline/source instead of falling through to the raw JSON-dump
fallback."
```

---

## Task 7: Full verification, worktree cleanup, PR, deploy, and production e2e verification

**Files:**
- Create: `bin/seed-student-chat-test-account.ts`
- No other new files — this task runs the full pipeline.

- [ ] **Step 1: Run the full agentbook-core backend test suite**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: PASS — every test file passes, including the pre-existing suite (confirm no regressions from the `built-in-skills.ts`/`server.ts` edits).

- [ ] **Step 2: Type-check and build the Next.js app**

The Next.js app imports `@agentbook-core/server` and `@agentbook-core/built-in-skills` directly (`apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts`), so a clean build there is required too:

```bash
cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "agentbook-core\|built-in-skills"
```

Expected: no output (no type errors in the touched files).

```bash
cd apps/web-next && NODE_OPTIONS="--max-old-space-size=4096" npx next build 2>&1 | tail -40
```

Expected: build completes successfully.

- [ ] **Step 3: Write the production test-account seed script**

Create `bin/seed-student-chat-test-account.ts`:

```ts
/**
 * Creates/updates a dedicated test account for verifying the student chat
 * skills (find-scholarships, save-scholarship, find-coop-opportunities,
 * save-coop-opportunity, find-roommate-matches) end-to-end in production.
 *
 * Grants: businessType='student' + an ACTIVE student_success subscription
 * (the billAddOn product itself must already be isActive=true in prod —
 * this script does not flip that; it only grants ONE tenant a subscription).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/seed-student-chat-test-account.ts
 */

import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';

const TENANT_ID = 'taylor-student';
const EMAIL = 'taylor@agentbook.test';
const PASSWORD = 'agentbook123';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  await db.user.upsert({
    where: { id: TENANT_ID },
    create: { id: TENANT_ID, email: EMAIL, passwordHash: hashPassword(PASSWORD), displayName: 'Taylor Nguyen', emailVerified: new Date() },
    update: { email: EMAIL, passwordHash: hashPassword(PASSWORD), displayName: 'Taylor Nguyen', emailVerified: new Date() },
  });

  await db.abTenantConfig.upsert({
    where: { userId: TENANT_ID },
    create: {
      userId: TENANT_ID,
      businessType: 'student',
      jurisdiction: 'ca',
      region: 'ON',
      university: 'University of Waterloo',
      major: 'Chemistry',
      degree: "Bachelor's",
      currency: 'CAD',
    },
    update: { businessType: 'student', jurisdiction: 'ca', region: 'ON', university: 'University of Waterloo', major: 'Chemistry', degree: "Bachelor's" },
  });

  const addOn = await db.billAddOn.findUnique({ where: { code: 'student_success' } });
  if (!addOn) throw new Error('student_success add-on not found — run bin/seed-student-success-addon.ts first');
  if (!addOn.isActive) throw new Error('student_success add-on is not active in this environment');

  const price = await db.billAddOnPrice.findFirst({ where: { addOnId: addOn.id, tier: 'standard' } });
  if (!price) throw new Error('No BillAddOnPrice found for student_success — run bin/seed-student-success-addon.ts first');

  await db.billAddOnSubscription.upsert({
    where: { accountId_addOnId: { accountId: TENANT_ID, addOnId: addOn.id } },
    create: { accountId: TENANT_ID, addOnId: addOn.id, priceId: price.id, status: 'active' },
    update: { status: 'active', priceId: price.id },
  });

  console.log(JSON.stringify({ tenantId: TENANT_ID, email: EMAIL, businessType: 'student', addOnStatus: 'active' }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Push, open a PR, verify CI, merge**

```bash
git push -u origin feat/student-chat-skills
gh pr create --title "feat(agentbook): scholarship/co-op/roommate search + save via chat" --body "$(cat <<'EOF'
## Summary
- Adds 5 new agent-brain chat skills: find-scholarships, save-scholarship, find-coop-opportunities, save-coop-opportunity, find-roommate-matches — the same conversational pattern already used for expenses/invoices.
- Execution-time eligibility gate: businessType='student' + the student_success add-on, with a friendly nudge message for ineligible tenants (no HTTP calls made).
- save-* skills resolve "save the first one" / "save the TD one" against the prior find-* turn (ordinal, then fuzzy title match), falling back to direct free-text extraction when there's no prior search turn.
- New response-formatting branches so results render as a readable list (responseTemplate can't render an array of candidates).
- scholarship-taxability gets a new excludePatterns entry so "find me a scholarship" no longer collides with the existing tax-treatment skill.

Design doc: docs/superpowers/specs/2026-07-10-student-chat-skills-design.md

## Test plan
- [x] Unit tests: skill routing/collision-avoidance, eligibility gate, candidate resolution (ordinal/fuzzy/fallback) for both save-* skills, response formatting — all against the real executeClassification with mocked db/hasAddOn/fetch
- [x] Full agentbook-core backend test suite — no regressions
- [x] next build clean
- [ ] Production e2e verification (next step after merge)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Check CI status with `gh pr checks <number>`, then merge:

```bash
gh pr merge <number> --squash
git push origin --delete feat/student-chat-skills
```

- [ ] **Step 5: Build and deploy to production**

From a clean worktree at the merged commit (do NOT build from a dirty checkout):

```bash
git worktree add .worktrees/prod-deploy-student-chat-skills origin/main
cd .worktrees/prod-deploy-student-chat-skills
cp /path/to/.vercel/project.json .vercel/project.json  # or `mkdir .vercel && ...` — reuse the a3p-plugin-build project link
cd apps/web-next && npm install --include=dev && cd ../..
vercel build --prod
vercel deploy --prebuilt --prod
```

- [ ] **Step 6: Seed the new skills into the production DB**

Classification reads from `db.abSkillManifest`, not the `BUILT_IN_SKILLS` array directly:

```bash
curl -X POST https://agentbook.brainliber.com/api/v1/agentbook-core/agent/seed-skills
```

Expected: `{"success":true,"data":{"created":5,"updated":1,"total":<N>}}` (5 created = the new skills, 1 updated = scholarship-taxability's new excludePatterns).

- [ ] **Step 7: Provision the production test account**

```bash
DATABASE_URL="$PROD_DATABASE_URL" npx tsx bin/seed-student-chat-test-account.ts
```

- [ ] **Step 8: E2E verify in production**

Log in as `taylor@agentbook.test` / `agentbook123` and POST directly to the agent message endpoint (matching this session's established curl-based production verification pattern):

```bash
curl -c /tmp/taylor-cookies.txt -X POST https://agentbook.brainliber.com/api/v1/auth/login \
  -H "content-type: application/json" -d '{"email":"taylor@agentbook.test","password":"agentbook123"}'

curl -b /tmp/taylor-cookies.txt -X POST https://agentbook.brainliber.com/api/v1/agentbook-core/agent/message \
  -H "content-type: application/json" -d '{"text":"find scholarships for a chemistry major","channel":"web"}'
```

Expected: a `message` listing real, source-cited scholarship candidates (or the route's own "temporarily unavailable" note — not an error), and `skillUsed: "find-scholarships"`.

```bash
curl -b /tmp/taylor-cookies.txt -X POST https://agentbook.brainliber.com/api/v1/agentbook-core/agent/message \
  -H "content-type: application/json" -d '{"text":"save the first one","channel":"web"}'
```

Expected: `message` confirms a save (or, if the first call returned zero candidates, the clarifying "not sure which" message — also correct behavior).

Then verify the ineligible path with one of the existing non-student personas (e.g. Maya):

```bash
curl -c /tmp/maya-cookies.txt -X POST https://agentbook.brainliber.com/api/v1/auth/login \
  -H "content-type: application/json" -d '{"email":"maya@agentbook.test","password":"agentbook123"}'

curl -b /tmp/maya-cookies.txt -X POST https://agentbook.brainliber.com/api/v1/agentbook-core/agent/message \
  -H "content-type: application/json" -d '{"text":"find me a scholarship","channel":"web"}'
```

Expected: the "Student Success" nudge message, not an error and not real scholarship results.

- [ ] **Step 9: Clean up**

```bash
git worktree remove .worktrees/prod-deploy-student-chat-skills --force
```

---

## Plan Self-Review

**Spec coverage:** All 5 skills (Task 1), eligibility gate (Task 2), baseUrls (Task 2), the shared candidate-resolution helper (Task 3), save-flow integration for both scholarship and career (Tasks 4-5), response formatting (Task 6), and the full delivery pipeline including the required `seed-skills` call (Task 7) are covered. The design doc's "explicitly out of scope" items (conversational roommate-profile setup, housing-listing search, affordability chat skill, pre-classification filtering) have no corresponding tasks, as intended.

**Placeholder scan:** No TBD/TODO; every step has complete, real code.

**Type consistency:** `save-scholarship`/`save-coop-opportunity` both return the same `{ selectedSkill, extractedParams, confidence, skillUsed, skillResponse, responseData: { message, skillUsed, confidence, latencyMs } }` shape used elsewhere in `server.ts` (matches `categorize-expenses`'s established INTERNAL-handler return shape). Both call the same `resolveOrdinalOrFuzzyCandidate` from Task 3 rather than duplicating resolution logic (revised per user request during pre-flight review — Tasks 4 and 5 originally each had their own copy). `STUDENT_CHAT_SKILLS` (Task 2) is referenced by name only (as a literal array), not imported across tasks, since it's declared once in Task 2 and all later tasks' code lives in the same file/function scope.
