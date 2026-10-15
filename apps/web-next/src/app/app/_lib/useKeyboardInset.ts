'use client';

import { useEffect, useState } from 'react';

/**
 * How much of the layout viewport the on-screen keyboard hides.
 *
 * iOS Safari does not shrink the layout viewport for the keyboard; only
 * window.visualViewport shrinks (and pans via offsetTop). A composer pinned
 * with `bottom: 0` therefore sits behind the keyboard. Callers position the
 * chat panel's bottom edge at `keyboardPx` (or the tab bar when closed).
 */
export const KEYBOARD_MIN_PX = 120;

export interface ViewportFrame {
  keyboardPx: number;
  offsetTop: number;
  viewportHeight: number;
}

interface VVLike {
  height: number;
  offsetTop: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export function computeViewportFrame(
  layoutHeight: number,
  vv: { height: number; offsetTop: number } | null | undefined,
): ViewportFrame {
  if (!vv) return { keyboardPx: 0, offsetTop: 0, viewportHeight: Math.round(layoutHeight) };
  const raw = layoutHeight - vv.height - vv.offsetTop;
  return {
    keyboardPx: raw > KEYBOARD_MIN_PX ? Math.round(raw) : 0,
    offsetTop: Math.max(0, Math.round(vv.offsetTop)),
    viewportHeight: Math.round(vv.height),
  };
}

export function useKeyboardInset(): ViewportFrame {
  const [frame, setFrame] = useState<ViewportFrame>({ keyboardPx: 0, offsetTop: 0, viewportHeight: 0 });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = (window as unknown as { visualViewport?: VVLike | null }).visualViewport ?? null;
    const update = () => {
      const next = computeViewportFrame(window.innerHeight, vv);
      setFrame((prev) =>
        prev.keyboardPx === next.keyboardPx &&
        prev.offsetTop === next.offsetTop &&
        prev.viewportHeight === next.viewportHeight
          ? prev
          : next,
      );
    };
    update();
    if (!vv) {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return frame;
}
