import { useI18n } from '@naap/plugin-sdk';
import { meApi, type CurrentPlanView } from '../lib/api';

/**
 * The local CURRENCY_LOCALE table that used to live here is gone — it was one
 * of four identical copies across this plugin, and `formatMoney` in
 * @agentbook/i18n already carries the same mapping. One table, one behaviour.
 */
export function CurrentPlanCard({ view, onRefresh }: { view: CurrentPlanView; onRefresh: () => void }): JSX.Element {
  const { t, formatMoney, formatDate } = useI18n();

  const cancel = async (): Promise<void> => {
    if (!window.confirm(t('billing.confirm_cancel'))) return;
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
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('billing.current_plan')}</div>
          <div className="mt-0.5 text-2xl font-semibold text-foreground">{view.plan.name}</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium text-foreground">
            {formatMoney(view.plan.priceCents, view.plan.currency.toUpperCase())} / {view.plan.interval}
          </div>
          <div className="text-muted-foreground capitalize">{view.status}</div>
          {view.periodEnd && (
            <div className="text-muted-foreground">
              {/* A Stripe period end is a real instant, not a calendar day, so
                  formatDate (local time) is correct here — NOT formatDateOnly. */}
              {t('billing.renews_on', { date: formatDate(view.periodEnd) })}
            </div>
          )}
        </div>
      </div>
      {view.cancelAtPeriodEnd && (
        <div className="mt-3 flex items-center justify-between rounded border border-warning/20 bg-warning/10 p-3 text-sm">
          <span className="text-foreground">{t('billing.cancels_at_period_end')}</span>
          <button onClick={reactivate} className="font-medium text-primary hover:text-primary/80">
            {t('billing.reactivate')}
          </button>
        </div>
      )}
      {!view.cancelAtPeriodEnd && view.plan.code !== 'free' && view.status === 'active' && (
        <div className="mt-3 text-right">
          <button onClick={cancel} className="text-sm text-destructive hover:text-destructive/80">
            {t('billing.cancel_subscription')}
          </button>
        </div>
      )}
    </div>
  );
}
