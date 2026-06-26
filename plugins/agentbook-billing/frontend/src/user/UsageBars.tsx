const LABELS: Record<string, string> = {
  expenses_created: 'Expenses created',
  ocr_scans: 'Receipt scans',
  ai_messages: 'AI messages',
  invoices_sent: 'Invoices sent',
  bank_connections: 'Bank connections',
};

export function UsageBars({ usage }: { usage: Record<string, { used: number; limit: number }> }): JSX.Element {
  return (
    <div className="space-y-3">
      {Object.entries(usage).map(([dim, { used, limit }]) => {
        const isUnlimited = limit === -1;
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
        return (
          <div key={dim}>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{LABELS[dim] ?? dim}</span>
              <span className="font-medium">
                {used}{isUnlimited ? '' : ` / ${limit}`}
                {isUnlimited && <span className="ml-1 text-primary">Unlimited</span>}
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
