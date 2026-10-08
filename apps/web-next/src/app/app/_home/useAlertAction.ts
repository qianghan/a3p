'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileAlert } from '@/lib/mobile/types';
import { useT, type TFn } from '@/hooks/use-t';
import { clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import { ApiError, remindInvoice } from '../_lib/api';
import { useToast } from '../_kit/Toast';

export interface AlertActions {
  /** Runs the alert's in-place action. Never rejects; a repeat call for the same alert while it runs is ignored. */
  run: (alert: MobileAlert) => Promise<void>;
  isPending: (id: string) => boolean;
  isDone: (id: string) => boolean;
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized');
}

/**
 * Our words for a failed action, chosen by the machine code only. The server's
 * message is never shown: it is English, unreviewed, and may be a stack-ish
 * sentence (api.ts keeps it for logs).
 */
function failureCopy(err: unknown, t: TFn): string {
  if (isUnauthorized(err)) return t('mobile.home.toast.action_signed_out');
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === 'rate_limited') return t('mobile.home.toast.action_rate_limited');
  if (code === 'network' || code === 'offline') return t('mobile.home.toast.action_offline');
  return t('mobile.home.toast.action_failed');
}

/**
 * In-place alert actions. Today there is exactly one: Remind on an overdue
 * invoice → POST the alert's endpoint (remindInvoice refuses any other path
 * before fetching).
 *
 * The button flips to "Logged" at once (optimistic — never "Reminded": nothing is delivered), but the toast waits for
 * the server: the remind route only LOGS the reminder (delivered:false — email
 * sending is deferred), so "Reminder logged" is said only once it is true, and
 * nothing ever says it was sent. A failure rolls the button back and says why
 * in our own words. On success the screen reloads so the banner and KPIs show
 * the server's view.
 *
 * On a 401 the session is gone: the stored snapshots are dropped (same rule as
 * useMobileData) and the screen is told to reload once, so it lands in its own
 * signed-out state instead of keeping the previous session's figures on screen.
 */
export function useAlertAction(onDone: () => void): AlertActions {
  const t = useT();
  const toast = useToast();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  // Refs, not state: a double tap lands before React re-renders.
  const inFlight = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  const onDoneRef = useRef(onDone);
  const mounted = useRef(true);

  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (alert: MobileAlert) => {
      const id = alert.id;
      if (!alert.action || alert.action.type !== 'post') return;
      if (inFlight.current.has(id) || completed.current.has(id)) return;
      inFlight.current.add(id);
      completed.current.add(id);
      setPending((s) => new Set(s).add(id));
      setDone((s) => new Set(s).add(id));

      let failure: { err: unknown } | null = null;
      try {
        await remindInvoice(alert.action.endpoint);
      } catch (err) {
        failure = { err };
      }
      inFlight.current.delete(id);

      const signedOut = failure !== null && isUnauthorized(failure.err);
      if (failure) {
        // Signed out: no optimistic state from that session survives.
        if (signedOut) {
          completed.current.clear();
          clearMobileSnapshots('unauthorized');
        } else {
          completed.current.delete(id);
        }
      }
      if (!mounted.current) return;

      setPending((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      if (failure) {
        setDone((s) => {
          if (signedOut) return new Set();
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        toast.show(failureCopy(failure.err, t), { tone: 'critical' });
        if (!signedOut) return;
      } else {
        toast.show(t('mobile.home.toast.reminder_logged'), { tone: 'good' });
      }
      // Reload after success, or once after a 401 so the screen drops the old session's data.
      try {
        onDoneRef.current();
      } catch {
        // The screen's reload is its own concern; the action itself already finished.
      }
    },
    [t, toast],
  );

  return {
    run,
    isPending: (id: string) => pending.has(id),
    isDone: (id: string) => done.has(id),
  };
}
