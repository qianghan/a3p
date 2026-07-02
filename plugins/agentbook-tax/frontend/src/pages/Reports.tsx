import React, { useState } from 'react';
import {
  BarChart3,
  Scale,
  ArrowDownUp,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';

interface ReportRow {
  label: string;
  amount: number;
}

interface ReportData {
  title: string;
  sections?: { heading: string; rows: ReportRow[] }[];
  rows?: ReportRow[];
  net_income?: number;
}

const REPORTS = [
  {
    key: 'pnl',
    title: 'Profit & Loss',
    description: 'Revenue, expenses, and net income for the period',
    icon: <BarChart3 className="w-6 h-6" />,
    color: 'bg-blue-100 text-blue-600',
    endpoint: '/api/v1/agentbook-tax/reports/pnl',
  },
  {
    key: 'balance-sheet',
    title: 'Balance Sheet',
    description: 'Assets, liabilities, and equity snapshot',
    icon: <Scale className="w-6 h-6" />,
    color: 'bg-purple-100 text-purple-600',
    endpoint: '/api/v1/agentbook-tax/reports/balance-sheet',
  },
  {
    key: 'cashflow',
    title: 'Cash Flow',
    description: 'Cash inflows and outflows over the period',
    icon: <ArrowDownUp className="w-6 h-6" />,
    color: 'bg-green-100 text-green-600',
    endpoint: '/api/v1/agentbook-tax/reports/cashflow',
  },
  {
    key: 'trial-balance',
    title: 'Trial Balance',
    description: 'Summary of all account balances',
    icon: <BookOpen className="w-6 h-6" />,
    color: 'bg-amber-100 text-amber-600',
    endpoint: '/api/v1/agentbook-tax/reports/trial-balance',
  },
];

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

/**
 * QA-P3-002: every report card fetched data successfully but rendered
 * nothing — `setReportData` stored the raw `{success, data: {...}}` envelope
 * directly, and none of `sections`/`rows`/`net_income` exist on that outer
 * object (each report's real shape lives one level deeper, with its own
 * field names), so `renderReportContent` always rendered an empty
 * `<div>`. This maps each report's actual API response into the ReportData
 * shape the render logic expects.
 */
function transformReport(key: string, json: { success: boolean; data?: any; error?: string }): ReportData {
  if (!json.success || !json.data) {
    return { title: 'Error', rows: [{ label: json.error || 'Failed to load report data', amount: 0 }] };
  }
  const d = json.data;
  const toRows = (items: Array<{ name: string; amountCents?: number; balanceCents?: number }>): ReportRow[] =>
    items.map((i) => ({ label: i.name, amount: (i.amountCents ?? i.balanceCents ?? 0) / 100 }));

  switch (key) {
    case 'pnl':
      return {
        title: 'Profit & Loss',
        sections: [
          { heading: 'Revenue', rows: toRows(d.revenue ?? []) },
          { heading: 'Expenses', rows: toRows(d.expenses ?? []) },
        ],
        net_income: (d.netIncomeCents ?? 0) / 100,
      };
    case 'balance-sheet':
      return {
        title: 'Balance Sheet',
        sections: [
          { heading: 'Assets', rows: [...toRows(d.assets ?? []), { label: 'Total Assets', amount: (d.totalAssetsCents ?? 0) / 100 }] },
          { heading: 'Liabilities', rows: [...toRows(d.liabilities ?? []), { label: 'Total Liabilities', amount: (d.totalLiabilitiesCents ?? 0) / 100 }] },
          { heading: 'Equity', rows: [...toRows(d.equity ?? []), { label: 'Total Equity', amount: (d.totalEquityCents ?? 0) / 100 }] },
        ],
      };
    case 'cashflow':
      return {
        title: 'Cash Flow',
        rows: [
          ...(d.months ?? []).map((m: { month: string; netCents: number }) => ({ label: m.month, amount: m.netCents / 100 })),
          { label: 'Total Net Cash Flow', amount: (d.totalNetCents ?? 0) / 100 },
        ],
      };
    case 'trial-balance':
      return {
        title: 'Trial Balance',
        rows: [
          ...(d.lines ?? []).map((l: { name: string; debitCents: number; creditCents: number }) => ({
            label: l.name,
            amount: (l.debitCents - l.creditCents) / 100,
          })),
          { label: 'Difference (should be $0)', amount: ((d.totalDebitCents ?? 0) - (d.totalCreditCents ?? 0)) / 100 },
        ],
      };
    default:
      return { title: 'Report', rows: [] };
  }
}

export const ReportsPage: React.FC = () => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reportData, setReportData] = useState<Record<string, ReportData>>({});
  const [loadingReport, setLoadingReport] = useState<string | null>(null);

  const toggleReport = async (key: string, endpoint: string) => {
    if (expanded === key) {
      setExpanded(null);
      return;
    }

    setExpanded(key);

    if (reportData[key]) return;

    setLoadingReport(key);
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error('Failed to load report');
      const json = await res.json();
      setReportData((prev) => ({ ...prev, [key]: transformReport(key, json) }));
    } catch {
      setReportData((prev) => ({
        ...prev,
        [key]: { title: 'Error', rows: [{ label: 'Failed to load report data', amount: 0 }] },
      }));
    } finally {
      setLoadingReport(null);
    }
  };

  const renderTable = (rows: ReportRow[], highlight?: boolean) => (
    <div className="divide-y" style={{ borderColor: 'var(--border-primary, #e5e7eb)' }}>
      {rows.map((row, i) => (
        <div
          key={i}
          className={`flex items-center justify-between py-2.5 px-1 ${
            highlight && i === rows.length - 1 ? 'font-bold' : ''
          }`}
        >
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {row.label}
          </span>
          <span
            className={`text-sm font-medium ${row.amount < 0 ? 'text-red-600' : ''}`}
            style={row.amount >= 0 ? { color: 'var(--text-primary)' } : undefined}
          >
            {formatCurrency(row.amount)}
          </span>
        </div>
      ))}
    </div>
  );

  const renderReportContent = (data: ReportData) => {
    return (
      <div className="space-y-4">
        {data.sections?.map((section, i) => (
          <div key={i}>
            <h4 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
              {section.heading}
            </h4>
            {renderTable(section.rows)}
          </div>
        ))}
        {data.rows && !data.sections && renderTable(data.rows, true)}
        {data.net_income !== undefined && (
          <div
            className="flex items-center justify-between pt-3 mt-2 border-t-2"
            style={{ borderColor: 'var(--border-primary, #e5e7eb)' }}
          >
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              Net Income
            </span>
            <span className={`text-base font-bold ${data.net_income >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatCurrency(data.net_income)}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Financial Reports
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate and view financial reports for your business
        </p>
      </div>

      {/* PR 45 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="show me my P&L for this quarter" />

      <div className="space-y-4">
        {REPORTS.map((report) => {
          const isExpanded = expanded === report.key;
          const data = reportData[report.key];
          const isLoading = loadingReport === report.key;

          return (
            <div
              key={report.key}
              className="rounded-xl border overflow-hidden transition-shadow hover:shadow-md"
              style={{ backgroundColor: 'var(--bg-primary, #fff)', borderColor: 'var(--border-primary, #e5e7eb)' }}
            >
              <button
                onClick={() => toggleReport(report.key, report.endpoint)}
                className="w-full flex items-center gap-4 p-4 sm:p-5 text-left"
              >
                <div className={`p-3 rounded-xl ${report.color}`}>
                  {report.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
                    {report.title}
                  </h3>
                  <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {report.description}
                  </p>
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>
                  {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </div>
              </button>

              {isExpanded && (
                <div
                  className="px-4 sm:px-5 pb-5 border-t"
                  style={{ borderColor: 'var(--border-primary, #e5e7eb)' }}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent-emerald)' }} />
                    </div>
                  ) : data ? (
                    <div className="pt-4">
                      {renderReportContent(data)}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ReportsPage;
