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
 * output cap hit mid-object): everything up to the last `}` that CLOSES a
 * top-level element is kept, so one long reason costs one row, not the whole
 * batch. The scan tracks string state — a `}` inside a truncated `reason` is
 * not a closing brace, and treating it as one dropped every row.
 */
function lastCompleteElementEnd(body: string): number {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      // depth 1 == inside the outer array, so this `}` closed a whole element.
      if (ch === '}' && depth === 1) last = i;
    }
  }
  return last;
}

export function parseBatchDecisions(raw: string | null, cands: CategorizeCandidate[]): BatchDecision[] {
  if (!raw) return [];
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start < 0) return [];
  const body = cleaned.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const lastObj = lastCompleteElementEnd(body);
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
