'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { buttonStyle, tokens } from '../../_kit';
import {
  IDENTITY, DOUBLE_TAP_MS, DOUBLE_TAP_DIST_PX, TAP_SLOP_PX, MAX_SCALE, MIN_SCALE, ZOOM_STEP,
  distance, midpoint, pinch, pan, reset, stepZoom, toggleDoubleTap, type Pt, type ZoomState,
} from '../_lib/pinch-zoom';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

interface Gesture { start: ZoomState; startDist: number; startMid: Pt; panFrom: Pt | null }

/**
 * Zoomable receipt image.
 *
 * Lives inside `#mobile-main`, the shell's only scroller, so it must not fight
 * it. `touch-action` is the contract with the browser and is read when a touch
 * STARTS: at 1x it is `pan-y`, so a one-finger drag over the image still scrolls
 * the page (the image is not a scroll trap) while two fingers reach us as a
 * pinch; once zoomed it is `none`, so panning the image never scrolls the page.
 * A browser that takes over a vertical scroll sends `pointercancel`, which ends
 * the gesture cleanly. Zoom in / out / reset are also plain buttons for keyboard
 * and assistive-tech users, who cannot pinch.
 */
export function PinchZoomImage({ src, alt, hint }: { src: string; alt: string; hint: string }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Pt>());
  const downAt = useRef(new Map<number, Pt>());
  /** Pointers that travelled past the tap slop at any point: a finger that wandered and came back is not a tap. */
  const dragged = useRef(new Set<number>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ t: number; p: Pt } | null>(null);
  /** True once two fingers were down together: what follows is not a tap. */
  const multi = useRef(false);
  const [z, setZ] = useState<ZoomState>(IDENTITY);
  // Written synchronously: React may batch pointermove renders, and the next
  // event must build on the latest state, not on the last one that rendered.
  const zRef = useRef<ZoomState>(IDENTITY);
  const [active, setActive] = useState(false);
  const reduced = usePrefersReducedMotion();

  const commit = useCallback((next: ZoomState) => {
    zRef.current = next;
    setZ(next);
  }, []);

  const size = () => {
    const r = boxRef.current?.getBoundingClientRect();
    return { w: r?.width || 1, h: r?.height || 1, left: r?.left ?? 0, top: r?.top ?? 0 };
  };
  const rel = (e: React.PointerEvent): Pt => {
    const { w, h, left, top } = size();
    return { x: e.clientX - left - w / 2, y: e.clientY - top - h / 2 };
  };
  /** Re-base the gesture on whichever pointers remain (a finger joined or left). */
  const begin = () => {
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      gesture.current = { start: zRef.current, startDist: distance(pts[0], pts[1]), startMid: midpoint(pts[0], pts[1]), panFrom: null };
    } else if (pts.length === 1) {
      gesture.current = { start: zRef.current, startDist: 0, startMid: pts[0], panFrom: pts[0] };
    } else {
      gesture.current = null;
    }
  };

  // A different receipt (prev/next reusing this instance) starts un-zoomed.
  useEffect(() => {
    commit(reset());
    pointers.current.clear();
    downAt.current.clear();
    dragged.current.clear();
    gesture.current = null;
    lastTap.current = null;
    multi.current = false;
    setActive(false);
  }, [src, commit]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // right/middle click is not a gesture
    if (!pointers.current.has(e.pointerId) && pointers.current.size >= 2) return; // a third finger is ignored
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // InvalidPointerId / NotFoundError: the gesture still works while the pointer stays over the image,
      // and a pointer that leaves is ended by onPointerLeave below.
    }
    const p = rel(e);
    pointers.current.set(e.pointerId, p);
    downAt.current.set(e.pointerId, p);
    dragged.current.delete(e.pointerId);
    if (pointers.current.size >= 2) {
      multi.current = true;
      lastTap.current = null;
    }
    setActive(true);
    begin();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const here = rel(e);
    pointers.current.set(e.pointerId, here);
    const from = downAt.current.get(e.pointerId);
    if (from && distance(from, here) >= TAP_SLOP_PX) dragged.current.add(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    const { w, h } = size();
    const pts = [...pointers.current.values()];
    if (pts.length >= 2 && g.startDist > 0) {
      commit(pinch(g.start, g.startDist, g.startMid, distance(pts[0], pts[1]), midpoint(pts[0], pts[1]), w, h));
    } else if (pts.length === 1 && g.panFrom) {
      commit(pan(g.start, pts[0].x - g.panFrom.x, pts[0].y - g.panFrom.y, w, h));
    }
  };

  /** A pointer is done. `asTap` is true only for a genuine pointerup. */
  const finish = (e: React.PointerEvent<HTMLDivElement>, asTap: boolean) => {
    const down = downAt.current.get(e.pointerId);
    if (!pointers.current.has(e.pointerId)) return; // an ignored third finger, or already ended
    pointers.current.delete(e.pointerId);
    downAt.current.delete(e.pointerId);
    const wandered = dragged.current.delete(e.pointerId);
    if (asTap && !multi.current && down) {
      const up = rel(e);
      if (!wandered && distance(down, up) < TAP_SLOP_PX) {
        const now = Date.now();
        const prev = lastTap.current;
        if (prev && now - prev.t < DOUBLE_TAP_MS && distance(prev.p, up) < DOUBLE_TAP_DIST_PX) {
          const { w, h } = size();
          commit(toggleDoubleTap(zRef.current, up, w, h));
          lastTap.current = null;
        } else {
          lastTap.current = { t: now, p: up };
        }
      } else {
        lastTap.current = null;
      }
    } else if (!asTap) {
      lastTap.current = null;
    }
    if (pointers.current.size === 0) {
      multi.current = false;
      setActive(false);
    }
    begin();
  };

  const apply = (next: (s: ZoomState, w: number, h: number) => ZoomState) => {
    const { w, h } = size();
    lastTap.current = null;
    commit(next(zRef.current, w, h));
  };
  const atMax = z.scale >= MAX_SCALE;
  const atMin = z.scale <= MIN_SCALE;
  const zoomed = !atMin;

  const btn = (disabled: boolean): React.CSSProperties => ({ ...buttonStyle('secondary', disabled), padding: 0 });

  return (
    <div data-testid="pinch-zoom-root" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      <div style={{ position: 'relative' }}>
        <div
          ref={boxRef}
          data-testid="pinch-zoom"
          role="img"
          aria-label={alt}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, true)}
          onPointerCancel={(e) => finish(e, false)}
          onPointerLeave={(e) => finish(e, false)}
          onLostPointerCapture={(e) => finish(e, false)}
          style={{
            position: 'relative', width: '100%', height: 'min(60dvh, 480px)', overflow: 'hidden',
            touchAction: zoomed ? 'none' : 'pan-y', overscrollBehavior: 'contain',
            borderRadius: tokens.radius.md, background: tokens.color.card, border: `1px solid ${tokens.color.border}`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            draggable={false}
            data-testid="pinch-zoom-img"
            style={{
              width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none', pointerEvents: 'none',
              transform: `translate(${z.x}px, ${z.y}px) scale(${z.scale})`, transformOrigin: 'center center',
              transition: reduced || active ? 'none' : 'transform 150ms ease-out',
            }}
          />
        </div>
        {!zoomed && (
          <span
            data-testid="pinch-zoom-hint"
            style={{
              position: 'absolute', bottom: tokens.space.sm, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none',
              fontSize: tokens.font.sm, padding: `2px ${tokens.space.sm}px`, borderRadius: tokens.radius.pill,
              background: tokens.color.card, color: tokens.color.fg, border: `1px solid ${tokens.color.border}`,
            }}
          >
            {hint}
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label={t('mobile.docs.zoom_controls')}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.space.sm }}
      >
        <button
          type="button"
          data-testid="zoom-out"
          aria-label={t('mobile.docs.zoom_out')}
          aria-disabled={atMin}
          onClick={() => { if (!atMin) apply((s, w, h) => stepZoom(s, 1 / ZOOM_STEP, w, h)); }}
          style={btn(atMin)}
        >
          <ZoomOut size={20} aria-hidden="true" />
        </button>
        <span
          data-testid="zoom-level"
          aria-live="polite"
          style={{ minWidth: 72, textAlign: 'center', fontSize: tokens.font.sm, color: tokens.color.muted }}
        >
          {t('mobile.docs.zoom_level', { pct: Math.round(z.scale * 100) })}
        </span>
        <button
          type="button"
          data-testid="zoom-in"
          aria-label={t('mobile.docs.zoom_in')}
          aria-disabled={atMax}
          onClick={() => { if (!atMax) apply((s, w, h) => stepZoom(s, ZOOM_STEP, w, h)); }}
          style={btn(atMax)}
        >
          <ZoomIn size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="zoom-reset"
          aria-label={t('mobile.docs.zoom_reset')}
          aria-disabled={atMin}
          onClick={() => { if (!atMin) apply(() => reset()); }}
          style={btn(atMin)}
        >
          <Maximize2 size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
