import { describe, it, expect } from 'vitest';
import {
  hasSignal, buildBatchPrompt, parseBatchDecisions, decide, formatCategorizeReply, mapWithConcurrency,
  type CategorizeCandidate, type CategoryOption, type CategorizeOutcome,
} from '../categorize-expenses';

const cat = (id: string, name: string): CategoryOption => ({ id, name });
const CATS = [cat('c-rent', 'Rent'), cat('c-meals', 'Meals'), cat('c-tel', 'Telephone & Internet')];
const cand = (id: string, vendorName: string | null, description: string | null, amountCents = 4500): CategorizeCandidate =>
  ({ id, vendorName, description, amountCents, currency: 'CAD', date: new Date('2026-01-01T12:00:00Z'), journalEntryId: 'je-1' });
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
  it('salvages a truncation whose cut-off reason text contains a brace', () => {
    // The old `lastIndexOf('}')` salvage found the `}` INSIDE the unterminated
    // reason string, reconstructed malformed JSON and dropped the WHOLE batch.
    const raw = '[{"n":1,"categoryName":"Rent","confidence":0.93,"reason":"co-working"},{"n":2,"categoryName":"Meals","confidence":0.9,"reason":"lunch } at the ca';
    const out = parseBatchDecisions(raw, cands);
    expect(out.map((d) => d.id)).toEqual(['e1']);
  });
  it('keeps a complete object whose reason contains ] or }', () => {
    const raw = '[{"n":1,"categoryName":"Rent","confidence":0.93,"reason":"co-working } ] \\" ok"},{"n":2,"categoryName":"Meals","confidence":0.9,"reason":"lunch"}]';
    const out = parseBatchDecisions(raw, cands);
    expect(out.map((d) => d.id)).toEqual(['e1', 'e2']);
  });
  it('a nested object inside a COMPLETE element does not shift the depth bookkeeping', () => {
    // The scan records the `}` that returns depth to 1. A nested object closes
    // at depth 2, and a `}` inside its string value is not a brace at all — a
    // scanner that counted either would salvage at the wrong index and lose
    // the complete first element along with the truncated second.
    const raw = '[{"n":1,"categoryName":"Rent","confidence":0.9,"reason":"x","meta":{"k":"}"}},{"n":2,"cat';
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
  it("names a failed write as its own reason, not as the model's fault", () => {
    // The row WAS classified confidently; the ledger write refused. Telling the
    // user the AI was unsure sends them to rephrase a request that only needs
    // a retry.
    const s = formatCategorizeReply(
      { total: 1, applied: [], pending: [], skipped: [{ ...skipped, reason: 'write_failed' as const }] }, f,
    );
    expect(s).toContain('skill.categorize_reason_write_failed');
    expect(s).not.toContain('skill.categorize_reason_llm_error');
  });
  it('does NOT claim all done when rows beyond the page cap are still uncategorized', () => {
    // 80 uncategorized, one page of 50 applied. The old reply said "all done".
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...applied, expenseId: `a${i}` }));
    const s = formatCategorizeReply({ total: 80, applied: fifty, pending: [], skipped: [] }, f);
    expect(s).not.toContain('skill.categorize_done_all');
    expect(s).toContain('skill.categorize_more_remaining {"count":30}');
  });
  it('DOES say all done when the count and the page agree', () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ ...applied, expenseId: `a${i}` }));
    const s = formatCategorizeReply({ total: 3, applied: three, pending: [], skipped: [] }, f);
    expect(s).toContain('skill.categorize_done_all');
    expect(s).not.toContain('skill.categorize_more_remaining');
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

describe('mapWithConcurrency', () => {
  /** 50 rows × one HTTP self-call each, sequentially, against a 90 s route budget. */
  it('never exceeds the limit and still runs everything', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 17 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, (n % 3) * 2));
      seen.push(n);
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it IS running in parallel, not a sequential loop wearing a helper's name
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('returns results in INPUT order even when later items finish first', async () => {
    // The reply lists the applied rows; completion order would make the
    // message the user reads nondeterministic.
    const out = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 20, 10, 0]);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });
});
