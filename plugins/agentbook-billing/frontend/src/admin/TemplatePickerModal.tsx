import { useEffect, useState } from 'react';
import { billingApi, type PlanTemplate } from '../lib/api';

interface Props { onClose: () => void; onPicked: (t: PlanTemplate) => void; }

export function TemplatePickerModal({ onClose, onPicked }: Props): JSX.Element {
  const [tpls, setTpls] = useState<PlanTemplate[] | null>(null);
  useEffect(() => { billingApi.listTemplates().then(setTpls); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[600px] rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-foreground">Start from a template</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Admin — creates a new plan in the database</p>
          </div>
          <button
            onClick={onClose}
            aria-label="close"
            className="text-xl text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>
        {!tpls ? (
          <div className="py-6 text-center text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {tpls.map(t => (
              <button
                key={t.code}
                onClick={() => onPicked(t)}
                className="rounded-lg border border-border bg-background p-4 text-left hover:border-primary/40 hover:bg-muted/50 transition-colors"
              >
                <div className="font-medium text-foreground">{t.name}</div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  ${(t.priceCents / 100).toFixed(0)} / {t.interval}
                </div>
                <div className="mt-2 text-xs text-muted-foreground leading-relaxed">{t.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
