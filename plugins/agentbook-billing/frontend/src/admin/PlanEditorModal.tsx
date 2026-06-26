import { useState } from 'react';
import { billingApi, type PlanTemplate, type Plan } from '../lib/api';

type Mode = { kind: 'create'; template: PlanTemplate } | { kind: 'edit'; plan: Plan };

const FEATURE_META = [
  { key: 'telegram_bot' as const, label: 'Telegram bot', desc: 'Allow users to interact via Telegram' },
  { key: 'tax_package_generation' as const, label: 'Tax package exports', desc: 'Generate Schedule C / T2125 PDFs' },
  { key: 'multi_user_teams' as const, label: 'Multi-user teams', desc: 'Multiple seats per account' },
];

const QUOTA_META = [
  { key: 'expenses_created' as const, label: 'Expenses / month', desc: '-1 = unlimited' },
  { key: 'ocr_scans' as const, label: 'OCR receipt scans / month', desc: '-1 = unlimited' },
  { key: 'ai_messages' as const, label: 'AI messages / month', desc: '-1 = unlimited' },
  { key: 'invoices_sent' as const, label: 'Invoices sent / month', desc: '-1 = unlimited' },
  { key: 'bank_connections' as const, label: 'Bank connections', desc: '-1 = unlimited' },
];

export function PlanEditorModal({ mode, onClose, onSaved }: {
  mode: Mode;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const seed = mode.kind === 'create' ? mode.template : mode.plan;
  const [form, setForm] = useState({
    code: 'code' in seed ? seed.code : '',
    name: seed.name,
    description: seed.description ?? '',
    priceCents: seed.priceCents,
    currency: seed.currency,
    interval: seed.interval,
    features: { ...seed.features },
    quotas: { ...seed.quotas },
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true); setErr(null);
    try {
      if (mode.kind === 'create') {
        await billingApi.createPlan(form);
      } else {
        await billingApi.patchPlan(mode.plan.id, {
          name: form.name,
          description: form.description,
          features: form.features,
          quotas: form.quotas,
        });
      }
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:bg-muted disabled:text-muted-foreground';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[640px] max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">
            {mode.kind === 'create' ? `New plan from ${mode.template.name}` : `Edit ${mode.plan.name}`}
          </h3>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>

        {err && (
          <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        <div className="space-y-4">
          {/* Basic info */}
          <div className="rounded-lg border border-border bg-background/50 p-4 space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Basic info</h4>

            <div>
              <label className="text-sm font-medium text-foreground">Plan name</label>
              <input
                className={inputCls}
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Pro"
              />
            </div>

            {mode.kind === 'create' && (
              <div>
                <label className="text-sm font-medium text-foreground">Code</label>
                <p className="text-xs text-muted-foreground">URL-safe, unique identifier</p>
                <input
                  className={`${inputCls} font-mono`}
                  value={form.code}
                  onChange={e => setForm({ ...form, code: e.target.value })}
                  placeholder="e.g. pro"
                />
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-foreground">Description</label>
              <input
                className={inputCls}
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Short plan description shown to users"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">Price (cents)</label>
                <p className="text-xs text-muted-foreground">1900 = $19.00 — fixed at create</p>
                <input
                  type="number"
                  disabled={mode.kind !== 'create'}
                  className={inputCls}
                  value={form.priceCents}
                  onChange={e => setForm({ ...form, priceCents: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Interval</label>
                <p className="text-xs text-muted-foreground">Billing cycle — fixed at create</p>
                <select
                  disabled={mode.kind !== 'create'}
                  className={inputCls}
                  value={form.interval}
                  onChange={e => setForm({ ...form, interval: e.target.value as 'month' | 'year' })}
                >
                  <option value="month">Monthly</option>
                  <option value="year">Annual</option>
                </select>
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="rounded-lg border border-border bg-background/50 p-4">
            <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Features</h4>
            <div className="space-y-3">
              {FEATURE_META.map(({ key, label, desc }) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer">
                  <div className="mt-0.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border bg-background accent-primary cursor-pointer"
                      checked={form.features[key]}
                      onChange={e => setForm({ ...form, features: { ...form.features, [key]: e.target.checked } })}
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <div className="text-xs text-muted-foreground">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Quotas */}
          <div className="rounded-lg border border-border bg-background/50 p-4">
            <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Quotas</h4>
            <div className="space-y-3">
              {QUOTA_META.map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <div className="text-xs text-muted-foreground">{desc}</div>
                  </div>
                  <input
                    type="number"
                    className="w-28 rounded-lg border border-border bg-background px-3 py-1.5 text-right text-sm text-foreground focus:border-primary focus:outline-none"
                    value={form.quotas[key]}
                    onChange={e => setForm({ ...form, quotas: { ...form.quotas, [key]: Number(e.target.value) } })}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-border bg-transparent px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={save}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
