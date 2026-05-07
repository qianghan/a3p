/**
 * Year-end tax package page (PR 5).
 *
 * Pattern mirrored after `agentbook-expense/Mileage.tsx`:
 *   • Year picker (defaults to last calendar year — typical filing
 *     pattern: 2026 → file 2025).
 *   • Generate button — POSTs to `/api/v1/agentbook-tax/tax-package/generate`,
 *     which is idempotent on (tenant, year, jurisdiction).
 *   • List of past packages with download links + per-row Regenerate.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw } from 'lucide-react';

const API = '/api/v1/agentbook-tax';

interface TaxPackage {
  id: string;
  year: number;
  jurisdiction: 'us' | 'ca';
  pdfUrl: string | null;
  receiptsZipUrl: string | null;
  csvUrls: { pnl?: string; mileage?: string; deductions?: string } | null;
  summary: {
    expenseCount?: number;
    deductionsCents?: number;
    mileageDeductionCents?: number;
    arTotalCents?: number;
  } | null;
  status: string;
  errorMsg: string | null;
  createdAt: string;
}

const fmtMoney = (cents: number, ccy = 'USD') =>
  (cents / 100).toLocaleString(ccy === 'CAD' ? 'en-CA' : 'en-US', {
    style: 'currency',
    currency: ccy,
  });

export const TaxPackagePage: React.FC = () => {
  const lastYear = new Date().getUTCFullYear() - 1;
  const yearOptions = useMemo(() => {
    // Show 5 years back + the current year so users can also build a
    // current-year preview if they want to see the running totals.
    const yrs: number[] = [];
    const top = new Date().getUTCFullYear();
    for (let y = top; y >= top - 5; y -= 1) yrs.push(y);
    return yrs;
  }, []);

  const [year, setYear] = useState<number>(lastYear);
  const [packages, setPackages] = useState<TaxPackage[]>([]);
  const [generating, setGenerating] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`${API}/tax-package`);
      const j = await res.json();
      if (j.success) setPackages(j.data || []);
    } catch (err) {
      console.warn('[tax-package] load failed:', err);
    }
  };

  useEffect(() => { load(); }, []);

  const generate = async (targetYear: number) => {
    setGenerating(targetYear);
    setError(null);
    try {
      const res = await fetch(`${API}/tax-package/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: targetYear }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) {
        setError(j.error || 'Failed to generate package.');
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(null);
    }
  };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold">Year-end Tax Package</h1>
        </div>
      </div>

      {/* Generate panel */}
      <div className="bg-card border border-border rounded-xl p-4 mb-6">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Tax year</label>
            <select
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="p-2 border border-border rounded-lg bg-background"
              aria-label="Tax year"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => generate(year)}
            disabled={generating !== null}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2"
          >
            {generating === year
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Building…</>
              : <><FileText className="w-4 h-4" /> Generate package</>}
          </button>
          <p className="text-xs text-muted-foreground">
            Bundles your P&amp;L, mileage, deductions, and AR snapshot into a PDF + CSVs
            ready for your accountant.
          </p>
        </div>
        {error && (
          <p className="text-sm text-red-500 mt-3">{error}</p>
        )}
      </div>

      {/* History */}
      <h2 className="text-sm font-medium text-muted-foreground mb-3">Past packages</h2>
      {packages.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-6">
          No packages yet. Pick a year above and tap <b>Generate package</b>.
        </p>
      )}
      <div className="space-y-2">
        {packages.map((p) => {
          const ccy = p.jurisdiction === 'ca' ? 'CAD' : 'USD';
          const ready = p.status === 'ready';
          return (
            <div key={p.id} className="bg-card border border-border rounded-lg p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {p.year} · {p.jurisdiction.toUpperCase()} ·{' '}
                    <span className={ready ? 'text-emerald-600' : p.status === 'failed' ? 'text-red-500' : 'text-muted-foreground'}>
                      {p.status}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.summary?.expenseCount ?? 0} expenses ·
                    {' '}deductions {fmtMoney(p.summary?.deductionsCents ?? 0, ccy)} ·
                    {' '}mileage {fmtMoney(p.summary?.mileageDeductionCents ?? 0, ccy)} ·
                    {' '}AR {fmtMoney(p.summary?.arTotalCents ?? 0, ccy)}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Built {new Date(p.createdAt).toLocaleString()}
                  </p>
                  {p.errorMsg && (
                    <p className="text-xs text-red-500 mt-1">{p.errorMsg}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {ready && p.pdfUrl && (
                    <a
                      href={p.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1"
                    >
                      <Download className="w-3.5 h-3.5" /> PDF
                    </a>
                  )}
                  {ready && p.csvUrls?.pnl && (
                    <a href={p.csvUrls.pnl} target="_blank" rel="noreferrer"
                      className="text-xs underline text-muted-foreground">P&amp;L</a>
                  )}
                  {ready && p.csvUrls?.mileage && (
                    <a href={p.csvUrls.mileage} target="_blank" rel="noreferrer"
                      className="text-xs underline text-muted-foreground">mileage</a>
                  )}
                  {ready && p.csvUrls?.deductions && (
                    <a href={p.csvUrls.deductions} target="_blank" rel="noreferrer"
                      className="text-xs underline text-muted-foreground">deductions</a>
                  )}
                  {ready && p.receiptsZipUrl && (
                    <a href={p.receiptsZipUrl} target="_blank" rel="noreferrer"
                      className="text-xs underline text-muted-foreground">ZIP</a>
                  )}
                  <button
                    onClick={() => generate(p.year)}
                    disabled={generating !== null}
                    className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1 disabled:opacity-50"
                    title="Rebuild this package with the latest books"
                  >
                    {generating === p.year
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <RefreshCw className="w-3.5 h-3.5" />}
                    Regenerate
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
