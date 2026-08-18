import React from 'react';
import { AttentionItem } from './AttentionItem';
import type { AttentionItem as Item, AgentSummary } from './types';
import { useI18n } from '@naap/plugin-sdk';

interface Props { items: Item[]; summary: AgentSummary | null; }

export const AttentionPanel: React.FC<Props> = ({ items, summary }) => {
  const { t } = useI18n();
  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">{t('dashboard.needs_attention')}</h2>
      {summary && (
        <p className="text-sm text-foreground mb-3 leading-relaxed">{summary.summary}</p>
      )}
      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-muted/20 p-4 text-center">
          <p className="text-sm text-muted-foreground">All clear ☕</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(it => <AttentionItem key={it.id} item={it} />)}
        </div>
      )}
    </section>
  );
};
