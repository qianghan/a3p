import { AlertCircle } from 'lucide-react';

/**
 * "Not tax advice" disclaimer. Same text and layout already live on
 * TaxDashboard.tsx — extracted here so every tax-figure-producing page
 * shows it, not just one.
 */
export function TaxDisclaimer() {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
      <AlertCircle className="inline w-3.5 h-3.5 mr-1 text-yellow-400" />
      Tax calculations are estimates for planning purposes only. Consult a licensed tax professional for filing advice.
    </div>
  );
}
