import { meApi, type CurrentPlanView } from '../lib/api';

export function CurrentPlanCard({ view, onRefresh }: { view: CurrentPlanView; onRefresh: () => void }): JSX.Element {
  const cancel = async (): Promise<void> => {
    if (!window.confirm('Cancel at the end of the current period?')) return;
    await meApi.cancel();
    onRefresh();
  };
  const reactivate = async (): Promise<void> => {
    await meApi.reactivate();
    onRefresh();
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Current plan</div>
          <div className="mt-0.5 text-2xl font-semibold text-foreground">{view.plan.name}</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium text-foreground">
            ${(view.plan.priceCents / 100).toFixed(2)} / {view.plan.interval}
          </div>
          <div className="text-muted-foreground capitalize">{view.status}</div>
          {view.periodEnd && (
            <div className="text-muted-foreground">
              Renews {new Date(view.periodEnd).toLocaleDateString()}
            </div>
          )}
        </div>
      </div>
      {view.cancelAtPeriodEnd && (
        <div className="mt-3 flex items-center justify-between rounded border border-warning/20 bg-warning/10 p-3 text-sm">
          <span className="text-foreground">Cancels at the end of the current period.</span>
          <button onClick={reactivate} className="font-medium text-primary hover:text-primary/80">
            Reactivate
          </button>
        </div>
      )}
      {!view.cancelAtPeriodEnd && view.plan.code !== 'free' && view.status === 'active' && (
        <div className="mt-3 text-right">
          <button onClick={cancel} className="text-sm text-destructive hover:text-destructive/80">
            Cancel subscription
          </button>
        </div>
      )}
    </div>
  );
}
