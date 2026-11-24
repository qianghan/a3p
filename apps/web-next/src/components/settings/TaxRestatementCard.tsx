'use client';

/**
 * Settings › Business Profile: opt-in restatement of legacy gross purchases,
 * per tax year (spec §5.1, PR 2c). Preview first (numbers from the server),
 * then Apply behind an explicit confirmation, then the result.
 * Shown only to AU/CA tenants registered for GST/HST.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useT, useShellLocale } from '@/hooks/use-t';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';

interface Row { expenseId: string; date: string; description: string; amountCents: number; recoverableTaxCents: number; taxCode: string | null }
interface Preview {
  year: number; from: string; to: string; applicable: boolean;
  eligible: Row[]; skipped: Array<Row & { reason: string }>; restated?: Row[]; failed?: Row[]; remaining?: number;
  counts: { eligible: number; skippedClosed: number; skippedOther: number; alreadyTyped: number; noTaxAmount: number };
  recoverableTaxCents: number; expenseDeltaCents: number; netProfitDeltaCents: number;
}
interface ApplyTotals { restated: number; recoverableTaxCents: number; failed: number; skippedClosed: number }

const URL_BASE = '/api/v1/agentbook-tax/restatement';
/** Upper bound on continuation calls for one Apply (each call is a bounded batch). */
const MAX_APPLY_CALLS = 50;

export function TaxRestatementCard({ jurisdiction, currency }: { jurisdiction: string; currency?: string | null }): React.ReactElement {
  const t = useT();
  const locale = useShellLocale();
  // The current tax year comes from the server (one definition, tenant zone): the first preview is requested without a year.
  const [current, setCurrent] = useState<number | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ApplyTotals | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const money = (c: number) => formatCurrencyCents(c, currency, locale);
  const years = current === null ? [] : [current, current - 1, current - 2];

  const load = useCallback(async (y: number | null) => {
    setPreview(null); setError(false); setConfirming(false);
    try {
      const r = await fetch(y === null ? URL_BASE : `${URL_BASE}?year=${y}`);
      const body = await r.json();
      if (!r.ok || !body?.success || !body.data?.counts) throw new Error(String(r.status));
      const d = body.data as Preview;
      setPreview(d);
      if (y === null) { setCurrent(d.year); setYear(d.year); }
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => { void load(year); }, [year, load]);

  // One Apply = as many bounded batches as it takes; each batch reports what it committed.
  const apply = async () => {
    if (year === null) return;
    setBusy(true); setError(false);
    const totals: ApplyTotals = { restated: 0, recoverableTaxCents: 0, failed: 0, skippedClosed: 0 };
    try {
      for (let i = 0; i < MAX_APPLY_CALLS; i++) {
        const r = await fetch(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year }) });
        const body = await r.json();
        if (!r.ok || !body?.success || !body.data?.counts) throw new Error(String(r.status));
        const d = body.data as Preview;
        const n = d.restated?.length ?? 0;
        totals.restated += n;
        totals.recoverableTaxCents += d.recoverableTaxCents;
        totals.failed = d.failed?.length ?? 0;
        totals.skippedClosed = d.counts.skippedClosed;
        if (!(d.remaining && d.remaining > 0) || n === 0) break;
      }
      setConfirming(false);
    } catch {
      setError(true);
    } finally {
      // Whatever was committed is shown, even when a later batch failed.
      setResult(totals.restated > 0 || totals.failed > 0 ? totals : null);
      setBusy(false);
      await load(year);
    }
  };

  const yearLabel = (y: number) => (jurisdiction === 'au' ? t('core_ui.restate_year_au', { start: String(y - 1), end: String(y) }) : String(y));

  return (
    <section data-testid="restatement-card" className="rounded-md border border-border p-3">
      <h3 className="text-sm font-medium text-foreground">{t('core_ui.restate_title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('core_ui.restate_help')}</p>
      <label className="mt-2 block text-xs font-medium text-foreground">
        {t('core_ui.restate_tax_year')}
        <select
          data-testid="restatement-year"
          value={year ?? ''}
          onChange={(e) => { setResult(null); setYear(Number(e.target.value)); }}
          className="ml-2 rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          {years.map((y) => <option key={y} value={y}>{yearLabel(y)}</option>)}
        </select>
      </label>

      {error && <p role="alert" data-testid="restatement-error" className="mt-2 text-xs text-red-600">{t('core_ui.restate_failed')}</p>}

      {result && (
        <p role="status" data-testid="restatement-result" className="mt-2 rounded-md border border-green-300 bg-green-50 px-2 py-1.5 text-xs text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-200">
          {t('core_ui.restate_done', { count: String(result.restated), amount: money(result.recoverableTaxCents) })}
          {result.skippedClosed > 0 && <> {t('core_ui.restate_skipped_closed', { count: String(result.skippedClosed) })}</>}
          {result.failed > 0 && <> <span data-testid="restatement-failed">{t('core_ui.restate_failed_rows', { count: String(result.failed) })}</span></>}
        </p>
      )}

      {preview && (
        <div data-testid="restatement-preview" className="mt-2 space-y-1 text-xs text-foreground">
          {preview.counts.eligible === 0 ? (
            <p data-testid="restatement-nothing">{t('core_ui.restate_nothing')}</p>
          ) : (
            <>
              <p data-testid="restatement-summary">
                {t('core_ui.restate_summary', { count: String(preview.counts.eligible), amount: money(preview.recoverableTaxCents) })}
              </p>
              <p data-testid="restatement-delta">{t('core_ui.restate_pnl_delta', { amount: money(preview.netProfitDeltaCents) })}</p>
              <ul className="max-h-40 overflow-y-auto">
                {preview.eligible.map((r) => (
                  <li key={r.expenseId} data-testid="restatement-row">
                    {r.date} · {r.description || '—'} · {money(r.amountCents)} → {t('core_ui.restate_row_recoverable', { amount: money(r.recoverableTaxCents) })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.counts.skippedClosed > 0 && (
            <p data-testid="restatement-closed">{t('core_ui.restate_skipped_closed', { count: String(preview.counts.skippedClosed) })}</p>
          )}
          {preview.counts.skippedOther > 0 && (
            <p data-testid="restatement-other">{t('core_ui.restate_skipped_other', { count: String(preview.counts.skippedOther) })}</p>
          )}
          {preview.counts.alreadyTyped > 0 && (
            <p className="text-muted-foreground">{t('core_ui.restate_already_typed', { count: String(preview.counts.alreadyTyped) })}</p>
          )}
          {preview.counts.eligible > 0 && !confirming && (
            <button type="button" data-testid="restatement-apply" onClick={() => setConfirming(true)}
              className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              {t('core_ui.restate_apply', { year: yearLabel(year ?? preview.year) })}
            </button>
          )}
          {confirming && (
            <div role="alertdialog" data-testid="restatement-confirm" className="mt-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <p>{t('core_ui.restate_confirm', { count: String(preview.counts.eligible), amount: money(preview.recoverableTaxCents), from: preview.from, to: preview.to })}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" data-testid="restatement-confirm-yes" disabled={busy} onClick={apply}
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">
                  {t('core_ui.restate_confirm_yes')}
                </button>
                <button type="button" data-testid="restatement-confirm-no" disabled={busy} onClick={() => setConfirming(false)}
                  className="rounded-md border border-border px-3 py-1 text-xs">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
