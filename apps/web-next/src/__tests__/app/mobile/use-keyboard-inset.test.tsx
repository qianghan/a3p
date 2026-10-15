import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { computeViewportFrame, useKeyboardInset, KEYBOARD_MIN_PX } from '../../../app/app/_lib/useKeyboardInset';

class FakeVV extends EventTarget {
  height = 844;
  offsetTop = 0;
}

const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
afterEach(() => {
  if (original) Object.defineProperty(window, 'visualViewport', original);
  else delete (window as unknown as { visualViewport?: unknown }).visualViewport;
});

describe('computeViewportFrame', () => {
  it('no visualViewport → no keyboard', () => {
    expect(computeViewportFrame(844, null)).toEqual({ keyboardPx: 0, offsetTop: 0, viewportHeight: 844 });
  });
  it('keyboard open → inset is the hidden part of the layout viewport', () => {
    expect(computeViewportFrame(844, { height: 500, offsetTop: 0 })).toEqual({
      keyboardPx: 344, offsetTop: 0, viewportHeight: 500,
    });
  });
  it('iOS pan (offsetTop) is subtracted, not double-counted', () => {
    expect(computeViewportFrame(844, { height: 500, offsetTop: 40 }).keyboardPx).toBe(304);
  });
  it(`ignores URL-bar jitter below ${KEYBOARD_MIN_PX}px`, () => {
    expect(computeViewportFrame(844, { height: 790, offsetTop: 0 }).keyboardPx).toBe(0);
  });
});

describe('useKeyboardInset', () => {
  it('tracks visualViewport resize events', () => {
    const vv = new FakeVV();
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current.keyboardPx).toBe(0);
    act(() => {
      vv.height = 480;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(result.current.keyboardPx).toBe(364);
    act(() => {
      vv.height = 844;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(result.current.keyboardPx).toBe(0);
  });
});
