import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid } from 'recharts';
import { Lightbulb } from 'lucide-react';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { useI18n } from '@naap/plugin-sdk';

interface ChartDataPoint {
  name: string;
  value: number;
  previousValue?: number;
  changePercent?: number;
  color?: string;
}

interface ChartProps {
  chartType: 'bar' | 'pie' | 'trend';
  title: string;
  subtitle: string;
  data: ChartDataPoint[];
  annotation: string;
  loading: boolean;
  onTypeChange: (type: 'bar' | 'pie' | 'trend') => void;
}

const FALLBACK_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899', '#ef4444', '#84cc16'];

/**
 * Builds a compact-money formatter bound to a locale and currency.
 *
 * A FACTORY rather than a 3-arg function because the result is handed to
 * Recharts as `tickFormatter={...}`, and Recharts calls it as
 * `(value, index)` — extra parameters would be filled with the tick index.
 *
 * Replaces `v >= 1000 ? `$${(v/1000).toFixed(1)}K` : `$${v.toFixed(0)}``,
 * which had three faults: a literal '$' (wrong currency for a GBP/EUR tenant),
 * no locale ("1.2K" where French reads "1,2 k"), and an assumption of
 * thousands-grouping. That last one is the interesting one: zh-CN groups large
 * numbers by 万 (10^4), so 1234567 cents is "¥123.5万" — not "¥1.2M". A
 * /1000 + 'K' scheme cannot express that at all.
 *
 * trailingZeroDisplay keeps small values as "$45" rather than "$45.0", matching
 * the previous output so existing US tenants see no change.
 */
function makeFmtK(locale: string, currency: string): (cents: number) => string {
  const nf = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
    trailingZeroDisplay: 'stripIfInteger',
  });
  return (cents: number) => nf.format(cents / 100);
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg p-2.5 shadow-lg text-xs">
      <p className="font-semibold text-foreground">{d.name}</p>
      <p className="text-muted-foreground">${(d.value / 100).toLocaleString()}</p>
      {d.previousValue > 0 && <p className="text-muted-foreground">Prev: ${(d.previousValue / 100).toLocaleString()}</p>}
      {d.changePercent != null && (
        <p className={d.changePercent > 0 ? 'text-red-500' : 'text-green-500'}>{d.changePercent > 0 ? '+' : ''}{d.changePercent}%</p>
      )}
    </div>
  );
};

export const AdvisorChart: React.FC<ChartProps> = ({ chartType, title, subtitle, data, annotation, loading, onTypeChange }) => {
  const { locale } = useI18n();
  const currency = useTenantCurrency();
  const fmtK = makeFmtK(locale, currency);
  if (loading) {
    return <div className="bg-card border border-border rounded-xl p-6 mb-4 h-[280px] animate-pulse" />;
  }
  if (!data || data.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 mb-4 text-center">
        <p className="text-sm text-muted-foreground">Record a few more expenses to unlock spending insights.</p>
      </div>
    );
  }

  const chartData = data.map((d, i) => ({ ...d, fill: d.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length] }));

  return (
    <div className="bg-card border border-border rounded-xl p-4 sm:p-5 mb-4">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <div className="flex gap-1">
          {(['bar', 'pie', 'trend'] as const).map(t => (
            <button key={t} onClick={() => onTypeChange(t)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${chartType === t ? 'bg-primary/15 text-primary' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[180px] sm:h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'bar' ? (
            <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={fmtK} width={45} />
              <Tooltip content={<CustomTooltip />} />
              {data.some(d => d.previousValue) && <Bar dataKey="previousValue" fill="#334155" radius={[3, 3, 0, 0]} barSize={16} />}
              <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={20}>
                {chartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          ) : chartType === 'pie' ? (
            <PieChart>
              <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {chartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          ) : (
            <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickFormatter={fmtK} width={45} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} dot={{ r: 4, fill: '#10b981' }} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      {annotation && (
        <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-muted/30">
          <Lightbulb className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">{annotation}</p>
        </div>
      )}
    </div>
  );
};
