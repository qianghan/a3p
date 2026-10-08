'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { tokens } from './tokens';
import { iconButtonStyle } from './styles';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(', ');

/** Focusable, enabled, and actually reachable: not hidden, aria-hidden, display:none or visibility:hidden. */
export function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    for (let node: HTMLElement | null = el; node && node !== panel.parentElement; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}

// ---- Shared modal state -----------------------------------------------------
// Sheets can stack. One document listener serves them all and only the topmost
// reacts; page scroll is locked by the first open sheet and restored by the last
// to close, whatever order they close in.
interface Layer {
  close: () => void;
  panel: () => HTMLElement | null;
}
const layers: Layer[] = [];
let lockCount = 0;
let savedOverflow = '';
// In /app the page itself does not scroll — MobileShell's <main id="mobile-main">
// does — so that is locked too. The element is remembered so the same one is
// restored even if the DOM changed while the sheet was open.
let lockedMain: HTMLElement | null = null;
let savedMainOverflowY = '';

function lockScroll(): void {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    lockedMain = document.getElementById('mobile-main');
    if (lockedMain) {
      savedMainOverflowY = lockedMain.style.overflowY;
      lockedMain.style.overflowY = 'hidden';
    }
  }
  lockCount += 1;
}

function unlockScroll(): void {
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = savedOverflow;
    if (lockedMain) lockedMain.style.overflowY = savedMainOverflowY;
    lockedMain = null;
  }
}

function onDocumentKeyDown(e: KeyboardEvent): void {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    top.close();
    return;
  }
  if (e.key !== 'Tab') return;
  // Keep Tab inside the topmost dialog: wrap at either end.
  const panel = top.panel();
  if (!panel) return;
  const focusable = focusableWithin(panel);
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
}

function pushLayer(layer: Layer): () => void {
  if (layers.length === 0) document.addEventListener('keydown', onDocumentKeyDown);
  layers.push(layer);
  lockScroll();
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    if (layers.length === 0) document.removeEventListener('keydown', onDocumentKeyDown);
    unlockScroll();
  };
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Bottom sheet: modal dialog rendered in a portal on document.body (so a
 * transformed ancestor can't clip it), Escape/backdrop/close-button dismiss,
 * focus in and back out, page scroll locked. No motion, so
 * prefers-reduced-motion is satisfied by construction.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // No document access during render: nothing is rendered until mounted on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    const release = pushLayer({ close: () => onCloseRef.current(), panel: () => panelRef.current });
    panelRef.current?.focus();
    return () => {
      release();
      previous?.focus?.();
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;
  return createPortal(
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
    </div>,
    document.body,
  );
}
