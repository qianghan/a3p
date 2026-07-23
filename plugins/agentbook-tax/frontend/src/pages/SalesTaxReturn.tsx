import React, { useEffect, useState } from 'react';
import { Loader2, FileSpreadsheet, AlertCircle } from 'lucide-react';
import { formatMoney } from '@agentbook/i18n';
import { TaxDisclaimer } from '../components/TaxDisclaimer';

/**
 * GST/HST (Canada) & BAS (Australia) sales-tax return view. Reads the tenant's
 * jurisdiction and calls the matching prep endpoint:
 *   ca → /api/v1/agentbook-tax/ca/gst-hst-return  (lines 101/105/108/109)
 *   au → /api/v1/agentbook-tax/au/bas-return       (G1/1A/1B, W1/W2, net)
 * Prep + working papers only — electronic lodgment (NETFILE / SBR) is a
 * separate accredited step, so nothing is transmitted from here.
 */

interface Line { label: string; amountCents: number; strong?: boolean; note?: string }

interface CaReturn {
  period: { start: string; end: string };
  line101TotalSalesCents: number;
  line105GstHstCollectedCents: number;
  line108ItcCents: number;
  line109NetTaxCents: number;
  outcome: string;
}
interface AuReturn {
  period: { start: string; end: string };
  g1TotalSalesCents: number;
  label1AGstOnSalesCents: number;
  label1BGstOnPurchasesCents: number;
  netGstCents: number;
  w1TotalWagesCents: number;
  w2PaygWithheldCents: number;
  totalPayableCents: number;
  outcome: string;
}

export const SalesTaxReturnPage: React.FC = () => {
  const [jurisdiction, setJurisdiction] = useState<string | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [lines, setLines] = useState<Line[] | null>(null);
  const [title, setTitle] = useState('Sales Tax Return');
  const [period, setPeriod] = useState<{ start: string; end: string } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch('/api/v1/agentbook-core/tenant-config')).json();
        const j = (cfg?.data?.jurisdiction || 'us') as string;
        setJurisdiction(j);
        setCurrency(cfg?.data?.currency || 'USD');

        if (j === 'ca') {
          setTitle('GST/HST Return');
          const res = await fetch('/api/v1/agentbook-tax/ca/gst-hst-return');
          const body = await res.json();
          if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Failed to load the GST/HST return.');
          const d = body.data as CaReturn;
          setPeriod(d.period); setOutcome(d.outcome);
          setLines([
            { label: 'Line 101 — Total sales (excl. tax)', amountCents: d.line101TotalSalesCents },
            { label: 'Line 105 — GST/HST collected', amountCents: d.line105GstHstCollectedCents },
            { label: 'Line 108 — Input tax credits (ITCs)', amountCents: d.line108ItcCents },
            { label: 'Line 109 — Net tax', amountCents: d.line109NetTaxCents, strong: true },
          ]);
        } else if (j === 'au') {
          setTitle('BAS — GST');
          const res = await fetch('/api/v1/agentbook-tax/au/bas-return');
          const body = await res.json();
          if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Failed to load the BAS.');
          const d = body.data as AuReturn;
          setPeriod(d.period); setOutcome(d.outcome);
          const rows: Line[] = [
            { label: 'G1 — Total sales (incl. GST)', amountCents: d.g1TotalSalesCents },
            { label: '1A — GST on sales', amountCents: d.label1AGstOnSalesCents },
            { label: '1B — GST on purchases (ITCs)', amountCents: d.label1BGstOnPurchasesCents },
            { label: 'Net GST (1A − 1B)', amountCents: d.netGstCents },
          ];
          if (d.w1TotalWagesCents > 0 || d.w2PaygWithheldCents > 0) {
            rows.push({ label: 'W1 — Total salary & wages', amountCents: d.w1TotalWagesCents });
            rows.push({ label: 'W2 — PAYG withheld', amountCents: d.w2PaygWithheldCents });
          }
          rows.push({ label: 'Total payable to ATO (net GST + W2)', amountCents: d.totalPayableCents, strong: true });
          setLines(rows);
        } else {
          setLines(null); // unsupported jurisdiction — handled in render
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading your return…</div>;
  }

  if (jurisdiction && jurisdiction !== 'ca' && jurisdiction !== 'au') {
    return (
      <div className="p-6 max-w-2xl">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          <AlertCircle className="w-5 h-5 shrink-0 text-amber-500" />
          <div>Sales-tax returns are available for <b>Canada (GST/HST)</b> and <b>Australia (BAS)</b>. Your business is set to <b>{jurisdiction.toUpperCase()}</b> — set your jurisdiction to CA or AU in Business Profile to prepare one.</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-2xl">
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0 text-destructive" />
          <div><b>Couldn't load your return.</b> {error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      {period && (
        <p className="text-sm text-muted-foreground">
          Period {period.start} → {period.end}
          {outcome && <> · <span className="font-medium capitalize">{outcome.replace('_', ' ')}</span></>}
        </p>
      )}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {(lines ?? []).map((l) => (
              <tr key={l.label} className={`border-b border-border last:border-0 ${l.strong ? 'font-semibold bg-muted/40' : ''}`}>
                <td className="px-4 py-2.5 text-foreground">{l.label}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatMoney(l.amountCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        Prepared from your invoices and expenses for review and hand-off. AgentBook does <b>not</b> lodge this
        electronically — file it through {jurisdiction === 'au' ? 'the ATO (Online services / your BAS agent)' : 'CRA (My Business Account / NETFILE) or your accountant'}.
      </div>
      <TaxDisclaimer />
    </div>
  );
};
