import { useEffect, useState } from 'react';
import { billingApi, type Plan } from '../lib/api';

function fmtPrice(cents: number, currency: string, interval: string): string {
  return `${new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)} / ${interval}`;
}

interface Props { onEdit: (p: Plan) => void; onAdd: () => void; }

export function PlanList({ onEdit, onAdd }: Props): JSX.Element {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = (): void => {
    billingApi.listPlans().then(setPlans).catch(e => setErr(String(e)));
  };
  useEffect(load, []);

  const archive = async (p: Plan): Promise<void> => {
    if (!window.confirm(`Archive plan "${p.name}"? Existing subscriptions keep working.`)) return;
    await billingApi.archivePlan(p.id);
    load();
  };

  if (err) return <div className="p-6 text-destructive">{err}</div>;
  if (!plans) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Subscription Plans</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Admin view — manage plan templates</p>
        </div>
        <button
          onClick={onAdd}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + New plan from template
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Code</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Price</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Telegram</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Tax pkg</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {plans.map(p => (
              <tr key={p.id} className="bg-card hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{p.code}</code>
                </td>
                <td className="px-4 py-3 font-medium text-foreground">{p.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{fmtPrice(p.priceCents, p.currency, p.interval)}</td>
                <td className="px-4 py-3 text-center">
                  {p.features.telegram_bot
                    ? <span className="text-primary">✓</span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3 text-center">
                  {p.features.tax_package_generation
                    ? <span className="text-primary">✓</span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => onEdit(p)}
                    className="mr-3 text-primary hover:text-primary/80"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => archive(p)}
                    className="text-destructive hover:text-destructive/80"
                  >
                    Archive
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
