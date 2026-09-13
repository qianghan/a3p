# Chat Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat pipeline (Telegram, web, MCP) tell the truth about what it changed, answer in the user's language end to end, and remember the previous turn — the three properties the review at `docs/superpowers/specs/2026-09-13-chat-quality-review.md` found broken.

**Architecture:** All logic lives in the shared brain (`plugins/agentbook-core/backend/src/`), imported by Next routes via the `@agentbook-core/*` alias; the Telegram adapter only renders. Pure logic is extracted into small modules with unit tests; wiring is guarded by source-reading architecture tests (this repo's established pattern, because a helper that is correct but not called is the recurring failure mode). No new tables, no new services, no HTTP self-calls added except the one route that owns ledger posting.

**Tech Stack:** TypeScript, vitest (`npx vitest run` in `plugins/agentbook-core/backend` and `apps/web-next`), Prisma, Gemini via `callGemini`, grammY Telegram webhook, `@agentbook/i18n` catalog (en / fr-CA / zh-CN JSON).

## Global Constraints

- `plugins/agentbook-core/backend` must never import from `apps/web-next` (architecture rule; ledger posting is reached over HTTP through `POST /api/v1/agentbook-expense/expenses/:id/categorize`).
- Every new catalog key must exist in **all three** locales `en`, `fr-CA`, `zh-CN` with identical `{placeholders}`; zh-CN values must contain CJK. Guard: `apps/web-next/src/__tests__/architecture/i18n-catalog.test.ts`.
- Replies never claim completeness they cannot prove: a "done" sentence is allowed only when `pending.length === 0 && skipped.length === 0`.
- Money in replies goes through `fmtCurrency(cents, currency, locale)` (server.ts:327) with the **reply** locale; prompts sent to Gemini keep machine-stable `$1234.56` (existing rule, see `// money-format-ok` comments).
- Tax guidance stays English (existing `ENGLISH_ONLY_KEYS` rule) — untouched by this plan.
- Never `git stash`, never mutate the main checkout; each PR is built in its own worktree from `origin/main` (`git worktree add /private/tmp/wt-<name> origin/main --detach && git checkout -B <branch>`), then `npm install` in the worktree.
- PR flow: branch → tests green locally (`npx vitest run` in the touched packages, `npx tsc --noEmit -p apps/web-next`) → PR → **Quality Gates** + **CodeQL** green → squash-merge. Never merge from inside a poll loop. Auto-deploy to prod is on.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## PR map and order

| PR | Tasks | Branch | Touches | Fixes |
| --- | --- | --- | --- | --- |
| A | 1–3 | `fix/chat-categorize-truthful` | core `categorize-expenses.ts` (new), `server.ts`, `agent-evaluator.ts`, webhook shortcut, catalog | F1 F2 F3 F4 F13 + latent ledger bug |
| B | 4–6 | `fix/chat-reply-language` | core `reply-language.ts` (new), `server.ts`, `agent-brain.ts`, webhook locale scope, catalog | F5 |
| C | 7–9 | `fix/chat-followup-context` | `agent-brain.ts`, `server.ts`, `built-in-skills.ts`, `scenario-simulation.ts` (new), nightly spec | F6 |
| D | 10–11 | `fix/chat-session-semantics` | `agent-brain.ts`, `agent-planner.ts`, catalog | F7 F8 |
| E | 12–14 | `fix/telegram-rendering-briefing` | `agentbook-telegram-markdown.ts` (new), webhook, `server.ts` briefing | F9 F10 |
| F | 15–16 | `fix/e2e-tenant-isolation` | webhook `resolveTenantId`, new nightly chat-quality spec | F11 + prod verification |

Lane 1 = A → B → C → D (all touch `server.ts` / `agent-brain.ts`; sequential, each rebased on the previous merge). Lane 2 = E → F (adapter-only; may run in parallel with lane 1 — E and F touch webhook regions A/B do not).

Deferred, deliberately: single conversation log (F12 — 35 call sites for a cosmetic duplicate; revisit after the persona window is shown to matter), `formatPlan` i18n, Telegram chat pairing (security, separate PR).

---

## PR A — categorize-expenses tells the truth, in detail, fast

### Task 1: Pure categorize module

**Files:**
- Create: `plugins/agentbook-core/backend/src/categorize-expenses.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/categorize-expenses.test.ts`

**Interfaces:**
- Produces (used by Task 2):

```ts
export interface CategorizeCandidate {
  id: string; vendorName: string | null; description: string | null;
  amountCents: number; currency: string; date: Date; status: 'pending_review' | 'confirmed';
}
export interface CategoryOption { id: string; name: string; taxCategory?: string | null }
/** `id` is the expense id (the prompt uses 1-based ordinals; the parser maps them back). */
export interface BatchDecision { id: string; categoryName: string | null; confidence: number; reason: string }
export type SkipReason = 'no_signal' | 'low_confidence' | 'unknown_category' | 'llm_error';
/** Every line carries `date` — the Telegram "review" walk-through reads it (`new Date(it.date)`). */
interface Line { expenseId: string; vendorName: string | null; description: string | null; amountCents: number; currency: string; date: Date }
export interface CategorizeOutcome {
  total: number;
  applied: Array<Line & { categoryId: string; categoryName: string; confidence: number }>;
  pending: Array<Line & { suggestedCategoryId: string; suggestedCategoryName: string; confidence: number; reason: string }>;
  skipped: Array<Line & { reason: SkipReason }>;
}
export const HIGH_CONF = 0.85; export const MEDIUM_CONF = 0.55; export const BATCH_SIZE = 20; export const TOKENS_PER_ROW = 120;
export function hasSignal(c: CategorizeCandidate): boolean
export function buildBatchPrompt(cands: CategorizeCandidate[], categories: CategoryOption[]): { system: string; user: string }
export function parseBatchDecisions(raw: string | null, cands: CategorizeCandidate[]): BatchDecision[]   // salvages a truncated array
export function decide(cands: CategorizeCandidate[], decisions: BatchDecision[], categories: CategoryOption[]): { apply: Array<{ cand: CategorizeCandidate; category: CategoryOption; confidence: number }>; pending: CategorizeOutcome['pending']; skipped: CategorizeOutcome['skipped'] }
export function formatCategorizeReply(o: CategorizeOutcome, f: { t: (k: string, p?: Record<string, string | number>) => string; money: (cents: number, currency?: string) => string; channel: string }): string
```

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/agentbook-core/backend/src/__tests__/categorize-expenses.test.ts
import { describe, it, expect } from 'vitest';
import {
  hasSignal, buildBatchPrompt, parseBatchDecisions, decide, formatCategorizeReply,
  type CategorizeCandidate, type CategoryOption, type CategorizeOutcome,
} from '../categorize-expenses';

const cat = (id: string, name: string): CategoryOption => ({ id, name });
const CATS = [cat('c-rent', 'Rent'), cat('c-meals', 'Meals'), cat('c-tel', 'Telephone & Internet')];
const cand = (id: string, vendorName: string | null, description: string | null, amountCents = 4500): CategorizeCandidate =>
  ({ id, vendorName, description, amountCents, currency: 'CAD', date: new Date('2026-01-01T12:00:00Z'), status: 'confirmed' });
const D = new Date('2026-01-01T12:00:00Z');

// English identity translator: returns the key + params so assertions can see what was chosen.
const t = (k: string, p: Record<string, string | number> = {}) => `${k}${Object.keys(p).length ? ' ' + JSON.stringify(p) : ''}`;
const f = { t, money: (c: number) => `$${(c / 100).toFixed(2)}`, channel: 'telegram' };

describe('hasSignal', () => {
  it('needs a vendor or a description', () => {
    expect(hasSignal(cand('a', null, null))).toBe(false);
    expect(hasSignal(cand('a', 'WeWork', null))).toBe(true);
    expect(hasSignal(cand('a', null, 'coffee'))).toBe(true);
    expect(hasSignal(cand('a', '  ', ''))).toBe(false);
  });
});

describe('buildBatchPrompt', () => {
  it('numbers candidates 1..N (short ordinals, not 25-char ids) and lists every category by exact name', () => {
    const { system, user } = buildBatchPrompt([cand('e1', 'WeWork', 'desk'), cand('e2', 'Bell', null)], CATS);
    expect(system).toContain('Rent');
    expect(system).toContain('Telephone & Internet');
    expect(user).toContain('"n":1');
    expect(user).toContain('"n":2');
    expect(user).not.toContain('"e1"');
    // machine-stable amounts in prompts
    expect(user).toContain('45.00');
  });
});

describe('parseBatchDecisions', () => {
  const cands = [cand('e1', 'WeWork', null), cand('e2', 'Bell', null)];
  it('reads a fenced JSON array, maps ordinals back to ids, drops unknown ordinals', () => {
    const raw = '```json\n[{"n":1,"categoryName":"Rent","confidence":0.93,"reason":"co-working"},{"n":9,"categoryName":"Meals","confidence":0.9,"reason":"x"}]\n```';
    const out = parseBatchDecisions(raw, cands);
    expect(out).toEqual([{ id: 'e1', categoryName: 'Rent', confidence: 0.93, reason: 'co-working' }]);
  });
  it('salvages a truncated array (token cap hit mid-object)', () => {
    const raw = '[{"n":1,"categoryName":"Rent","confidence":0.93,"reason":"co-working"},{"n":2,"categoryName":"Telephone & Inte';
    const out = parseBatchDecisions(raw, cands);
    expect(out.map((d) => d.id)).toEqual(['e1']);
  });
  it('returns [] on garbage or null', () => {
    expect(parseBatchDecisions(null, cands)).toEqual([]);
    expect(parseBatchDecisions('not json', cands)).toEqual([]);
  });
  it('coerces a non-numeric confidence to 0', () => {
    const out = parseBatchDecisions('[{"n":2,"categoryName":"Rent","confidence":"high","reason":""}]', cands);
    expect(out[0]).toMatchObject({ id: 'e2', confidence: 0 });
  });
});

describe('decide', () => {
  const cands = [cand('e1', 'WeWork', null), cand('e2', 'Bell', null), cand('e3', 'Mystery', null), cand('e4', 'Odd', null), cand('e5', 'Gone', null)];
  const decisions = [
    { id: 'e1', categoryName: 'Rent', confidence: 0.93, reason: 'co-working' },
    { id: 'e2', categoryName: 'Telephone & Internet', confidence: 0.7, reason: 'telco' },
    { id: 'e3', categoryName: null, confidence: 0.2, reason: 'unclear' },
    { id: 'e4', categoryName: 'Spaceships', confidence: 0.99, reason: 'invented' },
    // e5: no decision returned at all
  ];
  it('buckets apply / pending / skipped with a reason each', () => {
    const r = decide(cands, decisions, CATS);
    expect(r.apply.map((a) => a.cand.id)).toEqual(['e1']);
    expect(r.apply[0].category.name).toBe('Rent');
    expect(r.pending.map((p) => p.expenseId)).toEqual(['e2']);
    expect(r.pending[0].suggestedCategoryName).toBe('Telephone & Internet');
    expect(r.skipped.map((s) => [s.expenseId, s.reason])).toEqual([
      ['e3', 'low_confidence'], ['e4', 'unknown_category'], ['e5', 'llm_error'],
    ]);
  });
  it('matches category names case-insensitively', () => {
    const r = decide([cand('e1', 'WeWork', null)], [{ id: 'e1', categoryName: 'rent', confidence: 0.9, reason: '' }], CATS);
    expect(r.apply[0].category.id).toBe('c-rent');
  });
});

describe('formatCategorizeReply', () => {
  const base: CategorizeOutcome = { total: 0, applied: [], pending: [], skipped: [] };
  const applied = { expenseId: 'e1', vendorName: 'WeWork', description: null, amountCents: 45000, currency: 'CAD', date: D, categoryId: 'c-rent', categoryName: 'Rent', confidence: 0.93 };
  const pending = { expenseId: 'e2', vendorName: 'Bell', description: null, amountCents: 8999, currency: 'CAD', date: D, suggestedCategoryId: 'c-tel', suggestedCategoryName: 'Telephone & Internet', confidence: 0.7, reason: 'telco' };
  const skipped = { expenseId: 'e3', vendorName: null, description: '买了台电脑', amountCents: 1000000, currency: 'CAD', date: D, reason: 'no_signal' as const };

  it('says nothing was left when there was nothing to do', () => {
    expect(formatCategorizeReply({ ...base, total: 0 }, f)).toBe('skill.all_categorized');
  });
  it('NEVER says all done while items are skipped (the prod bug)', () => {
    const s = formatCategorizeReply({ total: 26, applied: [applied, applied], pending: [], skipped: Array(24).fill(skipped) }, f);
    expect(s).not.toContain('skill.all_categorized');
    expect(s).not.toContain('categorized_all');
    expect(s).toContain('skill.categorize_headline {"applied":2,"total":26}');
    expect(s).toContain('skill.categorize_skipped_header {"count":24}');
  });
  it('lists what it filed, vendor → category, with the amount', () => {
    const s = formatCategorizeReply({ total: 1, applied: [applied], pending: [], skipped: [] }, f);
    expect(s).toContain('$450.00');
    expect(s).toContain('WeWork → Rent');
    expect(s).toContain('skill.categorize_done_all');
  });
  it('lists pending suggestions with the Telegram hint and skipped items with a reason', () => {
    const s = formatCategorizeReply({ total: 2, applied: [], pending: [pending], skipped: [skipped] }, f);
    expect(s).toContain('Bell → Telephone & Internet (70%)');
    expect(s).toContain('skill.categorize_pending_hint_telegram');
    expect(s).toContain('买了台电脑');
    expect(s).toContain('skill.categorize_reason_no_signal');
  });
  it('uses the web hint on the web channel and caps each list at 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...applied, expenseId: `a${i}`, vendorName: `V${i}` }));
    const s = formatCategorizeReply({ total: 12, applied: many, pending: [pending], skipped: [] }, { ...f, channel: 'web' });
    expect(s).toContain('skill.categorize_pending_hint_web');
    expect(s).toContain('V9');
    expect(s).not.toContain('V10');
    expect(s).toContain('skill.categorize_and_more {"count":2}');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/categorize-expenses.test.ts`
Expected: FAIL — `Cannot find module '../categorize-expenses'`.

- [ ] **Step 3: Write the module**

```ts
// plugins/agentbook-core/backend/src/categorize-expenses.ts
/**
 * Pure logic for the categorize-expenses skill. No database, no HTTP.
 *
 * The previous handler asked Gemini once PER expense (26 sequential calls, 32 s
 * on a real account) and reported "All expenses are now categorized!" whenever
 * the medium-confidence bucket was empty — it never looked at what it skipped.
 * 24 of 26 rows were skipped that day. This module owns the three-way outcome
 * so the reply cannot omit a bucket, and one prompt covers BATCH_SIZE rows.
 */
export interface CategorizeCandidate {
  id: string; vendorName: string | null; description: string | null;
  amountCents: number; currency: string; date: Date; status: 'pending_review' | 'confirmed';
}
export interface CategoryOption { id: string; name: string; taxCategory?: string | null }
export interface BatchDecision { id: string; categoryName: string | null; confidence: number; reason: string }
export type SkipReason = 'no_signal' | 'low_confidence' | 'unknown_category' | 'llm_error';

/** `date` is required: the Telegram review walk-through does `new Date(it.date)` on pending items. */
interface Line { expenseId: string; vendorName: string | null; description: string | null; amountCents: number; currency: string; date: Date }
export interface CategorizeOutcome {
  total: number;
  applied: Array<Line & { categoryId: string; categoryName: string; confidence: number }>;
  pending: Array<Line & { suggestedCategoryId: string; suggestedCategoryName: string; confidence: number; reason: string }>;
  skipped: Array<Line & { reason: SkipReason }>;
}

export const HIGH_CONF = 0.85;
export const MEDIUM_CONF = 0.55;
export const BATCH_SIZE = 20;
/** Output budget per row: `{"n":12,"categoryName":"Software & Subscriptions","confidence":0.9,"reason":"…"}` is ~60–80 tokens; leave headroom. */
export const TOKENS_PER_ROW = 120;
const LIST_CAP = 10;

const line = (c: CategorizeCandidate): Line =>
  ({ expenseId: c.id, vendorName: c.vendorName, description: c.description, amountCents: c.amountCents, currency: c.currency, date: c.date });

export function hasSignal(c: CategorizeCandidate): boolean {
  return Boolean((c.vendorName ?? '').trim() || (c.description ?? '').trim());
}

export function buildBatchPrompt(cands: CategorizeCandidate[], categories: CategoryOption[]): { system: string; user: string } {
  const catList = categories.map((c) => `   • ${c.name}${c.taxCategory ? ` (${c.taxCategory})` : ''}`).join('\n');
  const system = [
    'You are a senior freelance bookkeeper. Classify EACH expense below into ONE of the available categories. Be conservative with confidence.',
    '', 'Available categories:', catList, '',
    'Output rules:',
    '• Return ONLY a JSON array, one object per expense, in any order: [{"n": <the expense number>, "categoryName": "<exact name from the list or null>", "confidence": 0.0-1.0, "reason": "a few words"}]',
    '• categoryName MUST be exactly one of the names above, or null when the expense is ambiguous.',
    '• Never invent a category. Never drop a number.',
  ].join('\n');
  // money-format-ok: prompt input, machine-stable on purpose. Ordinals, not
  // ids: a 25-char id echoed 20× is a third of the output budget.
  const user = cands.map((c, i) => JSON.stringify({
    n: i + 1,
    vendor: c.vendorName || null,
    description: c.description || null,
    amount: `${(c.amountCents / 100).toFixed(2)} ${c.currency}`,
    date: c.date.toISOString().slice(0, 10),
  })).join('\n');
  return { system, user: `Expenses (one JSON object per line):\n${user}` };
}

/**
 * Parse the model's array. Tolerates a code fence and a TRUNCATED array (the
 * output cap hit mid-object): everything up to the last complete `}` is kept,
 * so one long reason costs one row, not the whole batch.
 */
export function parseBatchDecisions(raw: string | null, cands: CategorizeCandidate[]): BatchDecision[] {
  if (!raw) return [];
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start < 0) return [];
  let body = cleaned.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const lastObj = body.lastIndexOf('}');
    if (lastObj < 0) return [];
    try { parsed = JSON.parse(body.slice(0, lastObj + 1) + ']'); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const out: BatchDecision[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const n = typeof d.n === 'number' ? d.n : Number(d.n);
    const cand = Number.isInteger(n) ? cands[n - 1] : undefined;
    if (!cand) continue;
    out.push({
      id: cand.id,
      categoryName: typeof d.categoryName === 'string' ? d.categoryName : null,
      confidence: typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? d.confidence : 0,
      reason: typeof d.reason === 'string' ? d.reason : '',
    });
  }
  return out;
}

export function decide(cands: CategorizeCandidate[], decisions: BatchDecision[], categories: CategoryOption[]) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const apply: Array<{ cand: CategorizeCandidate; category: CategoryOption; confidence: number }> = [];
  const pending: CategorizeOutcome['pending'] = [];
  const skipped: CategorizeOutcome['skipped'] = [];
  for (const c of cands) {
    const d = byId.get(c.id);
    if (!d) { skipped.push({ ...line(c), reason: 'llm_error' }); continue; }
    if (!d.categoryName) { skipped.push({ ...line(c), reason: 'low_confidence' }); continue; }
    const category = categories.find((k) => k.name.toLowerCase() === d.categoryName!.toLowerCase());
    if (!category) { skipped.push({ ...line(c), reason: 'unknown_category' }); continue; }
    if (d.confidence >= HIGH_CONF) apply.push({ cand: c, category, confidence: d.confidence });
    else if (d.confidence >= MEDIUM_CONF) pending.push({ ...line(c), suggestedCategoryId: category.id, suggestedCategoryName: category.name, confidence: d.confidence, reason: d.reason });
    else skipped.push({ ...line(c), reason: 'low_confidence' });
  }
  return { apply, pending, skipped };
}

const label = (l: Line) => l.vendorName?.trim() || l.description?.trim() || '';

export function formatCategorizeReply(
  o: CategorizeOutcome,
  f: { t: (k: string, p?: Record<string, string | number>) => string; money: (cents: number, currency?: string) => string; channel: string },
): string {
  if (o.total === 0) return f.t('skill.all_categorized');
  const parts: string[] = [f.t('skill.categorize_headline', { applied: o.applied.length, total: o.total })];
  const more = (n: number) => (n > LIST_CAP ? `\n${f.t('skill.categorize_and_more', { count: n - LIST_CAP })}` : '');

  if (o.applied.length) {
    parts.push(o.applied.slice(0, LIST_CAP)
      .map((a) => `• ${f.money(a.amountCents, a.currency)} ${label(a)} → ${a.categoryName}`).join('\n') + more(o.applied.length));
  }
  if (o.pending.length) {
    parts.push(f.t('skill.pending_review_phrase', { count: o.pending.length }) + '\n'
      + o.pending.slice(0, LIST_CAP)
        .map((p) => `• ${f.money(p.amountCents, p.currency)} ${label(p)} → ${p.suggestedCategoryName} (${Math.round(p.confidence * 100)}%)`).join('\n')
      + more(o.pending.length) + '\n'
      + f.t(f.channel === 'telegram' ? 'skill.categorize_pending_hint_telegram' : 'skill.categorize_pending_hint_web'));
  }
  if (o.skipped.length) {
    parts.push(f.t('skill.categorize_skipped_header', { count: o.skipped.length }) + '\n'
      + o.skipped.slice(0, LIST_CAP)
        .map((s) => `• ${f.money(s.amountCents, s.currency)} ${label(s) || f.t('skill.categorize_no_vendor')} — ${f.t(`skill.categorize_reason_${s.reason}`)}`).join('\n')
      + more(o.skipped.length));
  }
  if (!o.pending.length && !o.skipped.length) parts.push(f.t('skill.categorize_done_all'));
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/categorize-expenses.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/categorize-expenses.ts plugins/agentbook-core/backend/src/__tests__/categorize-expenses.test.ts
git commit -m "feat(chat): pure three-way categorize outcome + batched prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Wire the handler, the evaluator, and remove the adapter's private copy

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts` — the `if (selectedSkill.name === 'categorize-expenses') {` block (currently ~lines 4928–5075) inside `_executeClassificationCore`; the `wantsUncategorizedOnly` filter in the query-expenses handler (~5498–5505)
- Modify: `plugins/agentbook-core/backend/src/agent-evaluator.ts` — the `categorize-expenses` branch of `assessStepQuality`
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts:~655` — add `'categorize-expenses'` to `ESCALATION_EXEMPT_SKILLS` (the "Proceed?" round-trip in the prod transcript fired only because classifier confidence was < 0.55; the skill is idempotent and its medium/low buckets are non-destructive)
- Modify: `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` — delete the `// "categorize" / "auto-categorize now"` shortcut block (~lines 3024–3043)
- Test: `plugins/agentbook-core/backend/src/__tests__/categorize-wiring.test.ts` (new), `plugins/agentbook-core/backend/src/__tests__/agent-evaluator-categorize.test.ts` (new)

**Interfaces:**
- Consumes Task 1 exports.
- Produces: `skillResponse: { success: true, data: CategorizeOutcome }` and `responseData.message` from `formatCategorizeReply`. Later tasks (planner, evaluator) rely on `data.total / applied / pending / skipped`.

- [ ] **Step 1: Write the failing wiring + evaluator tests**

```ts
// plugins/agentbook-core/backend/src/__tests__/categorize-wiring.test.ts
/**
 * The categorize handler must (a) use the shared outcome module, (b) include
 * the 6999 suspense bucket, (c) apply through the ledger-owning HTTP route,
 * and (d) never loop Gemini per expense. A unit test of the module cannot see
 * any of that — assert the wiring in the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const start = SRC.indexOf("if (selectedSkill.name === 'categorize-expenses') {");
const end = SRC.indexOf('// INTERNAL handler: record-invoice-payment', start);
const BLOCK = SRC.slice(start, end);

describe('categorize-expenses handler wiring', () => {
  it('exists and is bounded', () => { expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); });
  it('builds the reply from the shared outcome module', () => {
    expect(BLOCK).toContain('formatCategorizeReply(');
    expect(BLOCK).toContain('decide(');
    expect(BLOCK).toContain('parseBatchDecisions(');
  });
  it('treats the 6999 suspense account as uncategorized — here AND in the query-expenses filter', () => {
    expect(BLOCK).toMatch(/OR:\s*\[\s*\{\s*categoryId:\s*null\s*\}/);
    expect(BLOCK).toContain("code: '6999'");
    const qe = SRC.slice(SRC.indexOf('const wantsUncategorizedOnly'), SRC.indexOf('const wantsUncategorizedOnly') + 1200);
    expect(qe).toMatch(/OR:\s*\[\s*\{\s*categoryId:\s*null\s*\}/);
  });
  it('books confirmed rows through the ledger-owning route; drafts get only a categoryId (the confirm route posts them later)', () => {
    expect(BLOCK).toContain('/categorize`');
    expect(BLOCK).toContain("status === 'confirmed'");
    // exactly one bare update, and it is the draft branch
    expect((BLOCK.match(/db\.abExpense\.update\(/g) || []).length).toBe(1);
  });
  it('does not talk to Gemini directly or once per expense', () => {
    expect(BLOCK).not.toContain('generativelanguage.googleapis.com');
    expect((BLOCK.match(/callGemini\(/g) || []).length).toBe(1);
    expect(BLOCK).toContain('BATCH_SIZE');
  });
  it('returns the structured outcome for the evaluator', () => {
    expect(BLOCK).toMatch(/skillResponse:\s*\{\s*success:\s*true,\s*data:\s*outcome/);
  });
});

describe('categorize-expenses is not confidence-escalated', () => {
  const BRAIN = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');
  const set = BRAIN.slice(BRAIN.indexOf('const ESCALATION_EXEMPT_SKILLS'), BRAIN.indexOf(']);', BRAIN.indexOf('const ESCALATION_EXEMPT_SKILLS')));
  it('is in ESCALATION_EXEMPT_SKILLS', () => { expect(set).toContain("'categorize-expenses'"); });
});

describe('telegram adapter has no private categorize path', () => {
  const ROUTE = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'), 'utf8');
  it('routes every categorize phrasing through the brain', () => {
    expect(ROUTE).not.toMatch(/\^\(auto\[\\- \]\?\)\?categori\[sz\]e/);
    expect(ROUTE).not.toContain('autoCategorizeForTenant(tenantId, { force: true })');
  });
});
```

```ts
// plugins/agentbook-core/backend/src/__tests__/agent-evaluator-categorize.test.ts
import { describe, it, expect } from 'vitest';
import { assessStepQuality } from '../agent-evaluator';

const step = (data: unknown) => ({
  id: 's1', action: 'categorize-expenses', description: 'categorize', params: {}, dependsOn: [],
  canUndo: false, status: 'done' as const, result: { success: true, data },
});

describe('evaluator reads the structured categorize outcome', () => {
  it('scores applied/total and names the skipped count', () => {
    const q = assessStepQuality(step({ total: 26, applied: [1, 2], pending: [], skipped: Array(24).fill({}) }));
    expect(q.score).toBeCloseTo(2 / 26, 3);
    expect(q.issues.join(' ')).toContain('24');
  });
  it('is a clean 1.0 when there was nothing to do', () => {
    expect(assessStepQuality(step({ total: 0, applied: [], pending: [], skipped: [] })).score).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/categorize-wiring.test.ts src/__tests__/agent-evaluator-categorize.test.ts`
Expected: FAIL on `formatCategorizeReply(`, `OR: [`, evaluator score.

- [ ] **Step 3: Replace the handler body in `server.ts`**

Add the import near the other local imports at the top of `server.ts`:

```ts
import {
  BATCH_SIZE, buildBatchPrompt, parseBatchDecisions, decide, formatCategorizeReply, hasSignal,
  type CategorizeCandidate, type CategorizeOutcome,
} from './categorize-expenses.js';
```

Replace everything inside `if (selectedSkill.name === 'categorize-expenses') { try { … } catch … }` with:

```ts
  if (selectedSkill.name === 'categorize-expenses') {
    try {
      const PENDING_KEY = 'telegram:ai_categorize_pending';
      const LAST_RUN_KEY = 'telegram:last_auto_categorize';
      const expenseBase = baseUrls['/api/v1/agentbook-expense'] || 'http://localhost:4051';

      // "Uncategorized" means EITHER no category OR parked in the 6999 suspense
      // account (where #426 posts confirmed expenses that have none). The
      // breakdown shows both as "Uncategorized"; so must this skill.
      const suspense = await db.abAccount.findFirst({ where: { tenantId, code: '6999' }, select: { id: true } });
      const rows = await db.abExpense.findMany({
        where: {
          tenantId, isPersonal: false, deletedAt: null, status: { in: ['pending_review', 'confirmed'] },
          OR: [{ categoryId: null }, ...(suspense ? [{ categoryId: suspense.id }] : [])],
        },
        include: { vendor: { select: { id: true, name: true, normalizedName: true } } },
        orderBy: { date: 'desc' },
        take: 50,
      });
      const categories = (await db.abAccount.findMany({
        where: { tenantId, accountType: 'expense', isActive: true, NOT: { code: '6999' } },
        select: { id: true, name: true, code: true, taxCategory: true },
      }));
      const cands: CategorizeCandidate[] = rows.map((e) => ({
        id: e.id, vendorName: e.vendor?.name ?? null, description: e.description ?? null,
        amountCents: e.amountCents, currency: e.currency, date: e.date,
        status: e.status === 'confirmed' ? 'confirmed' : 'pending_review',
      }));
      const asLine = (c: CategorizeCandidate) => ({ expenseId: c.id, vendorName: c.vendorName, description: c.description, amountCents: c.amountCents, currency: c.currency, date: c.date });

      const outcome: CategorizeOutcome = { total: cands.length, applied: [], pending: [], skipped: [] };
      const withSignal = cands.filter((c) => {
        if (hasSignal(c)) return true;
        outcome.skipped.push({ ...asLine(c), reason: 'no_signal' });
        return false;
      });

      for (let i = 0; i < withSignal.length && categories.length > 0; i += BATCH_SIZE) {
        const chunk = withSignal.slice(i, i + BATCH_SIZE);
        const { system, user } = buildBatchPrompt(chunk, categories);
        const raw = await callGemini(system, user, TOKENS_PER_ROW * chunk.length + 200);
        const { apply, pending, skipped } = decide(chunk, parseBatchDecisions(raw, chunk), categories);
        outcome.pending.push(...pending);
        outcome.skipped.push(...skipped);
        for (const a of apply) {
          let ok = false;
          if (a.cand.status === 'confirmed') {
            // A confirmed row is on the books (against 6999 if it had no
            // category). The categorize route owns ledger posting: it moves
            // that debit to the chosen account and learns the vendor pattern.
            // Setting categoryId inline (the old code) left the P&L on
            // "Uncategorized".
            const res = await fetch(`${expenseBase}/api/v1/agentbook-expense/expenses/${a.cand.id}/categorize`, {
              method: 'POST', headers: brainHeaders(tenantId),
              body: JSON.stringify({ categoryId: a.category.id, source: 'auto_categorize' }),
            }).catch(() => null);
            ok = Boolean(res?.ok);
          } else {
            // A draft is NOT on the books yet; the confirm route posts it with
            // whatever category it has then. Going through the categorize
            // route here would book an unconfirmed expense.
            ok = await db.abExpense.update({ where: { id: a.cand.id }, data: { categoryId: a.category.id, confidence: a.confidence } })
              .then(() => true).catch(() => false);
          }
          if (ok) outcome.applied.push({ ...asLine(a.cand), categoryId: a.category.id, categoryName: a.category.name, confidence: a.confidence });
          else outcome.skipped.push({ ...asLine(a.cand), reason: 'llm_error' });
        }
      }
      if (categories.length === 0) {
        for (const c of withSignal) outcome.skipped.push({ ...asLine(c), reason: 'unknown_category' });
      }

      // Pending batch feeds the Telegram "review" walk-through and the web review UI (same key as before).
      if (outcome.pending.length > 0) {
        await db.abUserMemory.upsert({
          where: { tenantId_key: { tenantId, key: PENDING_KEY } },
          update: { value: JSON.stringify({ items: outcome.pending, builtAt: Date.now() }), lastUsed: new Date() },
          create: { tenantId, key: PENDING_KEY, value: JSON.stringify({ items: outcome.pending, builtAt: Date.now() }), type: 'pending_action', confidence: 1 },
        }).catch(() => {});
      } else if (cands.length > 0) {
        await db.abUserMemory.deleteMany({ where: { tenantId, key: PENDING_KEY } }).catch(() => {});
      }
      await db.abUserMemory.upsert({
        where: { tenantId_key: { tenantId, key: LAST_RUN_KEY } },
        update: { value: JSON.stringify({ at: new Date().toISOString() }), lastUsed: new Date() },
        create: { tenantId, key: LAST_RUN_KEY, value: JSON.stringify({ at: new Date().toISOString() }), type: 'audit', confidence: 1 },
      }).catch(() => {});

      const message = formatCategorizeReply(outcome, { t, money: tenantMoney, channel });

      await db.abConversation.create({
        data: { tenantId, question: text || '[categorize]', answer: message, queryType: 'agent', channel, skillUsed: 'categorize-expenses' },
      }).catch(() => {});

      return {
        selectedSkill, extractedParams, confidence, skillUsed: 'categorize-expenses',
        skillResponse: { success: true, data: outcome },
        responseData: { message, skillUsed: 'categorize-expenses', confidence, latencyMs: Date.now() - startTime },
      };
    } catch (err) {
      console.error('[categorize-expenses] error:', err);
      return {
        selectedSkill, extractedParams, confidence: 0, skillUsed: 'categorize-expenses', skillResponse: null,
        responseData: { message: t('skill.categorize_failed'), skillUsed: 'categorize-expenses', confidence: 0, latencyMs: Date.now() - startTime },
      };
    }
  }
```

Note: `t`, `tenantMoney`, `brainHeaders`, `baseUrls`, `callGemini`, `channel`, `text`, `startTime` are already in scope in this function (see the daily-briefing handler at ~5759 for `baseUrls`/`brainHeaders` usage). Import `TOKENS_PER_ROW` alongside `BATCH_SIZE`. The `pending` items carry `expenseId/vendorName/amountCents/date/description/suggestedCategoryId/suggestedCategoryName/confidence/reason` — exactly `PendingSuggestion` in `apps/web-next/src/lib/agentbook-auto-categorize.ts:26-36`, which the Telegram review walk-through reads (`new Date(it.date)` at `route.ts:~507` — a missing `date` throws). Keep the shapes identical.

Also in `server.ts`, the query-expenses handler's `wantsUncategorizedOnly` (~5498–5505) currently narrows with `categoryId: null` only. Change it to the same two-bucket definition:
```ts
      const suspenseQe = wantsUncategorizedOnly
        ? await db.abAccount.findFirst({ where: { tenantId, code: '6999' }, select: { id: true } })
        : null;
      // …in the findMany where:
          ...(wantsUncategorizedOnly ? { OR: [{ categoryId: null }, ...(suspenseQe ? [{ categoryId: suspenseQe.id }] : [])] } : {}),
```
In `agent-brain.ts` add `'categorize-expenses',` to the `ESCALATION_EXEMPT_SKILLS` set (after `'general-question'`).

Known, accepted: the daily cron still uses its own copy (`autoCategorizeForTenant` in `apps/web-next/src/lib/agentbook-auto-categorize.ts`, called from the digest at `route.ts:~2244/2304`) with the `categoryId: null` definition. Chat now has one path; unifying the cron onto the brain's module is a follow-up, named in the PR body.

- [ ] **Step 4: Evaluator reads structure**

In `agent-evaluator.ts` replace the `else if (step.action === 'categorize-expenses') { … }` branch with:

```ts
  } else if (step.action === 'categorize-expenses') {
    const d = step.result?.data as { total?: number; applied?: unknown[]; skipped?: unknown[]; pending?: unknown[] } | undefined;
    if (d && typeof d.total === 'number') {
      const applied = d.applied?.length ?? 0;
      const skipped = d.skipped?.length ?? 0;
      score = d.total > 0 ? applied / d.total : 1;
      if (d.total > 0 && score < 0.5) issues.push(`Only ${applied} of ${d.total} expenses categorized`);
      if (skipped > 0) issues.push(`${skipped} expenses skipped during categorization`);
    }
  }
```

- [ ] **Step 5: Delete the Telegram shortcut**

In `webhook/route.ts` remove the whole block starting at the comment `// "categorize" / "auto-categorize now" → run the auto-categorizer` through its closing `return;\n    }` (the `if (/^(auto[\- ]?)?categori[sz]e( now| my expenses)?$/i.test(lower)) { … }` statement). If `autoCategorizeForTenant` is now unused in the route, drop it from the import on line 30 (keep `getPendingSuggestions, dropPendingSuggestion`).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd plugins/agentbook-core/backend && npx vitest run` then `cd ../../../apps/web-next && npx tsc --noEmit -p . && npx vitest run src/__tests__/architecture`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/agent-evaluator.ts apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts plugins/agentbook-core/backend/src/__tests__/categorize-wiring.test.ts plugins/agentbook-core/backend/src/__tests__/agent-evaluator-categorize.test.ts
git commit -m "fix(chat): categorize-expenses reports every bucket, includes 6999, posts via ledger route, batches Gemini

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: Catalog keys for the new reply

**Files:**
- Modify: `packages/agentbook-i18n/src/locales/en/skill.json`, `.../fr-CA/skill.json`, `.../zh-CN/skill.json`

- [ ] **Step 1: Add keys (all three files), remove the dead ones**

Add to **en**:
```json
"categorize_headline": "Categorized {applied} of {total} uncategorized expenses.",
"categorize_done_all": "Everything is filed — nothing left to categorize.",
"categorize_skipped_header": "{count} I couldn't place — tell me the category (e.g. \"the WeWork one is Rent\"):",
"categorize_pending_hint_telegram": "Reply \"review\" to confirm these one by one.",
"categorize_pending_hint_web": "Confirm these on the Expenses page.",
"categorize_and_more": "…and {count} more.",
"categorize_no_vendor": "(no vendor)",
"categorize_reason_no_signal": "no vendor or description to go on",
"categorize_reason_low_confidence": "not confident enough",
"categorize_reason_unknown_category": "no matching category in your chart",
"categorize_reason_llm_error": "couldn't analyse it this time",
"categorize_failed": "I couldn't categorize the expenses. Please try again."
```
**fr-CA**:
```json
"categorize_headline": "{applied} dépenses catégorisées sur {total} non catégorisées.",
"categorize_done_all": "Tout est classé — plus rien à catégoriser.",
"categorize_skipped_header": "{count} que je n'ai pas pu classer — indiquez-moi la catégorie (p. ex. « celle de WeWork est Loyer ») :",
"categorize_pending_hint_telegram": "Répondez « review » pour les confirmer une par une.",
"categorize_pending_hint_web": "Confirmez-les sur la page Dépenses.",
"categorize_and_more": "…et {count} de plus.",
"categorize_no_vendor": "(aucun fournisseur)",
"categorize_reason_no_signal": "aucun fournisseur ni description",
"categorize_reason_low_confidence": "pas assez de certitude",
"categorize_reason_unknown_category": "aucune catégorie correspondante dans votre plan comptable",
"categorize_reason_llm_error": "analyse impossible cette fois",
"categorize_failed": "Je n'ai pas pu catégoriser les dépenses. Veuillez réessayer."
```
**zh-CN**:
```json
"categorize_headline": "已归类 {applied} 笔（共 {total} 笔未归类支出）。",
"categorize_done_all": "全部归档完毕，没有待归类的支出了。",
"categorize_skipped_header": "有 {count} 笔无法归类，请告诉我类别（例如「WeWork 那笔是房租」）：",
"categorize_pending_hint_telegram": "回复「review」逐条确认。",
"categorize_pending_hint_web": "请在「支出」页面确认。",
"categorize_and_more": "…还有 {count} 笔。",
"categorize_no_vendor": "（无供应商）",
"categorize_reason_no_signal": "没有供应商或描述可供判断",
"categorize_reason_low_confidence": "把握不足",
"categorize_reason_unknown_category": "科目表中没有匹配的类别",
"categorize_reason_llm_error": "本次无法分析",
"categorize_failed": "无法归类这些支出，请重试。"
```
Remove from all three `skill.json`: `categorized_all_one`, `categorized_all_other`, `categorized_partial_one`, `categorized_partial_other`, `categorize_unsure_one`, `categorize_unsure_other`. Remove from all three `bot.json` the keys the deleted Telegram shortcut used: `auto_categorized_expense*`, `need_a_quick_check_type_review_to*`, `nothing_i_can_categorize_automatically_expense_need*`, `all_expenses_already_categorized_nothing_to_do` (check each with `grep -rn "<key>" plugins apps packages --include='*.ts' --include='*.tsx' | grep -v locales` — delete only keys with zero non-test references; if a test references one, update the test to the new key). Known test to update: `plugins/agentbook-core/backend/src/__tests__/skill-replies-locale.test.ts:~398-399` asserts `skill.categorized_all` — switch it to `skill.categorize_headline` with `{ applied, total }`. Keep `all_categorized` and `pending_review_phrase_*`.

- [ ] **Step 2: Run the catalog guard + core tests**

Run: `cd apps/web-next && npx vitest run src/__tests__/architecture/i18n-catalog.test.ts && cd ../../plugins/agentbook-core/backend && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit, open PR A**

```bash
git add packages/agentbook-i18n/src/locales
git commit -m "i18n(skill): categorize reply keys in en/fr-CA/zh-CN; drop dead categorized_* keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/chat-categorize-truthful
gh pr create --title "fix(chat): categorize-expenses tells the truth, lists what it did, includes 6999, 1 Gemini call per 20 rows" --body-file <(cat <<'EOF'
Fixes F1–F4, F13 of docs/superpowers/specs/2026-09-13-chat-quality-review.md and a latent ledger bug (categoryId set without moving the 6999 suspense debit).

- three-way outcome (applied / pending / skipped) — "all categorized" only when both other buckets are empty
- reply lists vendor → category with amounts; skipped items carry a reason
- 6999 suspense rows count as uncategorized (matches the breakdown)
- applies through POST /expenses/:id/categorize (ledger + vendor pattern), no inline update
- one batched Gemini call per 20 rows (was 1 per row, 32 s on prod)
- Telegram's private `^categorize$` shortcut removed — one implementation
- evaluator reads structured counts

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

---

## PR B — the reply follows the user's language

### Task 4: `reply-language.ts`

**Files:**
- Create: `plugins/agentbook-core/backend/src/reply-language.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/reply-language.test.ts`

**Interfaces:**
- Produces:
```ts
export type DetectedLanguage = 'en' | 'fr' | 'zh';
export function detectMessageLanguage(text: string): DetectedLanguage | null
export function resolveReplyLocale(opts: {
  text: string;
  /** Earlier USER messages, most recent first. */
  previousUserTexts?: string[];
  tenantLocale?: string | null;
}): string   // BCP-47, e.g. 'en-CA', 'fr-CA', 'zh-CN', 'en-US'
```

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/agentbook-core/backend/src/__tests__/reply-language.test.ts
import { describe, it, expect } from 'vitest';
import { detectMessageLanguage, resolveReplyLocale } from '../reply-language';

describe('detectMessageLanguage', () => {
  it('sees CJK', () => { expect(detectMessageLanguage('记录 42 元咖啡')).toBe('zh'); });
  it('sees French by stopwords or accents', () => {
    expect(detectMessageLanguage('Montre-moi mes dépenses du mois')).toBe('fr');
    expect(detectMessageLanguage('combien ai-je dépensé en repas')).toBe('fr');
  });
  it('sees English by stopwords', () => {
    expect(detectMessageLanguage('Categorize them')).toBe('en');
    expect(detectMessageLanguage('show my expenses this month')).toBe('en');
  });
  it('returns null when too short or ambiguous', () => {
    expect(detectMessageLanguage('yes')).toBeNull();
    expect(detectMessageLanguage('ok')).toBeNull();
    expect(detectMessageLanguage('$42 Starbucks')).toBeNull();
    expect(detectMessageLanguage('')).toBeNull();
  });
});

describe('resolveReplyLocale', () => {
  it('English on a fr-CA tenant → en-CA (English words, Canadian formatting)', () => {
    expect(resolveReplyLocale({ text: 'Categorize them', tenantLocale: 'fr-CA' })).toBe('en-CA');
  });
  it('French on a fr-CA tenant keeps fr-CA', () => {
    expect(resolveReplyLocale({ text: 'Catégorise-les', tenantLocale: 'fr-CA' })).toBe('fr-CA');
  });
  it('French on an en-US tenant → fr-CA (the only French catalog)', () => {
    expect(resolveReplyLocale({ text: 'Montre mes dépenses', tenantLocale: 'en-US' })).toBe('fr-CA');
  });
  it('Chinese anywhere → zh-CN', () => {
    expect(resolveReplyLocale({ text: '记录 42 元咖啡', tenantLocale: 'en-AU' })).toBe('zh-CN');
  });
  it('a short turn continues the language of the MOST RECENT detectable user turn (array is newest-first)', () => {
    expect(resolveReplyLocale({ text: 'yes', previousUserTexts: ['ok', 'Categorize them'], tenantLocale: 'fr-CA' })).toBe('en-CA');
    expect(resolveReplyLocale({ text: 'oui', previousUserTexts: ['Montre mes dépenses'], tenantLocale: 'en-US' })).toBe('fr-CA');
    // thread switched en → fr; the newest wins, not the oldest
    expect(resolveReplyLocale({ text: 'ok', previousUserTexts: ['Montre mes dépenses', 'show my expenses'], tenantLocale: 'en-US' })).toBe('fr-CA');
  });
  it('falls back to the tenant locale, then en-US', () => {
    expect(resolveReplyLocale({ text: 'yes', tenantLocale: 'fr-CA' })).toBe('fr-CA');
    expect(resolveReplyLocale({ text: 'yes', tenantLocale: null })).toBe('en-US');
  });
  it('English keeps the tenant region for AU/GB/US', () => {
    expect(resolveReplyLocale({ text: 'show my expenses', tenantLocale: 'en-AU' })).toBe('en-AU');
    expect(resolveReplyLocale({ text: 'show my expenses', tenantLocale: 'zh-CN' })).toBe('en-US');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/reply-language.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// plugins/agentbook-core/backend/src/reply-language.ts
/**
 * Which language a reply should be in.
 *
 * The LLM half of a reply already mirrors the user (see language.ts). The
 * deterministic half — catalog templates and number/date formatting — read
 * AbTenantConfig.locale instead, so an English question on a fr-CA tenant got
 * an English summary with `42 014,79 CA$` inside it and a French result line
 * after it. One resolver, used by both halves, ends that.
 *
 * Rule: language of THIS message → language of the most recent earlier user
 * message that is detectable → tenant locale → en-US. English keeps the
 * tenant's region (en-CA on a Canadian tenant) so currency formats the way
 * that country writes it.
 */
export type DetectedLanguage = 'en' | 'fr' | 'zh';

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const FR_MARK = /[àâçéèêëîïôûùüÿœ]/i;
const FR_WORDS = /\b(le|la|les|des|du|de|un|une|mes|mon|ma|je|tu|nous|vous|est|sont|pour|avec|sur|dans|que|qui|pas|combien|montre|moi|oui|non|dépens\w*|facture\w*|catégori\w*)\b/i;
const EN_WORDS = /\b(the|my|me|i|is|are|was|show|what|how|much|did|spend|spent|expenses?|invoices?|categori[sz]e|them|this|last|month|year|please|can|you|give|more|details?|cash|balance|what's|whats)\b/i;

export function detectMessageLanguage(text: string): DetectedLanguage | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  if (CJK.test(s)) return 'zh';
  const words = s.split(/\s+/).filter((w) => /[a-zà-ÿ]/i.test(w));
  if (words.length < 2 && !FR_MARK.test(s)) {
    // One-word turns ("yes", "ok", "oui") are continuation, not a signal.
    return null;
  }
  const fr = (FR_MARK.test(s) ? 1 : 0) + (s.match(new RegExp(FR_WORDS.source, 'gi'))?.length ?? 0);
  const en = s.match(new RegExp(EN_WORDS.source, 'gi'))?.length ?? 0;
  if (fr === 0 && en === 0) return null;
  return fr > en ? 'fr' : 'en';
}

const ENGLISH_REGIONS = new Set(['CA', 'AU', 'GB', 'US', 'NZ', 'IE']);

function regionOf(locale: string | null | undefined): string | null {
  const m = (locale ?? '').match(/^[a-z]{2,3}[-_]([A-Za-z]{2})\b/);
  return m ? m[1].toUpperCase() : null;
}

function localeFor(lang: DetectedLanguage, tenantLocale: string | null | undefined): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'fr') return 'fr-CA';
  const region = regionOf(tenantLocale);
  return region && ENGLISH_REGIONS.has(region) ? `en-${region}` : 'en-US';
}

export function resolveReplyLocale(opts: {
  text: string;
  previousUserTexts?: string[];
  tenantLocale?: string | null;
}): string {
  const tenant = opts.tenantLocale && opts.tenantLocale.trim() ? opts.tenantLocale.trim() : null;
  let lang = detectMessageLanguage(opts.text);
  if (!lang) {
    for (const prev of opts.previousUserTexts ?? []) {
      lang = detectMessageLanguage(prev);
      if (lang) break;
    }
  }
  if (!lang) return tenant ?? 'en-US';
  const tenantLang = tenant?.toLowerCase().split(/[-_]/)[0];
  if (tenantLang === lang) return tenant!;
  return localeFor(lang, tenant);
}
```

- [ ] **Step 4: Run tests → PASS, commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/reply-language.test.ts`
```bash
git add plugins/agentbook-core/backend/src/reply-language.ts plugins/agentbook-core/backend/src/__tests__/reply-language.test.ts
git commit -m "feat(chat): resolveReplyLocale — reply language follows the user, then the thread, then the tenant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Wire the resolver into the brain and the skill handlers

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts:~3581-3590` (the `tenantLocale` / `t` / `tenantMoney` setup in `_executeClassificationCore`)
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts:~1090-1093` (`replyConfig` / `t`) and `buildResponse` to expose `replyLocale`
- Test: `plugins/agentbook-core/backend/src/__tests__/reply-locale-wiring.test.ts` (new)

**Interfaces:**
- Produces: `AgentResponse.data.replyLocale?: string` (read by the Telegram adapter in Task 6).
- `_executeClassificationCore` gets `conversation` from `classification.conversation` (already on `ClassificationResult`, oldest-first per `pairTurns`).

- [ ] **Step 1: Failing wiring test**

```ts
// plugins/agentbook-core/backend/src/__tests__/reply-locale-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const SERVER = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const BRAIN = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');

describe('reply locale wiring', () => {
  it('server.ts derives the reply locale from the user text, not the tenant row alone', () => {
    expect(SERVER).toContain('resolveReplyLocale({');
    expect(SERVER).toMatch(/const t = replyT\(\{ locale: replyLocale \}\)/);
    expect(SERVER).not.toMatch(/replyT\(\{ locale: tenantLocale \}\)/);
    // money in replies formats with the reply locale
    expect(SERVER).toMatch(/const tenantMoney = \(cents: number, currency\?: string\) =>\s*fmtCurrency\(cents, currency \|\| tenantCurrency, replyLocale\)/);
  });
  it('agent-brain.ts uses the same resolver for its own templates and reports it', () => {
    expect(BRAIN).toContain('resolveReplyLocale({');
    expect(BRAIN).not.toMatch(/const t = replyT\(replyConfig\)/);
    expect(BRAIN).toContain('replyLocale');
  });
});
```

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/reply-locale-wiring.test.ts` → FAIL.

- [ ] **Step 2: server.ts**

Import: `import { resolveReplyLocale } from './reply-language.js';`

Replace the block at ~3581:
```ts
  const tenantLocale: string = classification.tenantConfig?.locale || 'en-US';
  const tenantCurrency: string = classification.tenantConfig?.currency || 'USD';
  const t = replyT({ locale: tenantLocale });
  const tenantMoney = (cents: number, currency?: string) =>
    fmtCurrency(cents, currency || tenantCurrency, tenantLocale);
```
with:
```ts
  const tenantLocale: string = classification.tenantConfig?.locale || 'en-US';
  const tenantCurrency: string = classification.tenantConfig?.currency || 'USD';
  // The language of THIS reply: the user's, then the thread's, then the
  // tenant's (see reply-language.ts). `conversation` is NEWEST FIRST — that
  // is the contract of both producers (pairTurns reverses; the fallback fetch
  // orders createdAt desc; see conversation-order.test.ts) — so pass it as is.
  const replyLocale: string = resolveReplyLocale({
    text,
    previousUserTexts: (classification.conversation ?? []).map((c: any) => String(c?.question ?? '')),
    tenantLocale,
  });
  const t = replyT({ locale: replyLocale });
  const tenantMoney = (cents: number, currency?: string) =>
    fmtCurrency(cents, currency || tenantCurrency, replyLocale);
```
Then replace every other reply-facing use of `tenantLocale` inside `_executeClassificationCore` (`tenantMoneyCompact`, `toLocaleDateString(tenantLocale…)`, `fmtCurrency(..., tenantLocale)` at ~4474, ~6355, ~6368) with `replyLocale`. Keep `tenantLocale` where it is passed to the LLM as tenant metadata. Also attach `replyLocale` to every `responseData` returned from this function: the simplest is to set it once where the function's final `return { … responseData }` is built (search for `responseData: {` occurrences; add `replyLocale` to the common `responseData` construction at the end of the function, and to the early-return handlers touched in this plan: categorize-expenses, query-expenses, daily-briefing).

- [ ] **Step 3: agent-brain.ts**

Import: `import { resolveReplyLocale } from './reply-language.js';`
Replace
```ts
  const t = replyT(replyConfig);
```
with
```ts
  // Same rule as server.ts: this reply's language follows the user's text.
  // History is not loaded yet at this point (Step 2), so short turns fall
  // back to the tenant locale here; the skill handlers, which do have the
  // thread, refine it. Both resolve identically for any detectable message.
  const replyLocale = resolveReplyLocale({ text, tenantLocale: replyConfig?.locale ?? null });
  const t = replyT({ locale: replyLocale });
```
In `buildResponse` (search `function buildResponse`), make sure `data.replyLocale` passes through: add `replyLocale?: string` to the accepted fields and to the returned `data`. In the final `buildResponse({...})` of Step 5 and the confirm path, pass `replyLocale: responseData.replyLocale ?? replyLocale`.

- [ ] **Step 4: Tests, typecheck, commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run && cd ../../../apps/web-next && npx tsc --noEmit -p .`
```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/__tests__/reply-locale-wiring.test.ts
git commit -m "fix(chat): templates and money format in the reply locale, not the tenant locale

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Telegram adapter renders in the brain's reply locale

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` — the `callAgentBrain` result handling (~3329-3358) and the `runWithBotLocale(botLocaleRow, …)` entry (~6181-6215)
- Test: `apps/web-next/src/__tests__/architecture/telegram-reply-locale.test.ts` (new)

- [ ] **Step 1: Failing test**

```ts
// apps/web-next/src/__tests__/architecture/telegram-reply-locale.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const ROUTE = readFileSync(join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'), 'utf8');

describe('telegram reply locale', () => {
  it('re-enters the bot locale scope with the brain\'s replyLocale before rendering its reply', () => {
    // both the text path (~3329) and the Proceed-button callback path (~4552)
    expect((ROUTE.match(/runWithBotLocale\(\s*\{\s*\.\.\.botLocaleRowFor\(\)[^}]*locale:\s*result\.data\.replyLocale/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  it('detects the incoming message language for adapter-native replies', () => {
    expect(ROUTE).toContain('resolveReplyLocale({');
  });
});
```

Run: `cd apps/web-next && npx vitest run src/__tests__/architecture/telegram-reply-locale.test.ts` → FAIL.

- [ ] **Step 2: Implement**

1. Import in the route: `import { resolveReplyLocale } from '@agentbook-core/reply-language';`
2. Where `botLocaleRow` is loaded (~6195) keep it, and store it on a module-scoped `WeakMap`-free helper: add right after the `botLocaleRow = cfg;` line a small closure the handlers can call. Simplest: hoist `botLocaleRow` into the `AsyncLocalStorage` scope already used — `botLoc()` returns `{ locale, currency, timezone }`. So define in the route:
```ts
/** The row the current update was scoped with (currency/timezone), for re-scoping with a different language. */
function botLocaleRowFor(): { locale: string; currency: string; timezone: string } {
  const loc = botLoc();
  return { locale: loc.locale, currency: loc.currency, timezone: loc.timezone };
}
```
(Adjust the Task 6 test regex to `botLocaleRowFor\(\)`.) Known nit, accepted: the brain formats CAD under en-CA as `CA$42,014.79` (`fmtCurrency`) while adapter chrome under en-CA prints `$42,014.79` (`outMoney`); with the Breakdown block now skipped when the answer already enumerates, the two rarely meet in one message.
```ts
```
3. At the scope entry (~`runWithBotLocale(botLocaleRow, () => …)`), derive the incoming text and resolve:
```ts
      const incomingText =
        (update as any)?.message?.text ?? (update as any)?.edited_message?.text ?? (update as any)?.callback_query?.message?.text ?? '';
      const scopedRow = botLocaleRow
        ? { ...botLocaleRow, locale: resolveReplyLocale({ text: String(incomingText), tenantLocale: botLocaleRow.locale }) }
        : botLocaleRow;
```
and pass `scopedRow` instead of `botLocaleRow`.
4. In the brain result handling (~3329):
```ts
      const result = await callAgentBrain(tenantId, agentText, undefined, sessionAction, feedback, String(ctx.chat.id));
      if (result.success && result.data) {
        await runWithBotLocale({ ...botLocaleRowFor(tenantId), locale: result.data.replyLocale ?? botLoc().locale }, async () => {
          const reply: string = formatResponse(result.data);
          /* existing keyboard construction + ctx.reply calls, unchanged, moved inside this callback */
        });
      } else {
```
5. The **Proceed button** path renders the brain's reply too — `callback_query` handler for `session:confirm` / `session:cancel` (~route.ts:4552-4560, the turn-3 path in the prod transcript). Wrap its `formatResponse`/`ctx.reply` in the same `runWithBotLocale({ ...botLocaleRowFor(tenantId), locale: result.data.replyLocale ?? botLoc().locale }, …)`.
Extend `callAgentBrain`'s return type with `replyLocale?: string`.

- [ ] **Step 3: Tests, typecheck, commit, PR B**

Run: `cd apps/web-next && npx tsc --noEmit -p . && npx vitest run src/__tests__/architecture src/app/api/v1/agentbook/telegram`
```bash
git add apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts apps/web-next/src/__tests__/architecture/telegram-reply-locale.test.ts
git commit -m "fix(telegram): render the brain's reply in the reply locale it chose

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/chat-reply-language
gh pr create --title "fix(chat): reply language follows the user (templates + money format), on web and Telegram" --body "Fixes F5 of docs/superpowers/specs/2026-09-13-chat-quality-review.md. English question on a fr-CA tenant → English templates and en-CA money; French stays French; short turns continue the thread's language.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## PR C — follow-ups remember, and no skill points at a dead endpoint

### Task 7: general-question answered by the grounded advisor, with history

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts` — Step 3b/3c (after `classification` is known, before the confirm gate)
- Modify: `plugins/agentbook-core/backend/src/built-in-skills.ts:~898-901` (`general-question` endpoint → INTERNAL)
- Modify: `plugins/agentbook-core/backend/src/server.ts:~5940` (catch-all `accountantEngagement` call: pass `recentConvo`)
- Modify: `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` `callAgentBrain` ctx: add `buildGroundingFacts`
- Test: `plugins/agentbook-core/backend/src/__tests__/agent-brain-general-question.test.ts` (new)

- [ ] **Step 1: Failing brain test**

```ts
// plugins/agentbook-core/backend/src/__tests__/agent-brain-general-question.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTestContext } from './helpers/test-context';

// Thread with one prior exchange: the briefing. (Same db mock shape as
// agent-brain-french-locale.test.ts — copy its vi.mock('../db/client.js') block
// and give abConvThread.findFirst a thread whose turns hold the exchange.)
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abConvThread: {
      findFirst: vi.fn(async () => ({
        id: 'thread-1', lastActiveAt: new Date(), activeEntities: [], parkedFills: [],
        turns: [
          { role: 'user', text: 'Briefing', at: '2026-09-13T15:06:00.000Z' },
          { role: 'bot', text: 'Good morning. 61 bank transactions need matching; two expenses over $25 are missing receipts.', at: '2026-09-13T15:06:33.000Z', intent: 'daily-briefing' },
        ],
      })),
      create: vi.fn(async (a: any) => ({ id: 'thread-1', turns: [], ...a.data })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => ({ ...a.data, id: 's', version: 1 })), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => ({ locale: 'en-US', jurisdiction: 'ca' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    abAdvisorPersona: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

import { handleAgentMessage } from '../agent-brain';

describe('general-question is answered with the thread in view', () => {
  it('sends the previous bot turn to the model and never calls executeClassification', async () => {
    const gq = { name: 'general-question', endpoint: { method: 'INTERNAL', url: '' }, parameters: { question: 'string' } };
    const { req, ctx, executeClassification, llmCalls } = buildTestContext({
      text: 'Give me more details',
      classification: { selectedSkill: gq, extractedParams: { question: 'Give me more details' }, confidence: 0.4 },
      skills: [gq],
      llmFixtures: [{ userMatch: 'more details', response: 'Sure — the 61 unmatched transactions are…' }],
    });
    ctx.buildGroundingFacts = vi.fn(async () => ['Cash on hand: $16,926.10']);
    const res = await handleAgentMessage(req, ctx);
    expect(res.success).toBe(true);
    expect(res.data.message).toContain('61 unmatched');
    expect(executeClassification).not.toHaveBeenCalled();
    const sawHistory = llmCalls.history.some((h) => h.user.includes('61 bank transactions') || h.system.includes('61 bank transactions'));
    expect(sawHistory, 'previous bot turn was not in any prompt').toBe(true);
    const sawFacts = llmCalls.history.some((h) => (h.user + h.system).includes('16,926.10'));
    expect(sawFacts, 'grounding facts were not in any prompt').toBe(true);
  });
});
```
(Adjust `buildTestContext`'s returned names to what `helpers/test-context.ts` actually exports — it returns `req`, `ctx`, `executeClassification`, `llmCalls`; read the end of that file.)

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/agent-brain-general-question.test.ts` → FAIL (executeClassification called, or NOT_IMPLEMENTED path).

- [ ] **Step 2: Implement in agent-brain.ts**

Right after `classification` is obtained (the `if (ctx.classifyOnly) { classification = await ctx.classifyOnly(...) }` block) and before Step 3b's confirm gate, add:

```ts
    // ── Step 3a′: general-question is a conversation, not an HTTP skill ────
    // Its manifest pointed at POST /ask, an Express route that was never
    // ported, so in prod EVERY general question failed and was answered by the
    // engagement fallback with no history — "Give me more details" → "More
    // details about what?". The grounded advisor (conversation + ledger facts
    // + reviewer) is the right answerer; it is what the consultative triage
    // already uses.
    if (classification?.selectedSkill?.name === 'general-question') {
      let groundingFacts: string[] = [];
      if (ctx.buildGroundingFacts) {
        try { groundingFacts = await ctx.buildGroundingFacts(tenantId); } catch (e) { console.warn('[brain] grounding unavailable:', e); }
      }
      const answer = await brainAccountantFallback(
        ctx.callGemini, resolvedText, conversation, pastFilingContext,
        personalProfileContext, tenantConfig, tenantId, groundingFacts, 'consultation',
      );
      db.abConversation.create({
        data: { tenantId, question: text, answer, queryType: 'agent', channel, skillUsed: 'general-question', latencyMs: Date.now() - startTime },
      }).catch(() => {});
      await updateThreadTurns(activeThread, text, answer, 'general-question');
      return buildResponse({ message: answer, skillUsed: 'general-question', confidence: classification.confidence ?? 0.5, replyLocale, latencyMs: Date.now() - startTime });
    }
```
In `built-in-skills.ts` change `general-question`'s endpoint to `{ method: 'INTERNAL', url: '' }`.
In `server.ts` at the catch-all `accountantEngagement({ userText: text, … tenantId })` call (~5940) add `recentConvo: classification.conversation ?? [],`.
In the Telegram `callAgentBrain` ctx object add `buildGroundingFacts` (import `{ buildGroundingFacts } from '@/lib/agentbook-grounding'`, same as the web route).

- [ ] **Step 3: Run, typecheck, commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run && cd ../../../apps/web-next && npx tsc --noEmit -p .`
```bash
git add -A plugins/agentbook-core/backend/src apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts
git commit -m "fix(chat): general-question answered by the grounded advisor with thread history; Telegram gets grounding facts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: simulate-scenario runs the simulator that already exists

**Files:**
- Create: `plugins/agentbook-core/backend/src/scenario-simulation.ts` (extracted from `server.ts:2528-2674`, the Express `POST /api/v1/agentbook-core/simulate` body)
- Modify: `server.ts` — Express route calls the module; new INTERNAL inline handler in `_executeClassificationCore`
- Modify: `built-in-skills.ts:~184-187` (`simulate-scenario` → INTERNAL)
- Test: `plugins/agentbook-core/backend/src/__tests__/scenario-simulation.test.ts` (new)

**Interfaces:**
```ts
export interface ScenarioInput { type: 'add_expense'|'add_revenue'|'lose_client'|'hire'|'buy_equipment'|'custom'; params?: Record<string, any>; description?: string }
export interface FinancialBase { totalRevenueCents: number; monthlyBurnCents: number; cashBalanceCents: number; jurisdiction: string; region: string | null; currency: string; clients?: Array<{ name: string; monthlyRevenueCents?: number }> }
export function projectScenario(base: FinancialBase, scenario: ScenarioInput, calcTax: (netCents: number, jurisdiction: string, region: string | null, year: number) => number, year?: number): ScenarioResult   // pure; ScenarioResult is the existing `result` object shape (current / projected / impact / cashProjection12Months / scenario)
export async function interpretScenario(text: string, callGemini: CallGemini): Promise<ScenarioInput>
export function formatScenarioReply(r: ScenarioResult, narrative: string | null, money: (cents: number) => string, t: (k: string, p?: Record<string, string|number>) => string): string
```

- [ ] **Step 1: Failing test of the pure projection**

```ts
// plugins/agentbook-core/backend/src/__tests__/scenario-simulation.test.ts
import { describe, it, expect } from 'vitest';
import { projectScenario, formatScenarioReply } from '../scenario-simulation';

const base = { totalRevenueCents: 12_000_000, monthlyBurnCents: 400_000, cashBalanceCents: 2_000_000, jurisdiction: 'ca', region: 'BC', currency: 'CAD' };
const flatTax = (net: number) => Math.round(Math.max(0, net) * 0.25);

describe('projectScenario', () => {
  it('hire at $5K/mo lowers monthly net by $5K and shortens runway', () => {
    const r = projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, flatTax, 2026);
    expect(r.current.monthlyNetCents).toBe(600_000);
    expect(r.projected.monthlyNetCents).toBe(100_000);
    expect(r.impact.monthlyNetChangeCents).toBe(-500_000);
    expect(r.projected.runwayMonths).toBeLessThan(r.current.runwayMonths as number);
    expect(r.cashProjection12Months).toHaveLength(12);
    expect(r.impact.annualTaxChangeCents).toBeLessThan(0);
  });
  it('flags the month cash goes negative', () => {
    const r = projectScenario({ ...base, cashBalanceCents: 100_000 }, { type: 'add_expense', params: { monthlyCostCents: 800_000 } }, flatTax, 2026);
    expect(r.impact.cashDangerMonth).toBe(1);
  });
});

describe('formatScenarioReply', () => {
  it('always carries the numbers, even without a narrative', () => {
    const r = projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, flatTax, 2026);
    const s = formatScenarioReply(r, null, (c) => `$${(c / 100).toFixed(2)}`, (k, p) => `${k} ${JSON.stringify(p ?? {})}`);
    expect(s).toContain('skill.scenario_monthly_net');
    expect(s).toContain('"change":"$-5000.00"');
    expect(s).toContain('skill.scenario_runway');
  });
});
```
(Read `server.ts:2560-2600` for the exact per-type arithmetic before writing `projectScenario` — copy it verbatim into the pure function; the test values above assume `hire` adds `monthlyCostCents` to monthly expenses, which is what the Express code does.)

Run → FAIL (module missing).

- [ ] **Step 2: Extract + wire**

Create `scenario-simulation.ts` by moving the body of the Express handler: `interpretScenario` = the "If scenario is a string, try LLM interpretation" block; `projectScenario` = everything from `// Base state` through `const result = {…}` (parameterised on `base` and `calcTax`); the Express route becomes:
```ts
app.post('/api/v1/agentbook-core/simulate', async (req, res) => {
  try {
    const tenantId = (req as any).tenantId;
    const { scenario } = req.body;
    if (!scenario) return res.status(400).json({ success: false, error: 'scenario is required (object or text)' });
    const context = await buildFinancialContext(tenantId);
    const input = typeof scenario === 'string' ? await interpretScenario(scenario, callGemini) : scenario;
    const result = projectScenario(context, input, calcScenarioTax, new Date().getFullYear());
    const narrative = await scenarioNarrative(result, tenantId, callGemini, resolveAdvisorIdentity);
    res.json({ success: true, data: { ...result, narrative } });
  } catch (err) { /* unchanged */ }
});
```
Add the INTERNAL inline handler in `_executeClassificationCore` (next to daily-briefing):
```ts
  if (selectedSkill.name === 'simulate-scenario') {
    try {
      const scenarioText = String(extractedParams.scenario || text || '');
      const context = await buildFinancialContext(tenantId);
      const input = await interpretScenario(scenarioText, callGemini);
      const result = projectScenario(context, input, calcScenarioTax, new Date().getFullYear());
      const narrative = await scenarioNarrative(result, tenantId, callGemini, resolveAdvisorIdentity);
      const message = formatScenarioReply(result, narrative, (c) => tenantMoney(c, context.currency), t);
      await db.abConversation.create({ data: { tenantId, question: text, answer: message, queryType: 'agent', channel, skillUsed: 'simulate-scenario' } }).catch(() => {});
      return { selectedSkill, extractedParams, confidence, skillUsed: 'simulate-scenario', skillResponse: { success: true, data: result },
        responseData: { message, chartData: { type: 'line', data: result.cashProjection12Months.map((p: any) => ({ name: `M${p.month}`, value: p.cashCents })) }, skillUsed: 'simulate-scenario', confidence, replyLocale, latencyMs: Date.now() - startTime } };
    } catch (err) {
      console.error('[simulate-scenario] error:', err);
      return { selectedSkill, extractedParams, confidence: 0, skillUsed: 'simulate-scenario', skillResponse: null,
        responseData: { message: t('skill.scenario_failed'), skillUsed: 'simulate-scenario', confidence: 0, latencyMs: Date.now() - startTime } };
    }
  }
```
`formatScenarioReply` output (keys added to `skill.json` ×3 in this task): narrative (if any) + a blank line + `t('skill.scenario_monthly_net', { before, after, change })` + `t('skill.scenario_runway', { before, after })` + `t('skill.scenario_tax', { change })` + (if `cashDangerMonth`) `t('skill.scenario_cash_negative', { month })`.
en: `"scenario_monthly_net": "Monthly net: {before} → {after} ({change}/mo)"`, `"scenario_runway": "Runway: {before} → {after} months"`, `"scenario_tax": "Estimated annual tax change: {change}"`, `"scenario_cash_negative": "Cash would go negative in month {month}."`, `"scenario_failed": "I couldn't run that scenario. Try \"what if I hire someone at $5K/month?\""`. Provide fr-CA and zh-CN equivalents with identical placeholders.
Change the manifest endpoint for `simulate-scenario` to `{ method: 'INTERNAL', url: '' }`.

- [ ] **Step 3: Run everything, commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run && cd ../../../apps/web-next && npx tsc --noEmit -p . && npx vitest run src/__tests__/architecture/i18n-catalog.test.ts`
```bash
git add -A plugins/agentbook-core/backend/src packages/agentbook-i18n/src/locales
git commit -m "fix(chat): simulate-scenario runs the projection inline instead of a dead HTTP endpoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: Nightly spec asserts a real simulation answer; open PR C

**Files:**
- Modify: `tests/e2e/nightly/phase6-telegram-bot.spec.ts` — the `simulate-scenario` test

- [ ] **Step 1: Tighten the assertion**

```ts
  test('simulate-scenario answers with a projection, not a clarifying question', async () => {
    const r = await postUpdate('what if I hire someone at $5K/mo?');
    expect(r.status).toBe(200);
    // A projection carries money AND the runway/net lines; the dead-endpoint
    // fallback carried neither. (Do not assert "no trailing ?" — a narrative
    // may legitimately end with an offer.)
    expect(r.reply, 'no currency amount in the scenario reply').toMatch(/(?:CA|A|US)?\$\s?[\d,]+(?:\.\d{2})?|[\d\s]+,\d{2}\s?\$/);
    expect(r.reply, 'no projection lines (F6: /simulate endpoint was dead)').toMatch(/runway|monthly net|net mensuel|piste|跑道|每月净/i);
  });
```

- [ ] **Step 2: Commit + PR**

```bash
git add tests/e2e/nightly/phase6-telegram-bot.spec.ts
git commit -m "test(e2e): simulate-scenario must return a projection, not a question

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/chat-followup-context
gh pr create --title "fix(chat): follow-ups keep context; general-question + simulate-scenario no longer hit dead endpoints" --body "Fixes F6 of docs/superpowers/specs/2026-09-13-chat-quality-review.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## PR D — bare confirm/cancel with nothing pending; plans can run INTERNAL skills

### Task 10: "yes"/"cancel"/"undo" when nothing is pending

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts` — right after Step 2 context assembly (`const conversation = pairTurns(threadTurns);` ~1585), before Step 2b corrections
- Modify: `packages/agentbook-i18n/src/locales/{en,fr-CA,zh-CN}/agent.json`
- Test: `plugins/agentbook-core/backend/src/__tests__/agent-brain-no-session-action.test.ts` (new)

- [ ] **Step 1: Failing test**

```ts
// plugins/agentbook-core/backend/src/__tests__/agent-brain-no-session-action.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTestContext } from './helpers/test-context';

const threadState: { turns: any[] } = { turns: [] };
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abConvThread: {
      findFirst: vi.fn(async () => ({ id: 't', lastActiveAt: new Date(), activeEntities: [], parkedFills: [], turns: threadState.turns })),
      create: vi.fn(async (a: any) => ({ id: 't', turns: [], ...a.data })), update: vi.fn(async () => ({})),
    },
    abAgentSession: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => ({ ...a.data, id: 's', version: 1 })), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => ({ locale: 'en-US' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    abAdvisorPersona: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));
import { handleAgentMessage } from '../agent-brain';

describe('session actions with no active session', () => {
  it('a typed "cancel" (no adapter flag — web/MCP) with nothing pending says so and does not classify', async () => {
    threadState.turns = [];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel' });
    const res = await handleAgentMessage(req, ctx);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });
  it('"cancel" with the Telegram flag and nothing pending says so and does not classify', async () => {
    threadState.turns = [];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel', sessionAction: 'cancel' });
    const res = await handleAgentMessage(req, ctx);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });
  it('"yes" with nothing pending and no open question says so', async () => {
    threadState.turns = [{ role: 'bot', text: 'Recorded: $25.00 — Uber [Travel]', at: new Date().toISOString() }];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'yes', sessionAction: 'confirm' });
    const res = await handleAgentMessage(req, ctx);
    expect(res.data.skillUsed).toBe('session');
    expect(classifyOnly).not.toHaveBeenCalled();
  });
  it('"yes" that answers the bot\'s own question continues the conversation', async () => {
    threadState.turns = [{ role: 'bot', text: 'Is this a contractor or an employee?', at: new Date().toISOString() }];
    const gq = { name: 'general-question', endpoint: { method: 'INTERNAL', url: '' }, parameters: { question: 'string' } };
    const { req, ctx, classifyOnly } = buildTestContext({
      text: 'yes', sessionAction: 'confirm',
      classification: { selectedSkill: gq, extractedParams: { question: 'yes' }, confidence: 0.5 }, skills: [gq],
      llmFixtures: [{ response: 'Got it — as an employee at $5K/mo…' }],
    });
    const res = await handleAgentMessage(req, ctx);
    expect(classifyOnly).toHaveBeenCalled();
    expect(res.data.skillUsed).not.toBe('session');
  });
});
```

Run → FAIL (currently classifies "cancel").

- [ ] **Step 2: Implement**

After `const conversation = pairTurns(threadTurns);` add:

```ts
  // ── Step 2a: a session action with no session ─────────────────────────
  // The Telegram adapter maps bare "yes/cancel/undo/skip/status" to
  // sessionAction. With no AbAgentSession the old code classified the word as
  // a new request, and the fallback improvised ("Are you trying to cancel a
  // subscription, an invoice, or something else?"). Two cases:
  //   • the bot just asked a question → "yes" is the answer; keep going.
  //   • nothing is open → say so in one line.
  // Resolve from the flag OR the bare text (resolveSessionAction, as Step 1
  // does): only the Telegram adapter sets req.sessionAction, so keying on the
  // flag alone would leave a typed "cancel" on web/MCP/WhatsApp improvising.
  const bareAction = !activeSession ? resolveSessionAction(req.sessionAction, text) : null;
  if (bareAction) {
    const lastBot = [...threadTurns].reverse().find((tt: any) => tt?.role === 'bot');
    const botAskedSomething = /\?\s*$/.test(String(lastBot?.text ?? '').trim());
    const isAnswer = (bareAction === 'confirm' || bareAction === 'cancel') && botAskedSomething;
    if (!isAnswer) {
      const message = bareAction === 'confirm'
        ? t('agent.nothing_to_confirm')
        : bareAction === 'cancel'
          ? t('agent.nothing_to_cancel')
          : t('agent.nothing_pending');
      updateThreadTurns(activeThread, text, message, 'session').catch(() => {});
      return buildResponse({ message, skillUsed: 'session', confidence: 1, replyLocale, latencyMs: Date.now() - startTime });
    }
  }
```
(`activeSession` is the value from Step 1; if it is block-scoped there, hoist `const activeSession = await getActiveSession(tenantId);` so it is visible here — it already is a `const` at function scope in the current code.)

Catalog `agent.json` — en: `"nothing_to_confirm": "Nothing is waiting for your confirmation right now. Tell me what you'd like to do."`, `"nothing_to_cancel": "Nothing to cancel — there's no action in progress."`, `"nothing_pending": "There's no action in progress right now."`. fr-CA: `"nothing_to_confirm": "Rien n'attend votre confirmation pour le moment. Dites-moi ce que vous voulez faire."`, `"nothing_to_cancel": "Rien à annuler — aucune action n'est en cours."`, `"nothing_pending": "Aucune action n'est en cours pour le moment."`. zh-CN: `"nothing_to_confirm": "目前没有待确认的操作。请告诉我您想做什么。"`, `"nothing_to_cancel": "没有可取消的操作——当前没有进行中的操作。"`, `"nothing_pending": "目前没有进行中的操作。"`.

- [ ] **Step 3: Run, commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run && cd ../../../apps/web-next && npx vitest run src/__tests__/architecture/i18n-catalog.test.ts`
```bash
git add -A plugins/agentbook-core/backend/src packages/agentbook-i18n/src/locales
git commit -m "fix(chat): bare yes/cancel/undo with nothing pending get a plain answer, not an improvised question

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: Planner executes INTERNAL steps through the brain

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-planner.ts:370-410` (`executeStep` signature + INTERNAL branch)
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts:~1397` (the `executeStep(step, tenantId, ctx.skills, ctx.baseUrls)` call)
- Test: `plugins/agentbook-core/backend/src/__tests__/agent-planner-internal-step.test.ts` (new)

**Interfaces:**
- `executeStep(step, tenantId, skills, baseUrls, runInternal?: (skillName: string, params: Record<string, any>) => Promise<{ success: boolean; data?: any; message?: string; error?: string }>)`

- [ ] **Step 1: Failing test**

```ts
// plugins/agentbook-core/backend/src/__tests__/agent-planner-internal-step.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeStep } from '../agent-planner';

const step = { id: 's1', action: 'categorize-expenses', description: 'Categorize uncategorized expenses', params: {}, dependsOn: [], canUndo: false, status: 'pending' as const };
const skills = [{ name: 'categorize-expenses', endpoint: { method: 'INTERNAL', url: '' } }];

describe('executeStep with an INTERNAL skill', () => {
  it('delegates to runInternal and returns its result', async () => {
    const runInternal = vi.fn(async () => ({ success: true, data: { total: 3, applied: [1, 2, 3], pending: [], skipped: [] }, message: 'Categorized 3 of 3' }));
    const r = await executeStep(step as any, 't1', skills as any, {}, runInternal);
    expect(runInternal).toHaveBeenCalledWith('categorize-expenses', {});
    expect(r.success).toBe(true);
    expect(r.data?.total).toBe(3);
  });
  it('fails clearly when no runner was supplied', async () => {
    const r = await executeStep(step as any, 't1', skills as any, {});
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('internal');
  });
});
```
Run → FAIL (5th argument ignored / signature).

- [ ] **Step 2: Implement**

In `agent-planner.ts` extend the signature and replace the INTERNAL branch:
```ts
export async function executeStep(
  step: PlanStep,
  tenantId: string,
  skills: Array<{ name: string; endpoint?: string | { method?: string; url?: string }; method?: string }>,
  baseUrls: Record<string, string>,
  runInternal?: (skillName: string, params: Record<string, any>) => Promise<{ success: boolean; data?: any; message?: string; error?: string }>,
): Promise<{ success: boolean; data?: any; message?: string; error?: string }> {
  …
  if (endpoint.method === 'INTERNAL') {
    if (!runInternal) return { success: false, error: `Skill "${step.action}" is internal and no runner was supplied` };
    return runInternal(step.action, step.params ?? {});
  }
```
(Keep the existing endpoint normalisation above it; the manifest stores `endpoint: { method, url }`.)

In `agent-brain.ts` at the plan-step loop (~1397, inside the Step 1 confirm path — `text`/`channel` are in scope, `conversation`/`tenantConfig` are NOT yet), pass a runner built from the ctx. Use the session's original request (`activeSession.trigger`, e.g. "Categorize them") as the text, not the bare "yes": the executor derives the reply locale from it.
```ts
          : await executeStep(step, tenantId, ctx.skills, ctx.baseUrls, async (skillName, params) => {
              if (!ctx.executeClassification) return { success: false, error: 'no executor' };
              const sk = (ctx.skills as any[]).find((s) => s.name === skillName);
              if (!sk) return { success: false, error: `unknown skill ${skillName}` };
              const r = await ctx.executeClassification(
                { selectedSkill: sk, extractedParams: params, confidence: 1, confirmBefore: false, memory: [], skills: ctx.skills, conversation: [], tenantConfig: undefined },
                String(activeSession.trigger || text), tenantId, channel, [],
              );
              return { success: Boolean(r?.responseData || r?.skillResponse?.success), data: r?.skillResponse?.data, message: r?.responseData?.message };
            });
```
(`executeClassification` → `_executeClassificationCore` re-fetches tenant config when `tenantConfig === undefined`; confirm by reading `server.ts:3334-3370` before relying on it — if it does not, load `db.abTenantConfig.findFirst({ where: { userId: tenantId } })` in the runner and pass it.)

- [ ] **Step 3: Run, commit, PR D**

Run: `cd plugins/agentbook-core/backend && npx vitest run && cd ../../../apps/web-next && npx tsc --noEmit -p .`
```bash
git add -A plugins/agentbook-core/backend/src
git commit -m "fix(planner): INTERNAL skills run through the brain's executor instead of failing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/chat-session-semantics
gh pr create --title "fix(chat): bare confirm/cancel with nothing pending; planner can run INTERNAL skills" --body "Fixes F7, F8 of docs/superpowers/specs/2026-09-13-chat-quality-review.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## PR E — Telegram renders cleanly; the briefing stops narrating failures

### Task 12: `mdToTelegramHtml` + `shouldAppendBreakdown`

**Files:**
- Create: `apps/web-next/src/lib/agentbook-telegram-markdown.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts:1143-1165` (`mdToHtml`, `formatResponse`)
- Test: `apps/web-next/src/lib/__tests__/agentbook-telegram-markdown.test.ts`

- [ ] **Step 1: Failing test (uses the exact prod reply)**

```ts
// apps/web-next/src/lib/__tests__/agentbook-telegram-markdown.test.ts
import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, shouldAppendBreakdown } from '../agentbook-telegram-markdown';

const PROD = `From January 1, 2026, to September 13, 2026, your total expenses are **42 014,79 CA$** across 173 transactions.

Your top spending categories are:
*   **Uncategorized**: 15 541,71 CA$
*   **Software & Subscriptions**: 12 997,88 CA$
- Travel: 8 953,95 CA$

### Vendors
_Period: year to date (Jan 1 – Sep 13, 2026)._`;

describe('mdToTelegramHtml', () => {
  const html = mdToTelegramHtml(PROD);
  it('bold and escaping', () => { expect(html).toContain('<b>42 014,79 CA$</b>'); expect(html).toContain('Software &amp; Subscriptions'); });
  it('list bullets become •, never a literal asterisk or dash', () => {
    expect(html).toContain('• <b>Uncategorized</b>: 15 541,71 CA$');
    expect(html).toContain('• Travel: 8 953,95 CA$');
    expect(html).not.toMatch(/^\*\s{2,}/m);
  });
  it('_italic_ and ### headings', () => {
    expect(html).toContain('<i>Period: year to date (Jan 1 – Sep 13, 2026).</i>');
    expect(html).toContain('<b>Vendors</b>');
    expect(html).not.toContain('###');
  });
  it('does not italicise snake_case identifiers', () => {
    expect(mdToTelegramHtml('key telegram_pending_x set')).toBe('key telegram_pending_x set');
  });
  it('inline code', () => { expect(mdToTelegramHtml('run `review`')).toBe('run <code>review</code>'); });
});

describe('shouldAppendBreakdown', () => {
  const chart = { type: 'pie', data: [{ name: 'Uncategorized', value: 1554171 }, { name: 'Software & Subscriptions', value: 1299788 }, { name: 'Travel', value: 895395 }, { name: 'Insurance', value: 250000 }] };
  it('skips when the answer already names most of the series', () => { expect(shouldAppendBreakdown(PROD, chart)).toBe(false); });
  it('appends when the answer is a bare total', () => { expect(shouldAppendBreakdown('You spent $42,014.79 this year.', chart)).toBe(true); });
  it('never appends without data', () => { expect(shouldAppendBreakdown('x', null)).toBe(false); expect(shouldAppendBreakdown('x', { data: [] })).toBe(false); });
});
```
Run: `cd apps/web-next && npx vitest run src/lib/__tests__/agentbook-telegram-markdown.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// apps/web-next/src/lib/agentbook-telegram-markdown.ts
/**
 * Markdown (as the LLM writes it) → Telegram HTML.
 *
 * Telegram renders HTML, not markdown. The old converter handled **bold**,
 * *italic* and `code` only, so list bullets ("*   item"), _italic_ and
 * "### Heading" reached users as literal characters — the prod reply of
 * 2026-09-13 showed three `*   ` bullets and an `_Period: …_` line verbatim.
 */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mdToTelegramHtml(md: string): string {
  let html = escHtml(md ?? '');
  // Headings → bold line.
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // List bullets at line start: "* ", "*   ", "- ", "• " → "• ".
  html = html.replace(/^\s*(?:[*\-•])\s+(?=\S)/gm, '• ');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // *italic* only when not part of a remaining bullet.
  html = html.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  // _italic_ only when the underscores are word-bounded (not snake_case).
  html = html.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s.,;:!?)]|$)/gm, '$1<i>$2</i>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  return html;
}

/**
 * Whether the "📊 Breakdown" block adds information. The query-expenses
 * answer usually already enumerates the top categories; repeating them as a
 * second list is noise on a phone.
 */
export function shouldAppendBreakdown(message: string, chartData: { data?: Array<{ name?: string }> } | null | undefined): boolean {
  const rows = chartData?.data?.filter((d) => d && typeof d.name === 'string') ?? [];
  if (rows.length === 0) return false;
  const lower = (message ?? '').toLowerCase();
  const seen = rows.slice(0, 8).filter((d) => lower.includes(String(d.name).toLowerCase())).length;
  return seen * 2 < Math.min(rows.length, 8);
}
```
In the route: `import { mdToTelegramHtml, shouldAppendBreakdown } from '@/lib/agentbook-telegram-markdown';` — delete the local `mdToHtml` and rewrite `formatResponse`:
```ts
function formatResponse(data: any): string {
  let reply = mdToTelegramHtml(data.message || 'Done.');
  if (shouldAppendBreakdown(data.message || '', data.chartData)) {
    reply += '\n\n📊 <b>Breakdown:</b>';
    for (const item of data.chartData.data.slice(0, 8)) {
      const val = typeof item.value === 'number' && item.value > 100 ? fmtAmount(item.value) : item.value;
      reply += `\n• ${escHtml(String(item.name))}: ${val}`;
    }
  }
  return reply;
}
```
(If the route already has its own `escHtml`, keep using it; do not export a second one from the route.)

- [ ] **Step 3: Run, commit**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/agentbook-telegram-markdown.test.ts src/app/api/v1/agentbook/telegram && npx tsc --noEmit -p .`
```bash
git add apps/web-next/src/lib/agentbook-telegram-markdown.ts apps/web-next/src/lib/__tests__/agentbook-telegram-markdown.test.ts apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts
git commit -m "fix(telegram): render list bullets, _italic_ and headings; skip the redundant breakdown

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Briefing uses real data and omits what it doesn't have

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts:5759-5835` (daily-briefing handler)
- Test: extend `plugins/agentbook-core/backend/src/__tests__/daily-briefing-tax-deadline.test.ts` (read it first — it already drives this handler with mocked fetch)

- [ ] **Step 1: Failing test additions**

First read `daily-briefing-tax-deadline.test.ts` end to end. Its `vi.mock('../db/client.js')` currently provides only `abConversation`, `abLLMProviderConfig`, `abSkillRun`; `buildFinancialContext` (server.ts:1101+) reads `abTenantConfig`, `abAccount`, `abJournalLine`, `abExpense`, `abClient`, `abInvoice` (list the exact models by reading that function). Extend the mock with each of them returning empty/zero data — and make `abExpense.findMany` honour its `where` (filter the fixture array by `tenantId`/`deletedAt`), per repo rule "a DB mock must apply the where clause". Then add:
```ts
  it('reads the snapshot from the ledger directly (the /financial-snapshot self-call has no Next route)', () => {
    const src = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const block = src.slice(src.indexOf("if (selectedSkill.name === 'daily-briefing') {"), src.indexOf('Daily-briefing error'));
    expect(block).not.toContain('/api/v1/agentbook-core/financial-snapshot');
    expect(block).toContain('buildFinancialContext(tenantId)');
  });
  it('never puts the word "unavailable" in front of the model, and tells it not to mention gaps', async () => {
    // Same arrangement as the sibling "no upcoming deadline" test in this file,
    // plus: fetch for /advisor/proactive-alerts rejects, /tax/quarterly returns
    // { success: true, data: { payments: [] } }.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('proactive-alerts')) throw new Error('boom');
      return { ok: true, json: async () => ({ success: true, data: { payments: [] } }) } as any;
    }) as any;
    const { callGemini, calls } = buildMockGemini([{ systemMatch: 'morning briefing', response: 'Good morning.' }]);
    await runDailyBriefing(callGemini);   // whatever helper the sibling tests use to invoke the handler — reuse it verbatim
    const prompts = calls.history.map((h) => h.system + '\n' + h.user).join('\n');
    expect(prompts).not.toMatch(/unavailable/i);
    expect(prompts).toMatch(/Do not mention missing/);
    expect(prompts).not.toContain('Alerts:');            // the failed section is omitted, not narrated
  });
```
Run → FAIL.

- [ ] **Step 2: Implement**

Replace the snapshot fetch with the direct call and build the prompt only from what loaded:
```ts
      const [snapSettled, alertsSettled, quarterlySettled] = await Promise.allSettled([
        buildFinancialContext(tenantId),
        fetch(`${expenseBase}/api/v1/agentbook-expense/advisor/proactive-alerts`, { headers: H }).then((r) => r.json()),
        fetch(`${taxBase}/api/v1/agentbook-tax/tax/quarterly`, { headers: H }).then((r) => r.json()),
      ]);
      const snap = snapSettled.status === 'fulfilled' ? snapSettled.value : null;
      const alertData = alertsSettled.status === 'fulfilled' ? alertsSettled.value : null;
      const quarterlyData = quarterlySettled.status === 'fulfilled' ? quarterlySettled.value : null;
      /* nextDeadline computation unchanged */
      const briefingSystem = [
        (await resolveAdvisorIdentity(tenantId)) + ' You are giving a morning briefing.',
        'Summarize in 3–5 short sentences. Be specific with dollar amounts.',
        'End with exactly one concrete action item the user can take today.',
        'Do not mention missing, unavailable or unloaded data — say only what the facts below support.',
        'Plain text only — no markdown, no bullet points.',
      ].join('\n');
      const sections: string[] = [];
      // money-format-ok: prompt input, machine-stable on purpose.
      if (snap) sections.push(`Financial snapshot: ${JSON.stringify({ cashBalanceCents: snap.cashBalanceCents, totalRevenueCents: snap.totalRevenueCents, totalExpenseCents: snap.totalExpenseCents, monthlyBurnCents: snap.monthlyBurnCents, currency: snap.currency })}`);
      if (alertData?.success) sections.push(`Alerts: ${JSON.stringify(alertData.data)}`);
      if (nextDeadline) sections.push(`Next quarterly tax deadline: $${(nextDeadline.amountDueCents / 100).toFixed(2)} due ${nextDeadline.deadline.toISOString().slice(0, 10)}.`);
      const briefingUser = sections.length ? sections.join('\n') : 'No new facts today.';
```
(Check `buildFinancialContext`'s returned field names at `server.ts:1101` and use the ones that exist.)

- [ ] **Step 3: Run, commit, PR E**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/daily-briefing-tax-deadline.test.ts
git commit -m "fix(briefing): read the snapshot directly and never narrate missing data

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/telegram-rendering-briefing
gh pr create --title "fix(telegram): clean markdown rendering, no duplicate breakdown; briefing stops saying 'unavailable'" --body "Fixes F9, F10 of docs/superpowers/specs/2026-09-13-chat-quality-review.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

### Task 14: (folded into Task 12/13 — no separate deliverable)

---

## PR F — the nightly bot stops writing into a real user's books; prod chat-quality check

### Task 15: Capture chat resolves to the e2e tenant

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts:126-156` (`resolveTenantId`)
- Test: `apps/web-next/src/__tests__/architecture/telegram-e2e-tenant.test.ts` (new, source-reading — the function is module-private and talks to Prisma)

- [ ] **Step 1: Failing test**

```ts
// apps/web-next/src/__tests__/architecture/telegram-e2e-tenant.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const ROUTE = readFileSync(join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'), 'utf8');
const fn = ROUTE.slice(ROUTE.indexOf('async function resolveTenantId('), ROUTE.indexOf('\n}\n', ROUTE.indexOf('async function resolveTenantId(')) + 3);

describe('resolveTenantId', () => {
  it('maps the e2e capture chat to its own tenant BEFORE the bot-token lookup', () => {
    const capture = fn.indexOf('isE2eCaptureChat(chatId)');
    const lookup = fn.indexOf('abTelegramBot.findFirst');
    expect(capture).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(capture);
    expect(fn).toMatch(/isE2eCaptureChat\(chatId\)[\s\S]{0,200}CHAT_TO_TENANT_FALLBACK\[chatStr\]/);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement**

At the top of `resolveTenantId`, after `const chatStr = String(chatId);`:
```ts
  // The nightly e2e drives the bot through one synthetic chat id. The
  // bot-token lookup below binds ANY chat to that bot's tenant, so the e2e
  // chat was landing on a real user's books every night (Maya's, in prod:
  // "Spent $25 at Uber…" ×3 and an Acme invoice attempt per run). Resolve the
  // capture chat to its own tenant first.
  if (isE2eCaptureChat(chatId) && CHAT_TO_TENANT_FALLBACK[chatStr]) return CHAT_TO_TENANT_FALLBACK[chatStr];
```
(`isE2eCaptureChat` already exists at ~line 118 — use that exact name.) Verify the e2e tenant id in `CHAT_TO_TENANT_FALLBACK['555555555']` exists in prod (`e2e@agentbook.test`) before merging: `curl` the prod login with the CI e2e password from the nightly workflow is NOT available locally — instead confirm via the nightly workflow's last run log that `reset-e2e-user` targets that id.

- [ ] **Step 3: Run, commit**

```bash
cd apps/web-next && npx vitest run src/__tests__/architecture/telegram-e2e-tenant.test.ts && npx tsc --noEmit -p .
git add apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts apps/web-next/src/__tests__/architecture/telegram-e2e-tenant.test.ts
git commit -m "fix(telegram): the e2e capture chat resolves to the e2e tenant, not the bot owner's books

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 16: Prod chat-quality scenario spec

**Files:**
- Create: `tests/e2e/nightly/phase6b-chat-quality.spec.ts`

- [ ] **Step 1: Write the spec (runs against the deployed capture chat, like phase6)**

```ts
import { test, expect } from '@playwright/test';
import { postUpdate } from './helpers/telegram';

/**
 * The 2026-09-13 prod transcript, replayed. Each assertion names the reply
 * that was wrong that day (docs/superpowers/specs/2026-09-13-chat-quality-review.md).
 */
test.describe('@phase6b-chat-quality', () => {
  test.beforeAll(async () => {
    const probe = await postUpdate('ping');
    test.skip(probe.data?.error === 'Bot not configured' || probe.status === 503, 'bot not configured');
    if (probe.data?.botReply === undefined) throw new Error('E2E_TELEGRAM_CAPTURE is not active on the deployment');
  });

  test('"Expenses" renders without raw markdown and does not list the categories twice', async () => {
    const r = await postUpdate('Expenses');
    expect(r.reply).not.toMatch(/^\*\s{2,}/m);           // F9: literal "*   " bullets
    expect(r.reply).not.toMatch(/(^|\s)_Period:/);        // F9: literal underscores
    expect(r.reply).toMatch(/Period:|Période|期间/i);
    const enumeratesCategories = /categor/i.test(r.reply) && /•/.test(r.reply);
    const hasBreakdownBlock = /Breakdown/.test(r.reply);
    expect(enumeratesCategories && hasBreakdownBlock, 'the answer listed categories AND a Breakdown block repeated them (F9)').toBe(false);
  });

  test('"Categorize them" answers in English with counts that add up', async () => {
    const r = await postUpdate('Categorize them');
    let reply = r.reply;
    if (/proceed|yes\/no/i.test(reply)) { const c = await postUpdate('yes'); reply = c.reply; }
    expect(reply, 'French template on an English question (F5)').not.toMatch(/catégori/i);
    // Either nothing to do, or "Categorized N of M" — never "all categorized" alongside an unplaced list.
    const m = reply.match(/Categorized (\d+) of (\d+)/i);
    if (m) {
      const [applied, total] = [Number(m[1]), Number(m[2])];
      expect(applied).toBeLessThanOrEqual(total);
      if (applied < total) expect(reply, 'claimed completeness with items left (F1)').not.toMatch(/nothing left to categorize/i);
    } else {
      expect(reply).toMatch(/nothing left|already categorized|filed/i);
    }
  });

  test('"Give me more details" continues the previous turn', async () => {
    await postUpdate('What is my cash balance?');
    const r = await postUpdate('Give me more details');
    expect(r.reply, 'lost the thread (F6)').not.toMatch(/more details about what/i);
    expect(r.reply).toMatch(/cash|balance|receivable|\$/i);
  });

  test('"cancel" with nothing pending is answered plainly', async () => {
    const r = await postUpdate('cancel');
    expect(r.reply, 'improvised a question (F7)').not.toMatch(/subscription|invoice, or something else/i);
    expect(r.reply).toMatch(/nothing/i);
  });

  test('what-if returns a projection', async () => {
    const r = await postUpdate('what if I hire someone at $5K/mo?');
    expect(r.reply).toMatch(/(?:CA|A|US)?\$\s?[\d,]+|[\d\s]+,\d{2}\s?\$/);
    expect(r.reply).toMatch(/runway|monthly net|net mensuel|piste|跑道|每月净/i);
  });
});
```

- [ ] **Step 2: Commit, PR F**

```bash
git add tests/e2e/nightly/phase6b-chat-quality.spec.ts
git commit -m "test(e2e): replay the 2026-09-13 Telegram transcript as a prod chat-quality gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/e2e-tenant-isolation
gh pr create --title "fix(telegram): e2e capture chat gets its own tenant; add prod chat-quality replay spec" --body "Fixes F11 of docs/superpowers/specs/2026-09-13-chat-quality-review.md and adds the transcript replay used to verify PRs A–E in prod.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Prod verification (after all six PRs are merged and auto-deployed)

1. `gh run list --workflow=ci.yml --branch=main --limit=3` — the merge commits are green; `vercel ls a3p-plugin-build --prod` (or the Vercel dashboard) shows the deployment for the last merge as READY.
2. `cd tests/e2e && E2E_BASE_URL=https://agentbook.brainliber.com npx playwright test nightly/phase6b-chat-quality.spec.ts nightly/phase6-telegram-bot.spec.ts --config=playwright.config.ts --reporter=line`.
3. Read Maya's conversation log again (`GET /api/v1/agentbook-core/conversations?limit=20` with her session) after sending, from the real Telegram chat, the three turns from the review — "Expenses", "Categorize them", "Give me more details" — and confirm: English throughout, no literal `*`/`_`, categorize reply lists items and counts add up to the DB's uncategorized count (`categoryId IS NULL OR categoryId = <6999 id>`), follow-up references the previous answer.
4. Confirm no new nightly rows appear on `maya-consultant` after the next scheduled run (query `channel='telegram'` rows with `question='Spent $25 at Uber for client meeting'` dated after the merge).

## Self-review against the spec

- F1 F2 F3 F4 F13 → Tasks 1–3 (F2 covers BOTH the categorize handler and the query-expenses filter). F5 → 4–6 (text path + Proceed-button path). F6 → 7–9. F7 F8 → 10–11 (F7 keyed on `resolveSessionAction`, so web/MCP typed "cancel" is covered too). F9 F10 → 12–13. F11 → 15–16. The transcript's "Proceed?" round-trip on "Categorize them" → Task 2 (escalation exemption). F12 deferred (stated). Security pairing flagged, out of scope (stated).
- Independent review (2026-09-13, fresh-context reviewer) found and this revision fixed: conversation order is NEWEST-first (Task 5), pending items need `date` (Task 1/2), drafts must not be booked via the categorize route (Task 2), ordinal ids + salvage for the batch prompt (Task 1), `isE2eCaptureChat` name (Task 15), briefing test mock coverage (Task 13), orphaned catalog keys + a test asserting a deleted key (Task 3), `activeSession.trigger` as the executor text (Task 11), no "ends with ?" assertions in e2e (Tasks 9, 16).
- Names used across tasks: `CategorizeOutcome`, `formatCategorizeReply`, `decide`, `parseBatchDecisions`, `buildBatchPrompt`, `hasSignal`, `BATCH_SIZE` (Task 1 → 2); `resolveReplyLocale`, `replyLocale` on `responseData`/`AgentResponse.data` (Task 4 → 5 → 6); `runInternal` (Task 11); `mdToTelegramHtml`, `shouldAppendBreakdown` (Task 12); `isCaptureChat`, `CHAT_TO_TENANT_FALLBACK` (Task 15, existing).
