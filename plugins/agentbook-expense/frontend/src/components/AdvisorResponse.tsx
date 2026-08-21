import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Sparkles, X } from 'lucide-react';
import { useI18n } from '@naap/plugin-sdk';
import { useTenantCurrency } from '../hooks/useTenantCurrency';

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899'];

/**
 * Builds a compact-money formatter bound to a locale and currency.
 *
 * A FACTORY, not a 3-arg function. The result is handed to Recharts as
 * `tickFormatter={...}`, and Recharts invokes it as `(value, index)` — so a
 * third parameter receives the tick INDEX, and `currency` arrives undefined.
 * Intl then throws "Currency code is required with currency style" on every
 * tick, which crashes the chart. An earlier version of this file had exactly
 * that shape.
 *
 * Replaces `v >= 1000 ? `$${(v/1000).toFixed(1)}K` : ...`, which hardcoded the
 * dollar sign, ignored the locale, and assumed thousands-grouping. zh-CN groups
 * by 万 (10^4): 1234567 cents is "¥123.5万", not "¥1.2M" — not a preference but
 * how the number is read.
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

// Lightweight markdown-to-JSX renderer
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key++} className="my-1.5 ml-4 space-y-0.5">
          {listItems.map((item, i) => <li key={i} className="list-disc text-sm text-foreground leading-relaxed">{inlineFormat(item)}</li>)}
        </ul>
      );
      listItems = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // List items: - or * or numbered
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''));
      continue;
    }

    flushList();

    if (!trimmed) {
      elements.push(<div key={key++} className="h-2" />);
      continue;
    }

    // Headers
    if (trimmed.startsWith('### ')) {
      elements.push(<h4 key={key++} className="text-sm font-semibold text-foreground mt-2 mb-1">{inlineFormat(trimmed.slice(4))}</h4>);
    } else if (trimmed.startsWith('## ')) {
      elements.push(<h3 key={key++} className="text-sm font-bold text-foreground mt-2.5 mb-1">{inlineFormat(trimmed.slice(3))}</h3>);
    } else if (trimmed.startsWith('# ')) {
      elements.push(<h2 key={key++} className="text-base font-bold text-foreground mt-3 mb-1.5">{inlineFormat(trimmed.slice(2))}</h2>);
    } else {
      elements.push(<p key={key++} className="text-sm text-foreground leading-relaxed">{inlineFormat(trimmed)}</p>);
    }
  }
  flushList();
  return elements;
}

// Inline formatting: **bold**, *italic*, `code`, $amounts
function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // **bold**
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
      parts.push(<strong key={key++} className="font-semibold">{boldMatch[2]}</strong>);
      remaining = boldMatch[3];
      continue;
    }

    // *italic*
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*(.*)/s);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(<span key={key++}>{italicMatch[1]}</span>);
      parts.push(<em key={key++}>{italicMatch[2]}</em>);
      remaining = italicMatch[3];
      continue;
    }

    // `code`
    const codeMatch = remaining.match(/^(.*?)`(.+?)`(.*)/s);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<span key={key++}>{codeMatch[1]}</span>);
      parts.push(<code key={key++} className="px-1 py-0.5 rounded bg-muted text-xs font-mono">{codeMatch[2]}</code>);
      remaining = codeMatch[3];
      continue;
    }

    // No more matches
    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export const AdvisorResponse: React.FC<{
  answer: string;
  chartData?: { type: string; data: { name: string; value: number }[] } | null;
  actions?: { label: string; type: string }[];
  onDismiss: () => void;
  onAsk: (q: string) => void;
}> = ({ answer, chartData, actions, onDismiss, onAsk }) => {
  const { locale, t } = useI18n();
  const currency = useTenantCurrency();
  const fmtK = makeFmtK(locale, currency);
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4 relative">
      <button onClick={onDismiss} className="absolute top-3 right-3 p-1 rounded-md hover:bg-muted transition-colors">
        <X className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0 pr-6">
          <p className="text-xs font-semibold text-primary mb-1.5">{t('expenses_ui.expense_advisor')}</p>
          <div className="space-y-0.5">{renderMarkdown(answer)}</div>

          {chartData && chartData.data && chartData.data.length > 0 && (
            <div className="mt-3 bg-muted/30 rounded-lg p-3 border border-border/50">
              <div className="h-[140px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData.data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={fmtK} width={40} />
                    <Tooltip formatter={(v: number) => ['$' + (v/100).toLocaleString(), '']} />
                    <Bar dataKey="value" radius={[3, 3, 0, 0]} barSize={18}>
                      {chartData.data.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {actions && actions.length > 0 && (
            <div className="flex gap-1.5 mt-3 flex-wrap">
              {actions.map((a, i) => (
                <button key={i} onClick={() => onAsk(a.label)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-muted/50 text-muted-foreground border border-border/50 hover:text-foreground transition-colors">
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
