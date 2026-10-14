/**
 * Pure gesture math for the receipt viewer (no DOM, no React: tested on its own).
 *
 * Model. The rendered transform is `translate(x, y) scale(s)` with the origin at
 * the container centre, and every point is measured RELATIVE TO THAT CENTRE. A
 * content point `p` is displayed at `x + s·p`.
 *
 * A pinch keeps the content point that was under the starting midpoint pinned
 * under the current midpoint, which solves to  x' = mid' − (s'/s)(mid − x).
 * Panning is clamped so the image's edges never move inside the viewport:
 * |x| ≤ (s − 1)·W/2 (and likewise for y with H).
 */
export interface Pt { x: number; y: number }
export interface ZoomState { scale: number; x: number; y: number }

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2.5;
export const DOUBLE_TAP_MS = 300;
/** A finger that moves further than this between down and up is a drag, not a tap. */
export const TAP_SLOP_PX = 10;
/** Two taps further apart than this are two taps, not a double-tap. */
export const DOUBLE_TAP_DIST_PX = 30;
/** Factor applied by the zoom-in / zoom-out buttons (zoom-out divides by it). */
export const ZOOM_STEP = 1.5;
/** Arrow-key pan distance in CSS px per key press (keyboard / assistive-tech pan). */
export const KEY_PAN_STEP_PX = 40;
/**
 * Floor for the distance a pinch is measured against. Two fingers that land
 * within a few px of each other would otherwise make the pinch dead (0) or an
 * enormous ratio (3 px -> 4x on the first move).
 */
export const MIN_PINCH_DIST_PX = 8;
export const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 };
const ORIGIN: Pt = { x: 0, y: 0 };

export const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** `-0` would render as "translate(-0px" and fail toEqual; normalise it. */
const clean = (n: number): number => (Object.is(n, -0) ? 0 : n);

/** Fresh un-zoomed state (a copy, so nobody can mutate the shared IDENTITY). */
export const reset = (): ZoomState => ({ ...IDENTITY });

export function clampPan(s: ZoomState, w: number, h: number): ZoomState {
  const maxX = ((s.scale - 1) * w) / 2;
  const maxY = ((s.scale - 1) * h) / 2;
  return {
    scale: s.scale,
    x: clean(Math.min(maxX, Math.max(-maxX, s.x))),
    y: clean(Math.min(maxY, Math.max(-maxY, s.y))),
  };
}

/** Scale by the raw factor `ratio`, keeping the content under `startMid` pinned under `curMid`. */
function scaleAbout(start: ZoomState, ratio: number, startMid: Pt, curMid: Pt, w: number, h: number): ZoomState {
  const scale = clampScale(start.scale * ratio);
  const k = scale / start.scale;
  return clampPan({ scale, x: curMid.x - k * (startMid.x - start.x), y: curMid.y - k * (startMid.y - start.y) }, w, h);
}

export function pinch(
  start: ZoomState, startDist: number, startMid: Pt, curDist: number, curMid: Pt, w: number, h: number,
): ZoomState {
  return scaleAbout(start, curDist / Math.max(startDist, MIN_PINCH_DIST_PX), startMid, curMid, w, h);
}

export function pan(start: ZoomState, dx: number, dy: number, w: number, h: number): ZoomState {
  if (start.scale <= MIN_SCALE) return reset();
  return clampPan({ scale: start.scale, x: start.x + dx, y: start.y + dy }, w, h);
}

/** Zoom by `factor` about the container centre (the +/- buttons). */
export function stepZoom(s: ZoomState, factor: number, w: number, h: number): ZoomState {
  return scaleAbout(s, factor, ORIGIN, ORIGIN, w, h);
}

export function toggleDoubleTap(s: ZoomState, at: Pt, w: number, h: number): ZoomState {
  if (s.scale > MIN_SCALE) return reset();
  // From scale 1 / x = 0 the content point under the tap is `at`; keeping it there needs x = at − S·at = −at·(S − 1).
  return clampPan({ scale: DOUBLE_TAP_SCALE, x: -at.x * (DOUBLE_TAP_SCALE - 1), y: -at.y * (DOUBLE_TAP_SCALE - 1) }, w, h);
}

/**
 * Keyboard pan: an arrow key moves the VIEW (so the content moves the other
 * way, as when scrolling), by KEY_PAN_STEP_PX, through the same clamp as the
 * pointer path. Returns null when the key is not a pan key, the image is not
 * zoomed, or the pan is already at the edge (nothing moves: the caller must not
 * preventDefault).
 */
export function keyPan(s: ZoomState, key: string, w: number, h: number): ZoomState | null {
  if (s.scale <= MIN_SCALE) return null;
  const dx = key === 'ArrowLeft' ? KEY_PAN_STEP_PX : key === 'ArrowRight' ? -KEY_PAN_STEP_PX : 0;
  const dy = key === 'ArrowUp' ? KEY_PAN_STEP_PX : key === 'ArrowDown' ? -KEY_PAN_STEP_PX : 0;
  if (dx === 0 && dy === 0) return null;
  const next = pan(s, dx, dy, w, h);
  return next.x === s.x && next.y === s.y ? null : next;
}
