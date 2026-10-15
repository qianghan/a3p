import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { isNearBottom, useStickToBottom } from '../../../app/app/_lib/useStickToBottom';

describe('isNearBottom', () => {
  it('true within the threshold, false beyond it', () => {
    expect(isNearBottom({ scrollTop: 520, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });
});

let api: ReturnType<typeof useStickToBottom> | null = null;
function Harness({ k }: { k: number }) {
  const ref = useRef<HTMLDivElement>(null);
  api = useStickToBottom(ref, k);
  return <div data-testid="list" ref={ref} />;
}

/** jsdom has no layout: back scrollTop/scrollHeight/clientHeight with plain values. */
function fakeScroll(el: HTMLElement, height: { value: number }) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { get: () => height.value, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
}

describe('useStickToBottom', () => {
  it('follows new content while the user is at the bottom', () => {
    const h = { value: 1000 };
    const { getByTestId, rerender } = render(<Harness k={0} />);
    const el = getByTestId('list');
    fakeScroll(el, h);
    h.value = 1200;
    rerender(<Harness k={1} />);
    expect(el.scrollTop).toBe(1200);
    expect(api!.hasUnseen).toBe(false);
  });

  it('does not yank the user down after they scroll up; flags unseen instead', () => {
    const h = { value: 1000 };
    const { getByTestId, rerender } = render(<Harness k={0} />);
    const el = getByTestId('list');
    fakeScroll(el, h);
    el.scrollTop = 100;
    fireEvent.scroll(el);
    h.value = 1400;
    rerender(<Harness k={1} />);
    expect(el.scrollTop).toBe(100);
    expect(api!.hasUnseen).toBe(true);
    act(() => api!.scrollToBottom());
    expect(el.scrollTop).toBe(1400);
    expect(api!.hasUnseen).toBe(false);
  });
});
