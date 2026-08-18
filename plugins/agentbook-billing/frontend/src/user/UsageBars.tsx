import { useI18n } from '@naap/plugin-sdk';

/**
 * Usage dimension -> translation key.
 *
 * The map holds KEYS rather than English text so the labels resolve through
 * the catalog. Keeping the dimension ids (which come from the API) separate
 * from the display strings is what makes that possible.
 */
const LABEL_KEYS: Record<string, string> = {
  expenses_created: 'billing.usage_expenses_created',
  ocr_scans: 'billing.usage_receipt_scans',
  ai_messages: 'billing.usage_ai_messages',
  invoices_sent: 'billing.usage_invoices_sent',
  bank_connections: 'billing.usage_bank_connections',
};

export function UsageBars({ usage }: { usage: Record<string, { used: number; limit: number }> }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      {Object.entries(usage).map(([dim, { used, limit }]) => {
        const isUnlimited = limit === -1;
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
        const labelKey = LABEL_KEYS[dim];
        return (
          <div key={dim}>
            <div className="flex justify-between text-xs text-muted-foreground">
              {/* Unknown dimension ids fall through to the raw id, as before —
                  better than a blank label if the API adds one we don't know. */}
              <span>{labelKey ? t(labelKey) : dim}</span>
              <span className="font-medium">
                {used}{isUnlimited ? '' : ` / ${limit}`}
                {isUnlimited && <span className="ml-1 text-primary">{t('billing.unlimited')}</span>}
              </span>
            </div>
            {!isUnlimited && (
              <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                <div
                  className={`h-1.5 rounded-full transition-all ${pct >= 90 ? 'bg-destructive' : pct >= 75 ? 'bg-amber-400' : 'bg-primary'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
