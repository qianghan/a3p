'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MobileAlert } from '@/lib/mobile/types';
import { useT, useShellLocale } from '@/hooks/use-t';
import { Banner } from '../_kit/Banner';
import { Button } from '../_kit/Button';
import { buttonStyle, iconButtonStyle } from '../_kit/styles';
import { moneyText } from '../_kit/Money';
import { tokens, TOUCH, toneColors, severityTone } from '../_kit/tokens';
import { alertCopy } from '../_lib/alert-copy';
import type { AlertActions } from './useAlertAction';

export const MAX_ALERTS = 5;
/** A horizontal travel shorter than this is a tap or a wobble, not a swipe. */
const SWIPE_PX = 40;

const DOT_BUTTON: React.CSSProperties = {
  minWidth: TOUCH,
  minHeight: TOUCH,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
};

/**
 * The Home alert banners, one card at a time.
 *
 * Ranking (critical > warn > info) is the server's; the client only caps. The
 * card changes ONLY on a user gesture — swipe, a dot, or prev/next (the
 * keyboard / screen-reader alternative to swiping) — so the slide region is
 * aria-live="polite": each change is announced once, never interrupting.
 *
 * Touch: only a mostly-horizontal drag past SWIPE_PX changes the card. A
 * vertical drag is left entirely to usePullToRefresh (which arms only on a
 * downward drag); nothing here stops propagation or prevents default.
 *
 * Nothing animates, so prefers-reduced-motion holds by construction.
 */
export function AlertCarousel({ alerts, currency, actions }: { alerts: MobileAlert[]; currency: string; actions: AlertActions }) {
  const t = useT();
  const locale = useShellLocale();
  const list = alerts.slice(0, MAX_ALERTS);
  // Remember WHICH alert is shown, so a reload that reorders the list keeps it in view.
  const [shown, setShown] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const start = useRef<{ x: number; y: number } | null>(null);

  if (list.length === 0) return null;
  const byId = shown.id === null ? -1 : list.findIndex((a) => a.id === shown.id);
  const at = byId >= 0 ? byId : Math.min(shown.index, list.length - 1);
  const current = list[at];
  const total = list.length;
  const go = (i: number) => {
    const next = Math.min(Math.max(i, 0), total - 1);
    setShown({ id: list[next].id, index: next });
  };

  const copy = alertCopy(current, t, (cents) => moneyText(cents, currency, locale));

  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0];
    start.current = p ? { x: p.clientX, y: p.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const from = start.current;
    start.current = null;
    const p = e.changedTouches[0];
    if (!from || !p) return;
    const dx = p.clientX - from.x;
    const dy = p.clientY - from.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
    go(dx < 0 ? at + 1 : at - 1);
  };
  const onTouchCancel = () => {
    start.current = null;
  };

  let action: React.ReactNode = null;
  if (current.action && copy.actionLabel) {
    const reminded = actions.isDone(current.id);
    const busy = actions.isPending(current.id);
    action = (
      <Button
        variant="primary"
        data-alert-action="post"
        aria-busy={busy || undefined}
        // aria-disabled, not disabled: a disabled button drops keyboard focus to <body> mid-flow.
        aria-disabled={reminded || busy || undefined}
        style={reminded || busy ? { opacity: 0.6, cursor: 'default' } : undefined}
        onClick={() => {
          if (!reminded && !busy) void actions.run(current);
        }}
      >
        {reminded ? t('mobile.home.action.logged') : copy.actionLabel}
      </Button>
    );
  } else if (copy.href && copy.actionLabel) {
    action = (
      <Link href={copy.href} data-alert-action="link" style={buttonStyle('secondary')}>
        {copy.actionLabel}
      </Link>
    );
  }

  return (
    <section aria-label={t('mobile.home.alerts_label')} aria-roledescription={t('mobile.home.carousel_role')} style={{ marginBottom: tokens.space.md }}>
      <div aria-live="polite">
        <div
          role="group"
          aria-roledescription={t('mobile.home.slide_role')}
          aria-label={t('mobile.home.alert_position', { index: at + 1, total })}
          data-testid="alert-carousel"
          data-alert-id={current.id}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
        >
          <Banner severity={current.severity} title={copy.title} action={action} />
        </div>
      </div>
      {total > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <button
            type="button"
            aria-label={t('mobile.home.alert_prev')}
            aria-disabled={at === 0 || undefined}
            onClick={() => at > 0 && go(at - 1)}
            style={{ ...iconButtonStyle(), opacity: at === 0 ? 0.4 : 1, cursor: at === 0 ? 'default' : 'pointer' }}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          {/* Wraps rather than overflowing on a 320px screen with five 44px dots. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', minWidth: 0 }}>
            {list.map((a, i) => (
              <button
                key={a.id}
                type="button"
                aria-label={t('mobile.home.alert_dot', { index: i + 1, total })}
                aria-current={i === at ? 'true' : undefined}
                onClick={() => go(i)}
                style={DOT_BUTTON}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'block',
                    width: i === at ? 18 : 8,
                    height: 8,
                    borderRadius: tokens.radius.pill,
                    background: i === at ? toneColors(severityTone(a.severity)).accent : tokens.color.border,
                  }}
                />
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={t('mobile.home.alert_next')}
            aria-disabled={at === total - 1 || undefined}
            onClick={() => at < total - 1 && go(at + 1)}
            style={{ ...iconButtonStyle(), opacity: at === total - 1 ? 0.4 : 1, cursor: at === total - 1 ? 'default' : 'pointer' }}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
