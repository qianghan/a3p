import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Wallet,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';

interface Projection {
  period: string;
  projected_balance: number;
  expected_income: number;
  expected_expenses: number;
}

interface CashFlowData {
  current_balance: number;
  projections: Projection[];
}

function formatCurrency(n: number, currency: string = 'USD') {
  return formatMoney(Math.round(n * 100), currency);
}

export const CashFlowPage: React.FC = () => {
  const [data, setData] = useState<CashFlowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currency = useTenantCurrency();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/agentbook-tax/cashflow/projection');
      if (!res.ok) throw new Error('Failed to fetch cash flow data');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to fetch cash flow data');
      // QA-P3-003: the API returns { data: { currentCashCents, projections:
      // [{ days, projectedCashCents, expectedIncome: { totalCents }, expectedExpenses }] } }
      // (amounts in cents, no envelope-unwrapped flat shape) — this page was
      // reading a `current_balance`/`projected_balance` shape in dollars that
      // never existed, so the balance showed $NaN and the projection cards
      // silently rendered nothing at all.
      const raw = json.data;
      setData({
        current_balance: (raw.currentCashCents ?? 0) / 100,
        projections: (raw.projections ?? []).map((p: { days: number; projectedCashCents: number; expectedIncome?: { totalCents: number }; expectedExpenses: number }) => ({
          period: `${p.days}-day`,
          projected_balance: (p.projectedCashCents ?? 0) / 100,
          expected_income: (p.expectedIncome?.totalCents ?? 0) / 100,
          expected_expenses: (p.expectedExpenses ?? 0) / 100,
        })),
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-emerald)' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20 p-4">
        <p className="text-red-500 mb-3">{error}</p>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const periodLabels: Record<string, string> = {
    '30-day': '30 Day',
    '60-day': '60 Day',
    '90-day': '90 Day',
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Cash Flow Projection
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Forecast and analyze cash flow with scenario modeling
        </p>
      </div>

      {/* Current balance */}
      <div
        className="rounded-xl p-6 mb-6 text-center border"
        style={{ backgroundColor: 'var(--bg-primary, #fff)', borderColor: 'var(--border-primary, #e5e7eb)' }}
      >
        <div className="inline-flex items-center gap-2 mb-2">
          <div className="p-2 rounded-lg bg-emerald-100">
            <Wallet className="w-5 h-5 text-emerald-600" />
          </div>
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
            Current Cash Balance
          </span>
        </div>
        <p
          className={`text-4xl sm:text-5xl font-bold ${
            data.current_balance >= 0 ? 'text-emerald-600' : 'text-red-600'
          }`}
        >
          {formatCurrency(data.current_balance, currency)}
        </p>
      </div>

      {/* Projection cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(data.projections ?? []).map((p) => {
          const isPositive = p.projected_balance >= 0;
          return (
            <div
              key={p.period}
              className={`rounded-xl p-5 border-t-4 border ${
                isPositive ? 'border-t-green-500' : 'border-t-red-500'
              }`}
              style={{ backgroundColor: 'var(--bg-primary, #fff)', borderColor: 'var(--border-primary, #e5e7eb)' }}
            >
              <h3 className="text-sm font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--text-secondary)' }}>
                {periodLabels[p.period] ?? p.period} Projection
              </h3>

              <p
                className={`text-2xl font-bold mb-4 ${isPositive ? 'text-green-600' : 'text-red-600'}`}
              >
                {formatCurrency(p.projected_balance, currency)}
              </p>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-green-100">
                    <TrendingUp className="w-4 h-4 text-green-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Expected Income</p>
                    <p className="text-sm font-semibold text-green-600">
                      {formatCurrency(p.expected_income, currency)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-red-100">
                    <TrendingDown className="w-4 h-4 text-red-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Expected Expenses</p>
                    <p className="text-sm font-semibold text-red-600">
                      {formatCurrency(p.expected_expenses, currency)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CashFlowPage;
