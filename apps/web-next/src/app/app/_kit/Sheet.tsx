'use client';

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { tokens } from './tokens';
import { iconButtonStyle } from './styles';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/** Bottom sheet: modal dialog, Escape/backdrop/close-button dismiss, focus in and back out, page scroll locked. No motion, so prefers-reduced-motion is satisfied by construction. */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog: wrap at either end.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div data-testid="sheet-backdrop" onClick={onClose} style={{ position: 'absolute', inset: 0, background: tokens.color.scrim }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: 'relative',
          background: tokens.color.card,
          color: tokens.color.cardFg,
          borderTopLeftRadius: tokens.radius.lg,
          borderTopRightRadius: tokens.radius.lg,
          padding: `${tokens.space.md}px ${tokens.space.lg}px calc(${tokens.space.lg}px + env(safe-area-inset-bottom))`,
          maxHeight: '85dvh',
          overflowY: 'auto',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm }}>
          <h2 id={titleId} style={{ fontSize: tokens.font.lg, fontWeight: 600, margin: 0 }}>
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('mobile.kit.close')} style={iconButtonStyle()}>
            <X aria-hidden="true" width={20} height={20} />
          </button>
        </div>
        <div style={{ marginTop: tokens.space.md }}>{children}</div>
      </div>
    </div>
  );
}
