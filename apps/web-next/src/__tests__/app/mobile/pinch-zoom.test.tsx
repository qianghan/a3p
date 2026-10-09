import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  IDENTITY, MAX_SCALE, MIN_SCALE, ZOOM_STEP, DOUBLE_TAP_SCALE, KEY_PAN_STEP_PX, MIN_PINCH_DIST_PX,
  pinch, pan, clampPan, clampScale, toggleDoubleTap, stepZoom, reset, distance, midpoint, keyPan,
} from '@/app/app/docs/_lib/pinch-zoom';
import { PinchZoomImage } from '@/app/app/docs/_components/PinchZoomImage';
import { installPointerEvent } from './_pointer';

// Real English catalog: every rendered label proves its key exists.
vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);

const W = 300, H = 400;
const O = { x: 0, y: 0 };

describe('pinch-zoom math', () => {
  it('distance and midpoint', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: -10, y: 4 }, { x: 30, y: 8 })).toEqual({ x: 10, y: 6 });
  });

  it('spreading two fingers from 100px to 200px about the centre doubles the scale', () => {
    expect(pinch(IDENTITY, 100, O, 200, O, W, H)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it('keeps the content under the gesture midpoint fixed (when not clamped)', () => {
    const start = { scale: 2, x: 0, y: 0 };
    const mid = { x: 40, y: -30 };
    const z = pinch(start, 100, mid, 150, mid, W, H);
    const contentUnderMid = (mid.x - start.x) / start.scale;
    expect(z.x + z.scale * contentUnderMid).toBeCloseTo(mid.x, 6);
    // Exact numbers: k = 3/2, x' = 40 − 1.5·(40 − 0) = −20, y' = −30 − 1.5·(−30) = 15.
    expect(z).toEqual({ scale: 3, x: -20, y: 15 });
  });

  it('solves x\' = mid\' − (s\'/s)(mid − x) when the midpoint moves and the start is already panned', () => {
    // k = 3/2 (2 → 3); x' = 50 − 1.5·(40 − 30) = 35; y' = −10 − 1.5·(−30 − (−20)) = 5.
    expect(pinch({ scale: 2, x: 30, y: -20 }, 100, { x: 40, y: -30 }, 150, { x: 50, y: -10 }, W, H)).toEqual({ scale: 3, x: 35, y: 5 });
    // Same distance (k = 1): a pure two-finger drag moves the image by the midpoint's travel.
    expect(pinch({ scale: 2, x: 30, y: -20 }, 100, { x: 40, y: -30 }, 100, { x: 55, y: -25 }, W, H)).toEqual({ scale: 2, x: 45, y: -15 });
  });

  it('uses the CLAMPED scale ratio, so over-spreading past 4x does not overshoot the pan', () => {
    // 3 → 4 (not 3 → 30): k = 4/3, x' = 50 − (4/3)(50 − 100) = 116.666…
    const z = pinch({ scale: 3, x: 100, y: 0 }, 100, { x: 50, y: 0 }, 1000, { x: 50, y: 0 }, W, H);
    expect(z.scale).toBe(4);
    expect(z.x).toBeCloseTo(116.6667, 3);
  });

  it('clamps scale to [1, 4]', () => {
    expect(pinch(IDENTITY, 100, O, 2000, O, W, H).scale).toBe(MAX_SCALE);
    expect(pinch({ scale: 2, x: 0, y: 0 }, 200, O, 10, O, W, H).scale).toBe(MIN_SCALE);
    expect(clampScale(0.2)).toBe(1);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
    expect(clampScale(4)).toBe(4);
    expect(clampScale(9)).toBe(4);
  });

  it('pinching back down to 1x lands exactly on the identity, whatever the pan was', () => {
    expect(pinch({ scale: 2, x: 120, y: -150 }, 200, { x: 30, y: 10 }, 20, { x: 30, y: 10 }, W, H)).toEqual(IDENTITY);
  });

  it('measures a pinch against a minimum start distance, so fingers that land together are neither dead nor a jump to 4x', () => {
    expect(MIN_PINCH_DIST_PX).toBe(8);
    // Same point (0 px): not dead. 0 -> 16 px is measured against the 8 px floor: 2x.
    expect(pinch(IDENTITY, 0, O, 16, O, W, H)).toEqual({ scale: 2, x: 0, y: 0 });
    // 3 px apart, first move to 4 px: 4/8 = 0.5 (clamped to 1x), NOT 4/3 or 4x.
    expect(pinch(IDENTITY, 3, O, 4, O, W, H).scale).toBe(1);
    // 3 px apart then 6 px: still below the floor, still 1x.
    expect(pinch(IDENTITY, 3, O, 6, O, W, H).scale).toBe(1);
    // A start distance above the floor is untouched: 20 -> 40 is exactly 2x.
    expect(pinch(IDENTITY, 20, O, 40, O, W, H).scale).toBe(2);
    expect(pinch(IDENTITY, 8, O, 12, O, W, H).scale).toBe(1.5);
  });

  it('keyPan moves the view by the fixed step through the pan clamp, and says null when nothing moves', () => {
    expect(KEY_PAN_STEP_PX).toBe(40);
    const z = { scale: 2, x: 0, y: 0 };
    expect(keyPan(z, 'ArrowRight', W, H)).toEqual({ scale: 2, x: -40, y: 0 });
    expect(keyPan(z, 'ArrowLeft', W, H)).toEqual({ scale: 2, x: 40, y: 0 });
    expect(keyPan(z, 'ArrowDown', W, H)).toEqual({ scale: 2, x: 0, y: -40 });
    expect(keyPan(z, 'ArrowUp', W, H)).toEqual({ scale: 2, x: 0, y: 40 });
    // Clamp: x limit at 2x is 150; 130 + 40 stops at 150, then nothing moves.
    expect(keyPan({ scale: 2, x: 130, y: 0 }, 'ArrowLeft', W, H)).toEqual({ scale: 2, x: 150, y: 0 });
    expect(keyPan({ scale: 2, x: 150, y: 0 }, 'ArrowLeft', W, H)).toBeNull();
    expect(keyPan({ scale: 2, x: 0, y: -200 }, 'ArrowDown', W, H)).toBeNull();
    // Not a pan key / not zoomed.
    expect(keyPan(z, 'a', W, H)).toBeNull();
    expect(keyPan(IDENTITY, 'ArrowRight', W, H)).toBeNull();
  });

  it('clamps panning so the image edge never enters the viewport', () => {
    expect(clampPan({ scale: 2, x: 1000, y: -1000 }, W, H)).toEqual({ scale: 2, x: 150, y: -200 });
    expect(clampPan({ scale: 2, x: -1000, y: 1000 }, W, H)).toEqual({ scale: 2, x: -150, y: 200 });
    // Inside the limit nothing moves; at 4x the limit is (4 − 1)·W/2.
    expect(clampPan({ scale: 4, x: 100, y: -120 }, W, H)).toEqual({ scale: 4, x: 100, y: -120 });
    expect(clampPan({ scale: 4, x: 999, y: 999 }, W, H)).toEqual({ scale: 4, x: 450, y: 600 });
    // At 1x there is nothing to pan.
    expect(clampPan({ scale: 1, x: 40, y: -40 }, W, H)).toEqual(IDENTITY);
  });

  it('a pinch result is itself clamped (the focal point yields to the edge)', () => {
    // Pinching about a far corner would want x = 200 at 2x; the limit is 150.
    expect(pinch(IDENTITY, 100, { x: -140, y: 0 }, 200, { x: 60, y: 0 }, W, H)).toEqual({ scale: 2, x: 150, y: 0 });
  });

  it('one-finger pan is ignored at scale 1 and applied when zoomed', () => {
    expect(pan(IDENTITY, 50, 50, W, H)).toEqual(IDENTITY);
    expect(pan({ scale: 2, x: 0, y: 0 }, 50, -20, W, H)).toEqual({ scale: 2, x: 50, y: -20 });
    expect(pan({ scale: 2, x: 100, y: 0 }, 500, 500, W, H)).toEqual({ scale: 2, x: 150, y: 200 });
  });

  it('double-tap zooms to 2.5x around the tapped point, and back to 1x', () => {
    const z = toggleDoubleTap(IDENTITY, { x: 20, y: 10 }, W, H);
    expect(z).toEqual({ scale: DOUBLE_TAP_SCALE, x: -30, y: -15 });
    expect(z.x + z.scale * 20).toBeCloseTo(20, 6);
    expect(toggleDoubleTap(z, O, W, H)).toEqual(IDENTITY);
    // A tap past the clamp distance: x would be −300, the limit is 1.5·300/2 = 225.
    expect(toggleDoubleTap(IDENTITY, { x: 200, y: 0 }, W, H)).toEqual({ scale: 2.5, x: -225, y: 0 });
  });

  it('stepZoom scales about the centre, clamped to [1, 4], pan scaling with it', () => {
    expect(stepZoom(IDENTITY, ZOOM_STEP, W, H)).toEqual({ scale: 1.5, x: 0, y: 0 });
    expect(stepZoom({ scale: 2, x: 100, y: -50 }, ZOOM_STEP, W, H)).toEqual({ scale: 3, x: 150, y: -75 });
    expect(stepZoom({ scale: 4, x: 10, y: 10 }, ZOOM_STEP, W, H)).toEqual({ scale: 4, x: 10, y: 10 });
    expect(stepZoom(IDENTITY, 1 / ZOOM_STEP, W, H)).toEqual(IDENTITY);
    expect(stepZoom({ scale: 1.5, x: 75, y: 0 }, 1 / ZOOM_STEP, W, H)).toEqual(IDENTITY);
  });

  it('reset returns the identity as a fresh object that cannot corrupt IDENTITY', () => {
    const r = reset();
    expect(r).toEqual({ scale: 1, x: 0, y: 0 });
    expect(r).not.toBe(IDENTITY);
    r.scale = 3;
    expect(IDENTITY).toEqual({ scale: 1, x: 0, y: 0 });
    expect(toggleDoubleTap({ scale: 3, x: 5, y: 5 }, O, W, H)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(pan(IDENTITY, 9, 9, W, H)).not.toBe(IDENTITY);
  });
});

describe('<PinchZoomImage> pointer handling', () => {
  beforeAll(installPointerEvent);
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (Element.prototype as unknown as Record<string, unknown>).setPointerCapture;
  });

  const transform = () => (screen.getByTestId('pinch-zoom-img') as HTMLElement).style.transform;
  const box = () => screen.getByTestId('pinch-zoom');
  const mount = (props: Partial<React.ComponentProps<typeof PinchZoomImage>> = {}) =>
    render(<PinchZoomImage src="https://x/r.jpg" alt="Receipt image" hint="Pinch" {...props} />);
  const down = (id: number, x: number, y = 200) => fireEvent.pointerDown(box(), { pointerId: id, clientX: x, clientY: y });
  const move = (id: number, x: number, y = 200) => fireEvent.pointerMove(box(), { pointerId: id, clientX: x, clientY: y });
  const up = (id: number, x: number, y = 200) => fireEvent.pointerUp(box(), { pointerId: id, clientX: x, clientY: y });
  /** Two fingers 100 apart about the centre, spread to 200 apart: 2x. */
  const pinchTo2x = () => {
    down(1, 100); down(2, 200);
    move(1, 50); move(2, 250);
  };
  const tapAt = (now: ReturnType<typeof vi.spyOn>, t: number, id = 7, x = 150, y = 200) => {
    now.mockReturnValue(t);
    down(id, x, y); up(id, x, y);
  };

  it('pinches to 2x with two pointers', () => {
    mount();
    pinchTo2x();
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
    up(1, 50); up(2, 250);
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
  });

  it('keeps the pinched content under the fingers when the midpoint is off-centre', () => {
    mount();
    // Fingers at x = 160/260 (centre-relative 10/110), 100 apart; spread to 200 apart about the same midpoint.
    down(1, 160); down(2, 260);
    move(1, 110); move(2, 310);
    // mid (60, 0): x' = 60 − 2·60 = −60.
    expect(transform()).toBe('translate(-60px, 0px) scale(2)');
  });

  it('double-tap toggles 2.5x and back', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    tapAt(now, 1000); tapAt(now, 1150);
    expect(transform()).toBe('translate(0px, 0px) scale(2.5)');
    tapAt(now, 5000); tapAt(now, 5100);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('double-tap zooms around the tapped point', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    // Tap at centre-relative (20, 10) → x = −30, y = −15.
    tapAt(now, 1000, 7, 170, 210); tapAt(now, 1100, 7, 170, 210);
    expect(transform()).toBe('translate(-30px, -15px) scale(2.5)');
  });

  it('two slow taps do not zoom', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    tapAt(now, 1000, 3); tapAt(now, 2000, 3);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('two quick taps far apart do not zoom', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    tapAt(now, 1000, 3, 50); tapAt(now, 1100, 3, 250);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('a drag that ends where it started is not a tap', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    tapAt(now, 1000);
    now.mockReturnValue(1100);
    down(7, 150); move(7, 190); up(7, 150, 200);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
    // And a drag that finishes elsewhere does not arm the next tap either.
    now.mockReturnValue(1200);
    down(7, 150); move(7, 200); up(7, 200);
    now.mockReturnValue(1250);
    down(7, 200); up(7, 200);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('lifting the second finger of a pinch is not a tap, even if it barely moved', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    now.mockReturnValue(1000);
    down(1, 140); down(2, 160);       // 20 apart
    move(2, 161);                     // < slop travel
    up(2, 161); up(1, 140);
    now.mockReturnValue(1100);
    down(5, 150); up(5, 150);
    expect(transform()).not.toContain('scale(2.5)');
  });

  it('pans when zoomed, clamped to the edges', () => {
    mount();
    pinchTo2x();
    up(2, 250);
    move(1, 1000);
    expect(transform()).toBe('translate(150px, 0px) scale(2)');
    move(1, -1000, -1000);
    expect(transform()).toBe('translate(-150px, -200px) scale(2)');
  });

  it('a one-finger drag at 1x does not move the image', () => {
    mount();
    down(1, 100); move(1, 250, 100); up(1, 250, 100);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('exposes the image to assistive tech by its alt text; touch-action leaves page scroll at 1x and blocks it when zoomed', () => {
    mount();
    expect(box()).toHaveAttribute('aria-label', 'Receipt image');
    expect(box()).toHaveAttribute('role', 'img');
    expect(screen.getByTestId('pinch-zoom-img')).toHaveAttribute('alt', '');
    expect(box().style.touchAction).toBe('pan-y');
    expect(box().style.overscrollBehavior).toBe('contain');
    pinchTo2x();
    up(1, 50); up(2, 250);
    expect(box().style.touchAction).toBe('none');
    fireEvent.click(screen.getByTestId('zoom-reset'));
    expect(box().style.touchAction).toBe('pan-y');
  });

  it('shows the hint only while un-zoomed', () => {
    mount();
    expect(screen.getByTestId('pinch-zoom-hint')).toHaveTextContent('Pinch');
    pinchTo2x();
    expect(screen.queryByTestId('pinch-zoom-hint')).toBeNull();
  });

  it('announces a pinch once, at the end: the live region is frozen mid-gesture while the visible label follows', () => {
    mount();
    const live = () => screen.getByTestId('zoom-live');
    const label = () => screen.getByTestId('zoom-level');
    down(1, 100); down(2, 200);
    for (const [a, b] of [[95, 205], [80, 220], [60, 240], [50, 250]]) {
      move(1, a); move(2, b);
      expect(live()).toHaveTextContent('Zoom: 100%');
    }
    expect(label()).toHaveTextContent('Zoom: 200%');
    up(2, 250);
    expect(live()).toHaveTextContent('Zoom: 100%'); // one finger is still down: the gesture is not over
    move(1, 60); // the survivor now pans: still the same gesture
    expect(live()).toHaveTextContent('Zoom: 100%');
    up(1, 60);
    expect(live()).toHaveTextContent('Zoom: 200%');
  });

  it('announces on pointercancel too, and a button zoom announces immediately', () => {
    mount();
    down(1, 100); down(2, 200);
    move(1, 50); move(2, 250);
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 100%');
    fireEvent.pointerCancel(box(), { pointerId: 2, clientX: 250, clientY: 200 });
    fireEvent.pointerCancel(box(), { pointerId: 1, clientX: 50, clientY: 200 });
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 200%');
    fireEvent.click(screen.getByTestId('zoom-in')); // 3x
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 300%');
    fireEvent.click(screen.getByTestId('zoom-reset'));
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 100%');
  });

  it('announces a double-tap zoom immediately', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    tapAt(now, 1000); tapAt(now, 1150);
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 250%');
  });

  it('rounds the zoom label for an off-integer scale (a pinch ending at 2.3456x reads 235%)', () => {
    mount();
    // 100 apart -> 234.56 apart about the centre: 2.3456x.
    down(1, 100); down(2, 200);
    move(1, 150 - 117.28); move(2, 150 + 117.28);
    expect(transform()).toMatch(/scale\(2\.345\d*\)$/); // 2.3456 up to float noise: not an integer
    expect(screen.getByTestId('zoom-level').textContent).toBe('Zoom: 235%');
    up(1, 32.72); up(2, 267.28);
    expect(screen.getByTestId('zoom-live').textContent).toBe('Zoom: 235%');
  });

  it('a pinch whose fingers land on the same point still works, and a few px apart does not jump to 4x', () => {
    mount();
    down(1, 150); down(2, 150); // 0 px apart
    move(1, 142); // 8 px apart: 8/8 = 1x
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
    move(2, 158); // 16 px apart: 2x
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
  });

  it('a few px apart on landing does not leap to 4x on the first move', () => {
    mount();
    down(1, 148); down(2, 152); // 4 px apart
    move(2, 156); // 8 px apart: 8/8 = 1x, not 8/4 = 2x
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('ignores a third finger: it neither jumps the image nor ends the pinch', () => {
    mount();
    down(1, 100); down(2, 200);
    down(3, 10, 10);
    move(3, 290, 390);
    move(1, 50); move(2, 250);
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
    up(3, 290, 390); // an untracked finger lifting must not re-base the gesture
    move(2, 350);    // fingers 300 apart (3x), midpoint 50 right of the start: still measured from the ORIGINAL start
    expect(transform()).toBe('translate(50px, 0px) scale(3)');
    fireEvent.pointerCancel(box(), { pointerId: 3 });
    fireEvent.pointerLeave(box(), { pointerId: 3 });
    expect(transform()).toBe('translate(50px, 0px) scale(3)');
  });

  it('a third finger never takes over when a tracked finger lifts: the survivor pans, it does not pinch with the third', () => {
    mount();
    down(1, 100); down(2, 200);
    down(3, 10, 10);
    move(1, 50); move(2, 250);
    up(1, 50);
    move(2, 270); // finger 2 alone: +20 pan at 2x, not a two-finger pinch against finger 3
    expect(transform()).toBe('translate(20px, 0px) scale(2)');
  });

  it('pointercancel ends that pointer without counting a tap, and the survivor pans from where it is', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    pinchTo2x();
    fireEvent.pointerCancel(box(), { pointerId: 2 });
    move(1, 70); // finger 1 was at 50 → +20
    expect(transform()).toBe('translate(20px, 0px) scale(2)');
    fireEvent.pointerCancel(box(), { pointerId: 1 });
    move(1, 140); // cancelled: further moves are ignored
    expect(transform()).toBe('translate(20px, 0px) scale(2)');
    // A cancelled touch must not be the first half of a double-tap.
    now.mockReturnValue(9000);
    down(8, 150); fireEvent.pointerCancel(box(), { pointerId: 8, clientX: 150, clientY: 200 });
    now.mockReturnValue(9100);
    down(8, 150); up(8, 150);
    expect(transform()).toBe('translate(20px, 0px) scale(2)');
  });

  it('a pointer that leaves mid-gesture ends; its later moves are ignored and the other finger pans', () => {
    mount();
    pinchTo2x();
    fireEvent.pointerLeave(box(), { pointerId: 2, clientX: 900, clientY: 200 });
    move(2, 700); // already gone
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
    move(1, 80); // pans +30 from 50
    expect(transform()).toBe('translate(30px, 0px) scale(2)');
  });

  it('a lost pointer capture ends the pointer too', () => {
    mount();
    pinchTo2x();
    fireEvent.lostPointerCapture(box(), { pointerId: 2 });
    move(2, 700);
    move(1, 80);
    expect(transform()).toBe('translate(30px, 0px) scale(2)');
  });

  it('captures the pointer when it can', () => {
    const cap = vi.fn();
    (Element.prototype as unknown as Record<string, unknown>).setPointerCapture = cap;
    mount();
    down(4, 150);
    expect(cap).toHaveBeenCalledWith(4);
  });

  it('survives setPointerCapture throwing (stale pointer id) and still pinches', () => {
    (Element.prototype as unknown as Record<string, unknown>).setPointerCapture = () => {
      throw new DOMException('no such pointer', 'NotFoundError');
    };
    mount();
    expect(() => pinchTo2x()).not.toThrow();
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
  });

  it('ignores a right-click', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    for (const t of [1000, 1100]) {
      now.mockReturnValue(t);
      fireEvent.pointerDown(box(), { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 150, clientY: 200 });
      fireEvent.pointerUp(box(), { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 150, clientY: 200 });
    }
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('a mouse double-click zooms through the same pointer path', () => {
    const now = vi.spyOn(Date, 'now');
    mount();
    for (const t of [1000, 1120]) {
      now.mockReturnValue(t);
      fireEvent.pointerDown(box(), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 150, clientY: 200 });
      fireEvent.pointerUp(box(), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 150, clientY: 200 });
    }
    expect(transform()).toBe('translate(0px, 0px) scale(2.5)');
    // The browser's own dblclick must NOT toggle it back.
    fireEvent.doubleClick(box(), { detail: 2 });
    expect(transform()).toBe('translate(0px, 0px) scale(2.5)');
  });

  it('a new receipt (src change) starts un-zoomed', () => {
    const { rerender } = mount();
    pinchTo2x();
    expect(transform()).toBe('translate(0px, 0px) scale(2)');
    rerender(<PinchZoomImage src="https://x/other.jpg" alt="Receipt image" hint="Pinch" />);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('does not animate mid-gesture, animates the buttons, and honours reduced motion', () => {
    mount();
    const img = () => screen.getByTestId('pinch-zoom-img') as HTMLElement;
    expect(img().style.transition).toContain('150ms');
    down(1, 100);
    expect(img().style.transition).toBe('none');
    up(1, 100);
    expect(img().style.transition).toContain('150ms');
  });

  it('removes its reduced-motion listener on unmount (and registers exactly one)', () => {
    const add = vi.fn();
    const remove = vi.fn();
    const mq = { matches: true, addEventListener: add, removeEventListener: remove };
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue(mq) as unknown as typeof window.matchMedia;
    try {
      const { unmount } = mount();
      expect((screen.getByTestId('pinch-zoom-img') as HTMLElement).style.transition).toBe('none');
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
      unmount();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);
    } finally {
      window.matchMedia = original;
    }
  });

  it('adds no window/document listeners that outlive it', () => {
    const wAdd = vi.spyOn(window, 'addEventListener');
    const dAdd = vi.spyOn(document, 'addEventListener');
    const wRemove = vi.spyOn(window, 'removeEventListener');
    const dRemove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = mount();
    pinchTo2x();
    unmount();
    const net = (add: typeof wAdd, rem: typeof wRemove) =>
      add.mock.calls.filter(([type, fn]) => !rem.mock.calls.some(([t2, f2]) => t2 === type && f2 === fn));
    // React registers its own root listeners on the container, not window/document, for pointer events;
    // whatever else was added must have been removed again.
    expect(net(wAdd, wRemove).map(([type]) => type)).toEqual([]);
    expect(net(dAdd, dRemove).map(([type]) => type)).toEqual([]);
  });

  it('an unmount mid-gesture is clean (no state update after unmount)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = mount();
    down(1, 100); down(2, 200);
    unmount();
    expect(err).not.toHaveBeenCalled();
  });
});

describe('<PinchZoomImage> keyboard / assistive-tech controls', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  const transform = () => (screen.getByTestId('pinch-zoom-img') as HTMLElement).style.transform;
  const mount = () => render(<PinchZoomImage src="https://x/r.jpg" alt="Receipt image" hint="Pinch" />);

  it('names every control from the catalog and groups them', () => {
    mount();
    expect(screen.getByTestId('zoom-in')).toHaveAttribute('aria-label', 'Zoom in');
    expect(screen.getByTestId('zoom-out')).toHaveAttribute('aria-label', 'Zoom out');
    expect(screen.getByTestId('zoom-reset')).toHaveAttribute('aria-label', 'Reset zoom');
    expect(screen.getByTestId('zoom-in').closest('[role="group"]')).toHaveAttribute('aria-label', 'Zoom controls');
    expect(screen.getByTestId('zoom-level')).toHaveTextContent('Zoom: 100%');
    // The visible label is hidden from AT; the polite live region is the separate, once-per-action one.
    expect(screen.getByTestId('zoom-level')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('zoom-level')).not.toHaveAttribute('aria-live');
    expect(screen.getByTestId('zoom-live')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 100%');
  });

  it('every control is at least 44x44 CSS px', () => {
    mount();
    for (const id of ['zoom-in', 'zoom-out', 'zoom-reset']) {
      const s = screen.getByTestId(id).style;
      expect(parseInt(s.minHeight, 10), id).toBeGreaterThanOrEqual(44);
      expect(parseInt(s.minWidth, 10), id).toBeGreaterThanOrEqual(44);
    }
  });

  it('zoom in steps 1.5x about the centre up to 4x, then stops', () => {
    mount();
    const zin = screen.getByTestId('zoom-in');
    fireEvent.click(zin);
    expect(transform()).toBe('translate(0px, 0px) scale(1.5)');
    expect(screen.getByTestId('zoom-level')).toHaveTextContent('Zoom: 150%');
    fireEvent.click(zin); // 2.25
    fireEvent.click(zin); // 3.375
    fireEvent.click(zin); // 4 (clamped from 5.0625)
    expect(transform()).toBe('translate(0px, 0px) scale(4)');
    expect(screen.getByTestId('zoom-level')).toHaveTextContent('Zoom: 400%');
    expect(zin).toHaveAttribute('aria-disabled', 'true');
    expect(zin).not.toBeDisabled(); // stays focusable
    fireEvent.click(zin);
    expect(transform()).toBe('translate(0px, 0px) scale(4)');
  });

  it('zoom out and reset are inert at 1x; reset returns to the identity from anywhere', () => {
    mount();
    const zout = screen.getByTestId('zoom-out');
    const rst = screen.getByTestId('zoom-reset');
    expect(zout).toHaveAttribute('aria-disabled', 'true');
    expect(rst).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(zout);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
    fireEvent.click(screen.getByTestId('zoom-in'));
    fireEvent.click(screen.getByTestId('zoom-in'));
    expect(zout).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(zout);
    expect(transform()).toBe('translate(0px, 0px) scale(1.5)');
    fireEvent.click(screen.getByTestId('zoom-in'));
    fireEvent.click(rst);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
    expect(screen.getByTestId('zoom-level')).toHaveTextContent('Zoom: 100%');
    expect(rst).toHaveAttribute('aria-disabled', 'true');
  });

  const kbox = () => screen.getByTestId('pinch-zoom');
  /** fireEvent returns false when the handler called preventDefault. */
  const key = (k: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(kbox(), { key: k, ...init });

  it('is not a tab stop at 1x, becomes one when zoomed, and is described by the catalog pan hint', () => {
    mount();
    expect(kbox()).not.toHaveAttribute('tabindex');
    expect(kbox()).not.toHaveAttribute('aria-describedby');
    fireEvent.click(screen.getByTestId('zoom-in'));
    expect(kbox()).toHaveAttribute('tabindex', '0');
    const hintId = kbox().getAttribute('aria-describedby') as string;
    expect(document.getElementById(hintId)).toHaveTextContent('Zoomed in. Use the arrow keys to move around the receipt. Press Home or Escape to reset the zoom.');
    fireEvent.click(screen.getByTestId('zoom-reset'));
    expect(kbox()).not.toHaveAttribute('tabindex');
    expect(kbox()).not.toHaveAttribute('aria-describedby');
  });

  it('keys do nothing at 1x (and are not swallowed)', () => {
    mount();
    expect(key('ArrowLeft')).toBe(true);
    expect(key('Home')).toBe(true);
    expect(key('Escape')).toBe(true);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('arrow keys pan the zoomed image by 40px through the clamp, and only swallow the key when they move it', () => {
    mount();
    fireEvent.click(screen.getByTestId('zoom-in')); // 1.5x: x limit 75, y limit 100
    expect(key('ArrowLeft')).toBe(false);
    expect(transform()).toBe('translate(40px, 0px) scale(1.5)');
    expect(key('ArrowLeft')).toBe(false);
    expect(transform()).toBe('translate(75px, 0px) scale(1.5)'); // 80 clamped to 75
    expect(key('ArrowLeft')).toBe(true); // at the edge: nothing moved, key left alone
    expect(transform()).toBe('translate(75px, 0px) scale(1.5)');
    expect(key('ArrowRight')).toBe(false);
    expect(transform()).toBe('translate(35px, 0px) scale(1.5)');
    expect(key('ArrowDown')).toBe(false);
    expect(transform()).toBe('translate(35px, -40px) scale(1.5)');
    key('ArrowDown'); key('ArrowDown'); // -80, then clamped at -100
    expect(transform()).toBe('translate(35px, -100px) scale(1.5)');
    expect(key('ArrowDown')).toBe(true);
    expect(key('ArrowUp')).toBe(false);
    expect(transform()).toBe('translate(35px, -60px) scale(1.5)');
  });

  it('ignores unrelated keys and modified arrows', () => {
    mount();
    fireEvent.click(screen.getByTestId('zoom-in'));
    expect(key('a')).toBe(true);
    expect(key('Tab')).toBe(true);
    expect(key('ArrowLeft', { ctrlKey: true })).toBe(true);
    expect(key('ArrowLeft', { metaKey: true })).toBe(true);
    expect(key('ArrowLeft', { altKey: true })).toBe(true);
    expect(transform()).toBe('translate(0px, 0px) scale(1.5)');
  });

  it('Home and Escape reset the zoom, announce it, and keep the box focusable while it holds focus', () => {
    mount();
    fireEvent.click(screen.getByTestId('zoom-in'));
    key('ArrowLeft');
    kbox().focus();
    expect(key('Home')).toBe(false);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 100%');
    expect(kbox()).toHaveAttribute('tabindex', '0'); // focus is not stranded
    fireEvent.blur(kbox());
    expect(kbox()).not.toHaveAttribute('tabindex');
    fireEvent.click(screen.getByTestId('zoom-in'));
    key('ArrowLeft');
    expect(key('Escape')).toBe(false);
    expect(transform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('a key pan is announced as an action but does not change the announced percentage', () => {
    mount();
    fireEvent.click(screen.getByTestId('zoom-in'));
    key('ArrowRight');
    expect(screen.getByTestId('zoom-live')).toHaveTextContent('Zoom: 150%');
  });
});
