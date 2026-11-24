/**
 * PR 2c — chat parity for the opt-in tax restatement (spec §5.1).
 *
 * The brain cannot import apps/web-next, so both skills call the production
 * Next route (/api/v1/agentbook-tax/restatement) the Settings card uses:
 * preview = GET, apply = POST. `restatement-apply` is confirmBefore, so the
 * brain shows a plan and waits for "yes" before this runs.
 */
export type RestatementMode = 'preview' | 'apply';

/** An explicit 20xx in the text, else null (the route then uses the current tax year). */
export function restatementYearFromText(text: string): number | null {
  const m = /\b(20\d{2})\b/.exec(text || '');
  return m ? Number(m[1]) : null;
}

/** The tax year a confirmation should name: the asked year, else the current one (AU: 1 Jul – 30 Jun, by its ending year). */
export function restatementDisplayYear(text: string, jurisdiction: string | null | undefined, now = new Date()): number {
  const asked = restatementYearFromText(text);
  if (asked) return asked;
  return (jurisdiction || '').toLowerCase() === 'au' && now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

interface PreviewData {
  year: number; from: string; to: string; applicable: boolean;
  counts: { eligible: number; skippedClosed: number };
  recoverableTaxCents: number; netProfitDeltaCents: number;
  restated?: unknown[];
}

export async function runRestatementSkill(opts: {
  mode: RestatementMode;
  text: string;
  baseUrl: string;
  headers: Record<string, string>;
  t: (key: string, vars?: Record<string, unknown>) => string;
  money: (cents: number) => string;
  fetchImpl?: typeof fetch;
}): Promise<{ message: string; data: PreviewData | null }> {
  const f = opts.fetchImpl ?? fetch;
  const year = restatementYearFromText(opts.text);
  const url = `${opts.baseUrl}/api/v1/agentbook-tax/restatement`;
  const res = opts.mode === 'apply'
    ? await f(url, { method: 'POST', headers: { ...opts.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(year ? { year } : {}) })
    : await f(year ? `${url}?year=${year}` : url, { headers: opts.headers });
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: PreviewData; error?: { code?: string } } | null;

  if (res.status === 422 && (body?.error?.code === 'not_registered' || body?.error?.code === 'unsupported_jurisdiction')) {
    return { message: opts.t('skill.restatement_not_applicable'), data: body?.data ?? null };
  }
  if (!res.ok || !body?.success || !body.data) throw new Error(`restatement ${opts.mode} failed: ${res.status}`);
  const d = body.data;
  if (!d.applicable) return { message: opts.t('skill.restatement_not_applicable'), data: d };

  const closed = d.counts.skippedClosed > 0 ? ` ${opts.t('skill.restatement_skipped_closed', { count: d.counts.skippedClosed })}` : '';
  if (opts.mode === 'apply') {
    const n = Array.isArray(d.restated) ? d.restated.length : 0;
    if (n === 0) return { message: opts.t('skill.restatement_nothing', { year: d.year, from: d.from, to: d.to }) + closed, data: d };
    return { message: opts.t('skill.restatement_done', { count: n, year: d.year, amount: opts.money(d.recoverableTaxCents) }) + closed, data: d };
  }
  if (d.counts.eligible === 0) return { message: opts.t('skill.restatement_nothing', { year: d.year, from: d.from, to: d.to }) + closed, data: d };
  return {
    message: opts.t('skill.restatement_preview', { year: d.year, from: d.from, to: d.to, count: d.counts.eligible, amount: opts.money(d.recoverableTaxCents) }) + closed,
    data: d,
  };
}
