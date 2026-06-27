import { useEffect, useState } from 'react';
import { CurrentPlanCard } from './CurrentPlanCard';
import { UsageBars } from './UsageBars';
import { PlanGrid } from './PlanGrid';
import { SubscribeModal } from './SubscribeModal';
import { UpgradeTimingModal } from './UpgradeTimingModal';
import { meApi, type CurrentPlanView, type Plan } from '../lib/api';

type ModalState =
  | { kind: 'none' }
  | { kind: 'timing'; plan: Plan }
  | { kind: 'subscribe'; plan: Plan };

export function UserApp(): JSX.Element {
  const [view, setView] = useState<CurrentPlanView | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    meApi.current().then(setView).catch((e: unknown) => console.error(e));
  }, [refresh]);

  if (!view) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const hasActivePaidSub =
    view.plan.priceCents > 0 &&
    (view.status === 'active' || view.status === 'trialing');

  const handleSubscribe = (p: Plan): void => {
    if (p.priceCents === 0) {
      if (window.confirm('Downgrade to the Free plan at the end of your current period?')) {
        meApi.cancel().then(() => setRefresh((r) => r + 1)).catch(console.error);
      }
      return;
    }
    if (hasActivePaidSub && p.interval === 'year') {
      setModal({ kind: 'timing', plan: p });
      return;
    }
    setModal({ kind: 'subscribe', plan: p });
  };

  const handleDone = (): void => {
    setModal({ kind: 'none' });
    setRefresh((r) => r + 1);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <CurrentPlanCard view={view} onRefresh={() => setRefresh((r) => r + 1)} />
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 text-sm font-medium text-muted-foreground">Usage this period</h3>
        <UsageBars usage={view.usage} />
      </div>
      <h3 className="text-lg font-semibold text-foreground">Available plans</h3>
      <PlanGrid currentPlanCode={view.plan.code} onSubscribe={handleSubscribe} />

      {modal.kind === 'timing' && (
        <UpgradeTimingModal
          plan={modal.plan}
          onConfirm={() => setModal({ kind: 'subscribe', plan: modal.plan })}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'subscribe' && (
        <SubscribeModal
          plan={modal.plan}
          onClose={() => setModal({ kind: 'none' })}
          onDone={handleDone}
        />
      )}
    </div>
  );
}
