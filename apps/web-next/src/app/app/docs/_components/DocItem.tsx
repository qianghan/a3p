'use client';
import React from 'react';
import Link from 'next/link';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { MobileDoc } from '@/lib/mobile/types';
import { Pill, tokens, TOUCH } from '../../_kit';
import { formatDocDate, isPdfUrl } from '../../_lib/format';
import { DocThumb } from './DocThumb';
import { Amount } from './Amount';

const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * One row (or grid tile). The thumbnail tiles for "no receipt" and PDF are
 * aria-hidden icons, so the row says so in its own text — for screen readers
 * and for anyone who cannot tell a grey icon from a photo.
 */
export function DocItem({ doc, view, currency }: { doc: MobileDoc; view: 'list' | 'grid'; currency: string | null }) {
  const t = useT();
  const locale = useShellLocale();
  const title = doc.vendorName || doc.description || t('mobile.docs.untitled');
  const category = doc.categoryName ?? t('mobile.docs.no_category');
  const receiptText = !doc.receiptUrl ? t('mobile.docs.row_no_receipt') : isPdfUrl(doc.receiptUrl) ? t('mobile.kit.pdf_receipt') : null;
  const tags = (doc.categorySource === 'ai' || doc.status === 'pending_review' || doc.archivedAt || receiptText) ? (
    <span style={{ display: 'inline-flex', gap: tokens.space.xs, flexWrap: 'wrap', alignItems: 'center' }}>
      {doc.categorySource === 'ai' && <Pill tone="primary">{t('mobile.docs.ai_pill')}</Pill>}
      {doc.status === 'pending_review' && <Pill tone="warn">{t('mobile.docs.review_pill')}</Pill>}
      {doc.archivedAt && <Pill tone="neutral">{t('mobile.docs.archived_pill')}</Pill>}
      {receiptText && <span style={{ fontSize: tokens.font.xs, color: tokens.color.muted }}>{receiptText}</span>}
    </span>
  ) : null;
  const href = `/app/docs/${encodeURIComponent(doc.id)}`;
  const common: React.CSSProperties = {
    textDecoration: 'none', color: tokens.color.fg, background: tokens.color.card,
    border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, minHeight: TOUCH,
  };

  if (view === 'grid') {
    return (
      <Link href={href} data-testid="doc-item" style={{ ...common, display: 'grid', gap: tokens.space.xs + 2, padding: tokens.space.sm, justifyItems: 'start', alignContent: 'start', height: '100%', boxSizing: 'border-box' }}>
        <DocThumb src={doc.receiptUrl} size={96} alt="" />
        <span style={{ ...ellipsis, maxWidth: '100%', fontSize: tokens.font.sm, fontWeight: 500 }}>{title}</span>
        <span style={{ fontSize: tokens.font.md, fontWeight: 600 }}><Amount cents={doc.amountCents} currency={currency} /></span>
        <span style={{ ...ellipsis, maxWidth: '100%', fontSize: tokens.font.xs, color: tokens.color.muted }}>{category}</span>
        {tags}
      </Link>
    );
  }
  return (
    <Link href={href} data-testid="doc-item" style={{ ...common, display: 'flex', gap: tokens.space.md, alignItems: 'center', padding: tokens.space.md - 2 }}>
      <DocThumb src={doc.receiptUrl} size={48} alt="" />
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
        <span style={{ ...ellipsis, fontSize: tokens.font.md, fontWeight: 500 }}>{title}</span>
        <span style={{ ...ellipsis, fontSize: tokens.font.sm, color: tokens.color.muted }}>
          {formatDocDate(doc.date, locale)} · {category}
        </span>
        {tags}
      </span>
      <span style={{ fontSize: tokens.font.md, fontWeight: 600, whiteSpace: 'nowrap' }}><Amount cents={doc.amountCents} currency={currency} /></span>
    </Link>
  );
}
