'use client';
import React from 'react';
import { useT } from '@/hooks/use-t';
import type { DocCounts, DocFilter } from '@/lib/mobile/types';
import { Chip, tokens } from '../../_kit';
import { DOC_FILTERS } from '../../_lib/doc-nav';

function countFor(f: DocFilter, c: DocCounts | null): number | undefined {
  if (!c) return undefined;
  switch (f) {
    case 'needs-review': return c.needsReview;
    case 'no-category': return c.noCategory;
    case 'no-receipt': return c.noReceipt;
    case 'archived': return c.archived;
    default: return undefined; // "All" has no badge: the total is not a number anyone needs to clear
  }
}

export function FilterChips({ value, counts, onChange }: { value: DocFilter; counts: DocCounts | null; onChange: (f: DocFilter) => void }) {
  const t = useT();
  // Literal keys at every call: the hygiene guard (and the key scan) can only prove what it can read.
  const label: Record<DocFilter, string> = {
    'needs-review': t('mobile.docs.filter_needs_review'),
    'no-category': t('mobile.docs.filter_no_category'),
    'no-receipt': t('mobile.docs.filter_no_receipt'),
    all: t('mobile.docs.filter_all'),
    archived: t('mobile.docs.filter_archived'),
  };
  return (
    <div
      role="group"
      aria-label={t('mobile.docs.filters_label')}
      style={{ display: 'flex', gap: tokens.space.sm, overflowX: 'auto', padding: `${tokens.space.md}px ${tokens.space.lg}px ${tokens.space.xs}px`, scrollbarWidth: 'none' }}
    >
      {DOC_FILTERS.map((f) => (
        <Chip key={f} label={label[f]} count={countFor(f, counts)} selected={f === value} onClick={() => onChange(f)} />
      ))}
    </div>
  );
}
