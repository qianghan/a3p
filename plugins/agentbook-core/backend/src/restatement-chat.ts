/**
 * PR 2c — chat parity for the opt-in tax restatement (spec §5.1).
 *
 * The brain cannot import apps/web-next, so both skills call the production
 * Next route (/api/v1/agentbook-tax/restatement) the Settings card uses:
 * preview = GET, apply = POST. `restatement-apply` is confirmBefore, so the
 * brain shows a plan and waits for "yes" before this runs.
 *
 * The tax year is resolved ONCE, here, with the shared definition
 * (@agentbook/jurisdictions/restatement-year), and always sent explicitly —
 * so the year in the confirmation, the year applied and the route's own
 * default can never disagree (review I-1 / M-3).
 */
import { taxYearFromText, currentTaxYear, taxYearBounds } from '@agentbook/jurisdictions/restatement-year';

export type RestatementMode = 'preview' | 'apply';

/** Batches one chat apply follows (each is ≤100 rows on the server). */
export const MAX_CHAT_APPLY_CALLS = 5;
/** Stop starting new batches once this much of the turn has elapsed (R2-1). */
export const CHAT_APPLY_BUDGET_MS = 25_000; // 25 s, not 35: a batch can overrun its 40 s budget by classify + one row + network (review R3-1)
/** The agent/message function limit, and the route's own per-call budget (lib/tax-restatement.ts). */
export const CHAT_TURN_MAX_MS = 90_000;
export const ROUTE_BATCH_MAX_MS = 40_000;

export interface RestatementTenant {
  jurisdiction?: string | null;
  timezone?: string | null;
}

/** The tax year a message means: the one it names (AU "2025–2026" / "FY2025-26" = 2026), else today's in the tenant zone. */
export function restatementChatYear(text: string, tenant: RestatementTenant | null | undefined, now = new Date()): { year: number; from: string; to: string } {
  const j = tenant?.jurisdiction || 'us';
  const year = taxYearFromText(text, j) ?? currentTaxYear(j, now, tenant?.timezone ?? null);
  const b = taxYearBounds(j, year);
  return { year, from: b.fromIso, to: b.toIso };
}

interface PreviewData {
  year: number; from: string; to: string; applicable: boolean;
  counts: { eligible: number; skippedClosed: number };
  recoverableTaxCents: number; netProfitDeltaCents: number;
  restated?: unknown[]; failed?: unknown[]; remaining?: number; cursor?: string;
}

export async function runRestatementSkill(opts: {
  mode: RestatementMode;
  text: string;
  tenant: RestatementTenant | null | undefined;
  baseUrl: string;
  headers: Record<string, string>;
  t: (key: string, vars?: Record<string, unknown>) => string;
  money: (cents: number) => string;
  fetchImpl?: typeof fetch;
  /** Clock and the turn's start (ms), for the batch budget. */
  now?: () => number;
  startedAt?: number;
}): Promise<{ message: string; data: PreviewData | null }> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  // Start another batch only while it can still finish inside the turn.
  const canStartBatch = () => {
    const elapsed = now() - startedAt;
    return elapsed < CHAT_APPLY_BUDGET_MS && elapsed + ROUTE_BATCH_MAX_MS <= CHAT_TURN_MAX_MS;
  };
  const { year } = restatementChatYear(opts.text, opts.tenant);
  const url = `${opts.baseUrl}/api/v1/agentbook-tax/restatement`;
  type Body = { success?: boolean; data?: PreviewData; error?: { code?: string } } | null;
  let res = opts.mode === 'apply'
    ? await f(url, { method: 'POST', headers: { ...opts.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ year }) })
    : await f(`${url}?year=${year}`, { headers: opts.headers });
  let body = (await res.json().catch(() => null)) as Body;
  // Apply: follow the cursor for a few bounded batches (N-2), summing what was committed.
  if (opts.mode === 'apply' && res.ok && body?.success && body.data) {
    const acc = body.data;
    acc.restated = [...(acc.restated ?? [])];
    acc.failed = [...(acc.failed ?? [])];
    for (let i = 1; i < MAX_CHAT_APPLY_CALLS && (acc.remaining ?? 0) > 0 && acc.cursor && canStartBatch(); i++) {
      res = await f(url, { method: 'POST', headers: { ...opts.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ year, cursor: acc.cursor }) });
      const next = (await res.json().catch(() => null)) as Body;
      if (!res.ok || !next?.success || !next.data) break; // report what is already committed
      acc.restated.push(...(next.data.restated ?? []));
      acc.failed.push(...(next.data.failed ?? []));
      acc.recoverableTaxCents += next.data.recoverableTaxCents;
      acc.remaining = next.data.remaining;
      acc.cursor = next.data.cursor;
      acc.counts = next.data.counts;
    }
    res = { ok: true, status: 200 } as Response;
    body = { success: true, data: acc };
  }

  if (res.status === 422 && (body?.error?.code === 'not_registered' || body?.error?.code === 'unsupported_jurisdiction')) {
    return { message: opts.t('skill.restatement_not_applicable'), data: body?.data ?? null };
  }
  if (!res.ok || !body?.success || !body.data) throw new Error(`restatement ${opts.mode} failed: ${res.status}`);
  const d = body.data;
  if (!d.applicable) return { message: opts.t('skill.restatement_not_applicable'), data: d };

  const closed = d.counts.skippedClosed > 0 ? ` ${opts.t('skill.restatement_skipped_closed', { count: d.counts.skippedClosed })}` : '';
  if (opts.mode === 'apply') {
    // Report exactly what this call committed (review I-2), then what is left.
    const n = Array.isArray(d.restated) ? d.restated.length : 0;
    const failed = Array.isArray(d.failed) ? d.failed.length : 0;
    const remaining = d.remaining ?? 0;
    const tail =
      closed +
      (failed > 0 ? ` ${opts.t('skill.restatement_failed', { count: failed })}` : '') +
      (remaining > 0 ? ` ${opts.t('skill.restatement_remaining', { count: remaining, year: d.year })}` : '');
    if (n === 0) return { message: ((failed > 0 || remaining > 0 ? '' : opts.t('skill.restatement_nothing', { year: d.year, from: d.from, to: d.to })) + tail).trim(), data: d };
    return { message: opts.t('skill.restatement_done', { count: n, year: d.year, amount: opts.money(d.recoverableTaxCents) }) + tail, data: d };
  }
  if (d.counts.eligible === 0) return { message: opts.t('skill.restatement_nothing', { year: d.year, from: d.from, to: d.to }) + closed, data: d };
  return {
    message: opts.t('skill.restatement_preview', { year: d.year, from: d.from, to: d.to, count: d.counts.eligible, amount: opts.money(d.recoverableTaxCents) }) + closed,
    data: d,
  };
}
