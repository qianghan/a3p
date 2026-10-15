'use client';

import React, { useState } from 'react';
import { CloudOff } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { Pill, Sheet, tokens, useToast } from '../../_kit';
import { useOfflineQueue } from '../../_lib/offline';
import { Amount } from '../../docs/_components/Amount';

const btn: React.CSSProperties = { minHeight: 44, minWidth: 44, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--foreground)', fontSize: 14 };

export function QueuePill({ currency }: { currency: string | null }) {
  const t = useT();
  const toast = useToast();
  const { count, items, busy, retry, discard } = useOfflineQueue();
  const [open, setOpen] = useState(false);
  if (count === 0) return null;

  // lastError is a machine code stored by the replay (offline-queue.ts / sw.js). Turn each into a sentence the user
  // can act on; never print the raw code inside a translated sentence. Literal keys only (the dynamic-key guard).
  function errorLine(reason: string): string {
    switch (reason) {
      case 'unauthorized': return t('mobile.capture.queue_error_unauthorized');
      case 'file_too_large': return t('mobile.capture.queue_error_too_large');
      case 'unreadable': return t('mobile.capture.queue_error_unreadable');
      default: return t('mobile.capture.queue_item_error', { status: reason.replace(/^http_/, '') });
    }
  }

  async function onRetry() {
    try {
      const r = await retry();
      toast.show(t('mobile.capture.queue_retry_done', { sent: r.sent, remaining: r.remaining }), { tone: r.remaining ? 'neutral' : 'good' });
      if (!r.remaining) setOpen(false);
    } catch {
      toast.show(t('mobile.capture.save_failed'), { tone: 'critical' });
    }
  }

  return (
    <>
      <button type="button" data-testid="queue-pill" onClick={() => setOpen(true)}
        style={{ minHeight: 44, border: 'none', background: 'transparent', padding: 0, display: 'inline-flex', alignItems: 'center' }}>
        <Pill tone="warn"><CloudOff aria-hidden="true" style={{ width: 14, height: 14, verticalAlign: -2, marginRight: 4 }} />{t('mobile.capture.queue_pill', { n: count })}</Pill>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('mobile.capture.queue_title')}>
        {items.length === 0 ? (
          <p>{t('mobile.capture.queue_empty')}</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {items.map((it) => {
              const kind = it.store === 'receipt' ? t('mobile.capture.queue_item_receipt') : t('mobile.capture.queue_item_expense');
              const label = it.label || kind;
              return (
                <li key={`${it.store}:${it.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, display: 'grid', gap: 2 }}>
                    <span style={{ fontWeight: 500 }}>{label}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{kind}</span>
                    {it.lastError && (
                      <span style={{ fontSize: 12, color: tokens.color.critical }}>
                        {errorLine(it.lastError)}
                      </span>
                    )}
                  </span>
                  {it.amountCents != null && <Amount cents={it.amountCents} currency={currency} />}
                  <button type="button" style={btn} aria-label={t('mobile.capture.queue_discard_for', { item: label })}
                    onClick={() => void discard(it.store, it.id)}>{t('mobile.capture.queue_discard')}</button>
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" style={{ ...btn, width: '100%', marginTop: 12, fontWeight: 600 }} disabled={busy} onClick={() => void onRetry()}>
          {t('mobile.capture.queue_retry')}
        </button>
      </Sheet>
    </>
  );
}
