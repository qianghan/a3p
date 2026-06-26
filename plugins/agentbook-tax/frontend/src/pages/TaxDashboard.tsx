import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Percent,
  Calendar,
  CheckCircle,
  Clock,
  Loader2,
  RefreshCw,
  Settings,
  AlertCircle,
  Globe,
  Building2,
} from 'lucide-react';

interface TaxEstimate {
  total_estimated_tax: number;
  income_tax: number;
  self_employment_tax: number;
  // effective_rate is returned as a percentage value already (e.g. 27.3, not 0.273)
  effective_rate: number;
  total_revenue: number;
  total_expenses: number;
  net_income: number;
  quarterly_payments: {
    quarter: string;
    amount_due: number;
    amount_paid: number;
    status: 'paid' | 'due' | 'upcoming' | 'overdue';
    deadline: string;
  }[];
}

interface TaxSettings {
  jurisdiction: string;
  region: string;
  businessType: string;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// effective_rate comes from the API already as a % (e.g. 27.3), not a decimal
function formatPercent(n: number) {
  return `${n.toFixed(1)}%`;
}

type Tab = 'dashboard' | 'settings';

const QUARTER_BADGE: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
  paid:     { cls: 'bg-primary/10 text-primary border border-primary/20',       icon: <CheckCircle className="w-3 h-3" />, label: 'Paid' },
  due:      { cls: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20', icon: <Clock className="w-3 h-3" />,      label: 'Due' },
  upcoming: { cls: 'bg-muted text-muted-foreground border border-border',        icon: <Calendar className="w-3 h-3" />,    label: 'Upcoming' },
  overdue:  { cls: 'bg-destructive/10 text-destructive border border-destructive/20', icon: <Clock className="w-3 h-3" />,  label: 'Overdue' },
};

const QUARTER_CARD_BORDER: Record<string, string> = {
  paid:     'border-l-primary',
  due:      'border-l-yellow-500',
  upcoming: 'border-l-border',
  overdue:  'border-l-destructive',
};

function DashboardTab({ data, onRefresh }: { data: TaxEstimate; onRefresh: () => void }) {
  return (
    <div className="space-y-4">
      {/* Refresh */}
      <div className="flex justify-end">
        <button
          onClick={onRefresh}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* Big number */}
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Total Estimated Tax
        </p>
        <p className="text-4xl sm:text-5xl font-bold text-foreground">
          {formatCurrency(data.total_estimated_tax)}
        </p>
        {data.net_income > 0 && (
          <p className="mt-2 text-sm text-muted-foreground">
            on {formatCurrency(data.net_income)} net income
          </p>
        )}
      </div>

      {/* Breakdown cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <DollarSign className="w-4 h-4 text-primary" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Income Tax</span>
          </div>
          <p className="text-xl font-bold text-foreground">{formatCurrency(data.income_tax)}</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-violet-500/10">
              <DollarSign className="w-4 h-4 text-violet-400" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">SE Tax / CPP</span>
          </div>
          <p className="text-xl font-bold text-foreground">{formatCurrency(data.self_employment_tax)}</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-yellow-500/10">
              <Percent className="w-4 h-4 text-yellow-400" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Effective Rate</span>
          </div>
          <p className="text-xl font-bold text-foreground">{formatPercent(data.effective_rate)}</p>
        </div>
      </div>

      {/* Revenue vs Expenses */}
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-4">
          Revenue vs Expenses
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Revenue</p>
              <p className="text-lg font-bold text-primary">{formatCurrency(data.total_revenue)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-destructive/10">
              <TrendingDown className="w-5 h-5 text-destructive" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Expenses</p>
              <p className="text-lg font-bold text-destructive">{formatCurrency(data.total_expenses)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${data.net_income >= 0 ? 'bg-primary/10' : 'bg-destructive/10'}`}>
              <DollarSign className={`w-5 h-5 ${data.net_income >= 0 ? 'text-primary' : 'text-destructive'}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Net Income</p>
              <p className={`text-lg font-bold ${data.net_income >= 0 ? 'text-primary' : 'text-destructive'}`}>
                {formatCurrency(data.net_income)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Quarterly tracker */}
      {data.quarterly_payments.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-4">
            Quarterly Payments
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {data.quarterly_payments.map((q) => {
              const badge = QUARTER_BADGE[q.status] ?? QUARTER_BADGE.upcoming;
              const borderCls = QUARTER_CARD_BORDER[q.status] ?? QUARTER_CARD_BORDER.upcoming;
              return (
                <div
                  key={q.quarter}
                  className={`rounded-xl border border-border bg-background p-4 border-l-4 ${borderCls}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-sm text-foreground">{q.quarter}</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>
                      {badge.icon} {badge.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">
                    Due: {new Date(q.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                  <p className="text-lg font-bold text-foreground">{formatCurrency(q.amount_due)}</p>
                  {q.amount_paid > 0 && (
                    <p className="text-xs text-primary mt-1">Paid: {formatCurrency(q.amount_paid)}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const JURISDICTION_OPTIONS = [
  { value: 'us', label: '🇺🇸 United States' },
  { value: 'ca', label: '🇨🇦 Canada' },
];

const US_REGIONS = [
  { value: '', label: 'Federal only' },
  { value: 'CA', label: 'California' },
  { value: 'NY', label: 'New York' },
  { value: 'TX', label: 'Texas' },
  { value: 'FL', label: 'Florida' },
  { value: 'WA', label: 'Washington' },
];

const CA_REGIONS = [
  { value: '', label: 'Federal only' },
  { value: 'ON', label: 'Ontario' },
  { value: 'BC', label: 'British Columbia' },
  { value: 'AB', label: 'Alberta' },
  { value: 'QC', label: 'Quebec' },
];

const BUSINESS_TYPES = [
  { value: 'sole_proprietor', label: 'Sole Proprietor / Freelancer' },
  { value: 'llc_single', label: 'Single-member LLC' },
  { value: 'llc_multi', label: 'Multi-member LLC' },
  { value: 'scorp', label: 'S-Corporation' },
  { value: 'corporation', label: 'Corporation' },
];

function SettingsTab() {
  const [settings, setSettings] = useState<TaxSettings>(() => {
    try {
      const saved = localStorage.getItem('agentbook_tax_settings');
      return saved ? JSON.parse(saved) : { jurisdiction: 'us', region: '', businessType: 'sole_proprietor' };
    } catch {
      return { jurisdiction: 'us', region: '', businessType: 'sole_proprietor' };
    }
  });
  const [saved, setSaved] = useState(false);

  const handleChange = (key: keyof TaxSettings, value: string) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'jurisdiction') next.region = '';
      return next;
    });
    setSaved(false);
  };

  const handleSave = () => {
    localStorage.setItem('agentbook_tax_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const regionOptions = settings.jurisdiction === 'ca' ? CA_REGIONS : US_REGIONS;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-1">Tax Jurisdiction</h2>
        <p className="text-xs text-muted-foreground mb-3">
          AgentBook uses this to load the correct tax rates and filing skills for your situation.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              <Globe className="inline w-3.5 h-3.5 mr-1" />Country
            </label>
            <select
              value={settings.jurisdiction}
              onChange={e => handleChange('jurisdiction', e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {JURISDICTION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Province / State
            </label>
            <select
              value={settings.region}
              onChange={e => handleChange('region', e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {regionOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              <Building2 className="inline w-3.5 h-3.5 mr-1" />Business Type
            </label>
            <select
              value={settings.businessType}
              onChange={e => handleChange('businessType', e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {BUSINESS_TYPES.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <AlertCircle className="inline w-3.5 h-3.5 mr-1 text-yellow-400" />
        Tax calculations are estimates for planning purposes only. Consult a licensed tax professional for filing advice.
      </div>

      <button
        onClick={handleSave}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved
            ? 'bg-primary/10 text-primary'
            : 'bg-primary text-primary-foreground hover:opacity-90'
        }`}
      >
        {saved ? <CheckCircle className="w-4 h-4" /> : null}
        {saved ? 'Saved!' : 'Save Settings'}
      </button>
    </div>
  );
}

export const TaxDashboardPage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [data, setData] = useState<TaxEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/agentbook-tax/tax/estimate');
      if (!res.ok) throw new Error('Failed to fetch tax estimate');
      const json = await res.json();
      setData(json);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-xl font-bold text-foreground">Tax</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Estimates, quarterly payments, and jurisdiction settings</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border mb-5">
        {([
          { id: 'dashboard', label: 'Dashboard' },
          { id: 'settings', label: 'Settings', icon: <Settings className="w-3.5 h-3.5" /> },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* Dashboard tab content */}
      {tab === 'dashboard' && (
        loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="text-center py-20 p-4">
            <p className="text-destructive mb-3">{error}</p>
            <button
              onClick={fetchData}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-border hover:bg-muted"
            >
              <RefreshCw className="w-4 h-4" /> Retry
            </button>
          </div>
        ) : data ? (
          <DashboardTab data={data} onRefresh={fetchData} />
        ) : null
      )}

      {/* Settings tab content */}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
};

export default TaxDashboardPage;
