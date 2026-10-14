'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useT } from '@/hooks/use-t';
import type { ReviewItem } from '@/lib/mobile/types';
import { MAX_REVIEW_ITEMS, reviewSuggestions } from '../../_lib/api';
import type { PendingSuggestion } from '../../_lib/api-extra';
import { Sheet, Pill, buttonStyle, tokens } from '../../_kit';
import { Amount } from './Amount';

/**
 * A row the server no longer has a pick for: already categorized, deleted, or
 * its suggestion consumed elsewhere. Nothing is left to accept, so the row is
 * dropped rather than shown as an error.
 */
const STALE_RESULT = new Set(['not_found', 'no_suggestion']);
/**
 * An HTTP answer meaning "that expense is already resolved". Not 404: the route
 * reports a missing expense per item (`not_found`), so a 404 on the request
 * itself means the route is missing (a deploy mismatch) and nothing was saved.
 */
const isStaleStatus = (e: unknown): boolean => (e as { status?: unknown } | null)?.status === 409;

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export function ReviewSheet({ open, onClose, items, currency, online = true, onResolved }: {
  open: boolean;
  onClose: () => void;
  items: PendingSuggestion[];
  currency: string | null;
  /**
   * The service worker can answer the pending-picks GET from its cache while
   * offline, so what is listed here may already be done. Writes stay off until
   * the connection is back.
   */
  online?: boolean;
  onResolved: (ids: string[]) => void;
}) {
  const t = useT();
  // Rows hidden while their request is in flight. Cleared when it settles: the
  // parent removes resolved rows from `items`, failed rows simply come back.
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // The outcome of the last action, announced from INSIDE the aria-modal dialog
  // (a toast renders outside it, where assistive tech cannot reach). It is also
  // the stable focus target: the row that was tapped is gone once it resolves.
  const [status, setStatus] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setStatus(null); }, [open]);
  const visible = items.filter((i) => !inFlight.has(i.expenseId));
  const locked = busy || !online;

  async function submit(batch: ReviewItem[]) {
    if (busyRef.current || batch.length === 0) return;
    busyRef.current = true;
    setStatus(null);
    // Before the tapped row is hidden below: a focused element that unmounts drops focus to <body>.
    statusRef.current?.focus();
    const ids = batch.map((b) => b.expenseId);
    setInFlight((prev) => new Set([...prev, ...ids])); // optimistic
    setBusy(true);
    const resolved: string[] = [];
    const failed: string[] = [];
    try {
      const groups = chunk(batch, MAX_REVIEW_ITEMS);
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        try {
          const results = await reviewSuggestions(group);
          for (const item of group) {
            const r = results.find((x) => x.expenseId === item.expenseId);
            if (r?.ok || (r && r.error && STALE_RESULT.has(r.error))) resolved.push(item.expenseId);
            else failed.push(item.expenseId);
          }
        } catch (e) {
          if (isStaleStatus(e)) {
            resolved.push(...group.map((i) => i.expenseId));
          } else {
            // The connection is likely gone: don't fire the remaining groups.
            for (const rest of groups.slice(g)) failed.push(...rest.map((i) => i.expenseId));
            break;
          }
        }
      }
      if (failed.length) {
        setStatus({ tone: 'critical', text: batch.length === 1 ? t('mobile.docs.review_failed') : t('mobile.docs.review_partial', { failed: failed.length }) });
      } else if (resolved.length) {
        setStatus({ tone: 'good', text: t('mobile.docs.review_resolved', { count: resolved.length }) });
      }
      if (resolved.length) onResolved(resolved);
    } finally {
      setInFlight((prev) => { const n = new Set(prev); ids.forEach((id) => n.delete(id)); return n; });
      busyRef.current = false;
      setBusy(false);
    }
  }

  const rowButton = (extra: React.CSSProperties = {}): React.CSSProperties => ({ ...buttonStyle('secondary', locked), fontSize: tokens.font.sm, ...extra });
  // aria-disabled, not disabled: a disabled button drops keyboard focus to <body> mid-flow.
  const lockProps = { 'aria-disabled': locked || undefined, 'aria-busy': busy || undefined } as const;
  const press = (batch: ReviewItem[]) => { if (!locked) void submit(batch); };

  return (
    <Sheet open={open} onClose={onClose} title={t('mobile.docs.review_title')}>
      {!online && (
        <p role="status" style={{ margin: `0 0 ${tokens.space.md}px`, color: tokens.color.muted, fontSize: tokens.font.sm }}>
          {t('mobile.docs.offline_readonly')}
        </p>
      )}
      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        data-testid="review-status"
        style={{
          outline: 'none',
          fontSize: tokens.font.sm,
          color: status?.tone === 'critical' ? tokens.color.critical : tokens.color.muted,
          ...(status ? { margin: `0 0 ${tokens.space.md}px` } : null),
        }}
      >
        {status?.text}
      </div>
      {visible.length === 0 ? (
        <p style={{ color: tokens.color.muted, padding: `${tokens.space.sm}px 0` }}>{t('mobile.docs.review_empty')}</p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: tokens.space.md }}>
            {visible.map((s) => {
              const vendor = s.vendorName || s.description || t('mobile.docs.untitled');
              return (
                <li
                  key={s.expenseId}
                  data-testid="review-row"
                  style={{ border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.space.md, display: 'grid', gap: tokens.space.sm }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.space.sm }}>
                    <span style={{ fontWeight: 500 }}>{vendor}</span>
                    <span style={{ fontWeight: 600 }}><Amount cents={s.amountCents} currency={currency} /></span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flexWrap: 'wrap' }}>
                    <span>{t('mobile.docs.suggested', { category: s.suggestedCategoryName })}</span>
                    <Pill tone="primary">{t('mobile.docs.confidence', { pct: Math.round(s.confidence * 100) })}</Pill>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.space.sm }}>
                    <button
                      type="button"
                      style={{ ...buttonStyle('primary', locked), fontSize: tokens.font.sm }}
                      {...lockProps}
                      aria-label={t('mobile.docs.accept_for', { category: s.suggestedCategoryName, vendor })}
                      // Bare accept: the server applies ITS stored suggestion and keeps its stale-accept guard.
                      // An explicit categoryId would bypass the guard and overwrite a category chosen since this list loaded.
                      onClick={() => press([{ expenseId: s.expenseId, action: 'accept' }])}
                    >
                      {t('mobile.docs.accept')}
                    </button>
                    <button
                      type="button"
                      style={rowButton()}
                      {...lockProps}
                      aria-label={t('mobile.docs.reject_for', { category: s.suggestedCategoryName, vendor })}
                      onClick={() => press([{ expenseId: s.expenseId, action: 'reject' }])}
                    >
                      {t('mobile.docs.reject')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            style={{ ...buttonStyle('primary', locked), width: '100%', marginTop: tokens.space.md }}
            {...lockProps}
            onClick={() => press(visible.map((s) => ({ expenseId: s.expenseId, action: 'accept' as const })))}
          >
            {t('mobile.docs.accept_all')}
          </button>
        </>
      )}
    </Sheet>
  );
}
