'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/hooks/use-t';
import { SNAPSHOT_CLEARED_EVENT } from '@/lib/mobile/snapshot-keys';
import { runAutoCategorize } from '../../_lib/api';
import { getPendingSuggestions, type PendingSuggestion } from '../../_lib/api-extra';
import { readJson, writeJson } from '../../_lib/safe-storage';
import { Banner, useToast, buttonStyle, tokens } from '../../_kit';
import { ReviewSheet } from './ReviewSheet';

/** Under the `ab:mobile:` prefix, so sign-out / owner change purges it with the snapshots. */
export const LAST_AUTOCAT_KEY = 'ab:mobile:docs:last-autocat';
const RUN_TTL_MS = 24 * 60 * 60 * 1000;

interface LastRun { appliedCount: number; pendingCount: number; skippedCount: number; at: number }

function readLastRun(): LastRun | null {
  const r = readJson<LastRun | null>('local', LAST_AUTOCAT_KEY, null);
  return r && typeof r.appliedCount === 'number' && typeof r.at === 'number' && Date.now() - r.at < RUN_TTL_MS ? r : null;
}

export function AiBanner({ noCategoryCount, online, currency, onChanged }: {
  noCategoryCount: number; online: boolean; currency: string | null; onChanged: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [pending, setPending] = useState<PendingSuggestion[]>([]);
  const [lastRun, setLastRun] = useState<LastRun | null>(() => readLastRun());
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  // Only the newest load may write: a slow earlier response must not bring back a row that was just resolved.
  const loadSeq = useRef(0);

  const loadPending = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const { items } = await getPendingSuggestions();
      if (seq === loadSeq.current) setPending(items);
    } catch {
      if (seq === loadSeq.current) setPending([]); // unknown → show no "need you" count rather than a stale one
    }
  }, []);

  // Offline, the service worker may answer this GET from its cache with no
  // marker, so the list could contain rows that are already categorized: don't
  // ask until the connection is back (and ask again then).
  useEffect(() => {
    if (online) void loadPending();
  }, [online, loadPending]);

  // Sign-out / account change while mounted: drop what belongs to the previous user.
  useEffect(() => {
    const onCleared = () => { loadSeq.current += 1; setPending([]); setLastRun(null); setOpen(false); };
    window.addEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
  }, []);

  async function run() {
    if (running || !online) return;
    setRunning(true);
    try {
      const r = await runAutoCategorize();
      const nothing = r.appliedCount === 0 && r.pendingCount === 0;
      // The server dedupes runs for ~20h and answers zeros. That is not a run, so
      // it must not overwrite the counts of the last real one.
      if (!nothing) {
        const rec: LastRun = { ...r, at: Date.now() };
        writeJson('local', LAST_AUTOCAT_KEY, rec);
        setLastRun(rec);
      }
      toast.show(
        nothing ? t('mobile.docs.autocat_nothing') : t('mobile.docs.autocat_done', { applied: r.appliedCount, pending: r.pendingCount }),
        { tone: 'good' },
      );
      await loadPending();
      onChanged();
    } catch {
      toast.show(t('mobile.docs.autocat_failed'), { tone: 'critical' });
    } finally {
      setRunning(false);
    }
  }

  const m = pending.length;
  const n = lastRun?.appliedCount ?? null;
  let title: string | null = null;
  if (n !== null) title = t('mobile.docs.ai_summary', { n, m });
  else if (m > 0) title = t('mobile.docs.ai_pending', { m });
  else if (noCategoryCount > 0) title = t('mobile.docs.ai_idle', { k: noCategoryCount });

  const actions = (
    <div style={{ display: 'flex', gap: tokens.space.sm, flexWrap: 'wrap' }}>
      <button type="button" style={buttonStyle('secondary', m === 0 || !online)} disabled={m === 0 || !online} onClick={() => setOpen(true)}>
        {t('mobile.docs.review_ai_picks')}
      </button>
      <button type="button" style={buttonStyle('secondary', running || !online)} disabled={running || !online} aria-busy={running} onClick={() => void run()}>
        {running ? t('mobile.docs.auto_categorizing') : t('mobile.docs.auto_categorize')}
      </button>
    </div>
  );

  return (
    <>
      {title !== null && (
        <Banner severity="info" title={title} body={online ? undefined : t('mobile.docs.offline_readonly')} action={actions} />
      )}
      {/* Stays mounted when the banner hides: accepting the last pick must not unmount the open sheet. */}
      <ReviewSheet
        open={open}
        onClose={() => setOpen(false)}
        items={pending}
        currency={currency}
        online={online}
        onResolved={(ids) => {
          loadSeq.current += 1;
          setPending((p) => p.filter((s) => !ids.includes(s.expenseId)));
          onChanged();
        }}
      />
    </>
  );
}
