import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useInfiniteScroll } from '@/app/app/_lib/useInfiniteScroll';
import { MockIntersectionObserver } from './_mock-io';
import './_load-tolerance';

type HarnessProps = {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
  disabled?: boolean;
  onSupported?: (s: boolean) => void;
  onApi?: (api: ReturnType<typeof useInfiniteScroll>) => void;
};

function Harness(props: HarnessProps) {
  const api = useInfiniteScroll(props);
  props.onSupported?.(api.supported);
  props.onApi?.(api);
  return <div ref={api.sentinelRef} data-testid="sentinel" />;
}

beforeEach(() => { MockIntersectionObserver.reset(); vi.stubGlobal('IntersectionObserver', MockIntersectionObserver); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('useInfiniteScroll', () => {
  it('loads more when the sentinel intersects', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(MockIntersectionObserver.latest().options?.rootMargin).toBe('400px');
  });
  it('ignores non-intersecting entries', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    act(() => MockIntersectionObserver.latest().fire(false));
    expect(onLoadMore).not.toHaveBeenCalled();
  });
  it('does not load when there is no next page', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore={false} loading={false} onLoadMore={onLoadMore} />);
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });
  it('does not double-load while a page is in flight', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading onLoadMore={onLoadMore} />);
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });
  it('re-observes after a page lands so a still-visible sentinel triggers the next page', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    const io = MockIntersectionObserver.latest();
    const before = io.observeCalls;
    rerender(<Harness hasMore loading onLoadMore={onLoadMore} />);
    rerender(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    expect(io.observeCalls).toBeGreaterThan(before);
  });
  it('a still-visible sentinel keeps paging: each landed page gets a fresh initial notification (needs unobserve+observe)', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    const io = MockIntersectionObserver.latest();
    io.visible = true; // short page / tall phone: the sentinel never leaves the viewport
    act(() => io.flush());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<Harness hasMore loading onLoadMore={onLoadMore} />);
    act(() => io.flush());
    expect(onLoadMore).toHaveBeenCalledTimes(1); // in flight: nothing to deliver
    rerender(<Harness hasMore loading={false} onLoadMore={onLoadMore} />); // page landed
    act(() => io.flush());
    expect(onLoadMore).toHaveBeenCalledTimes(2); // a bare observe() on an observed target would deliver nothing
  });
  it('the mock ignores observe() on an already-observed target (matches the real API)', () => {
    const io = new MockIntersectionObserver(vi.fn());
    const el = document.createElement('div');
    io.observe(el);
    io.observe(el);
    expect(io.observeCalls).toBe(1);
    io.unobserve(el);
    io.observe(el);
    expect(io.observeCalls).toBe(2);
  });
  it('does not re-observe when the list is exhausted or loading (no needless re-fire)', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    const io = MockIntersectionObserver.latest();
    rerender(<Harness hasMore loading onLoadMore={onLoadMore} />);
    const mid = io.observeCalls;
    rerender(<Harness hasMore={false} loading={false} onLoadMore={onLoadMore} />);
    expect(io.observeCalls).toBe(mid);
  });
  it('disconnects on unmount', () => {
    const { unmount } = render(<Harness hasMore loading={false} onLoadMore={vi.fn()} />);
    const io = MockIntersectionObserver.latest();
    unmount();
    expect(io.disconnected).toBe(true);
  });
  it('disconnects the old observer and builds a new one when rootMargin changes', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} rootMargin="400px" />);
    const first = MockIntersectionObserver.latest();
    rerender(<Harness hasMore loading={false} onLoadMore={onLoadMore} rootMargin="100px" />);
    const second = MockIntersectionObserver.latest();
    expect(second).not.toBe(first);
    expect(first.disconnected).toBe(true);
    expect(second.options?.rootMargin).toBe('100px');
    act(() => first.fire(true));
    expect(onLoadMore).not.toHaveBeenCalled();
    act(() => second.fire(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
  it('calls the latest onLoadMore, not the one captured when the observer was created', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={stale} />);
    rerender(<Harness hasMore loading={false} onLoadMore={fresh} />);
    act(() => MockIntersectionObserver.latest().fire(true));
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  it('uses the shell scroll container as the observer root so rootMargin prefetches inside it', () => {
    const main = document.createElement('main');
    main.id = 'mobile-main';
    document.body.appendChild(main);
    render(<Harness hasMore loading={false} onLoadMore={vi.fn()} />, { container: main.appendChild(document.createElement('div')) });
    const opts = MockIntersectionObserver.latest().options;
    expect(opts?.root).toBe(main);
    expect(opts?.rootMargin).toBe('400px');
  });
  it('falls back to the viewport (no root) when there is no shell container', () => {
    render(<Harness hasMore loading={false} onLoadMore={vi.fn()} />);
    expect(MockIntersectionObserver.latest().options?.root).toBeUndefined();
  });
  it('falls back to the viewport when the sentinel is outside #mobile-main (a non-ancestor root would never intersect)', () => {
    const main = document.createElement('main');
    main.id = 'mobile-main';
    document.body.appendChild(main);
    render(<Harness hasMore loading={false} onLoadMore={vi.fn()} />); // rendered in a sibling container, not inside main
    expect(document.getElementById('mobile-main')).toBe(main);
    expect(MockIntersectionObserver.latest().options?.root).toBeUndefined();
  });
  it('disabled stops observer-driven loads and the post-load re-observe (no retry loop after an error)', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    const io = MockIntersectionObserver.latest();
    rerender(<Harness hasMore loading onLoadMore={onLoadMore} />);
    const mid = io.observeCalls;
    // the page failed: loading drops, cursor is kept (hasMore true), caller sets disabled
    rerender(<Harness hasMore loading={false} disabled onLoadMore={onLoadMore} />);
    expect(io.observeCalls).toBe(mid);
    act(() => io.fire(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });
  it('loadMore (button / retry) respects hasMore and loading but works while disabled', () => {
    const onLoadMore = vi.fn();
    let api!: ReturnType<typeof useInfiniteScroll>;
    const grab = (a: typeof api) => { api = a; };
    const { rerender } = render(<Harness hasMore loading={false} disabled onLoadMore={onLoadMore} onApi={grab} />);
    act(() => api.loadMore());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<Harness hasMore loading disabled onLoadMore={onLoadMore} onApi={grab} />);
    act(() => api.loadMore());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<Harness hasMore={false} loading={false} onLoadMore={onLoadMore} onApi={grab} />);
    act(() => api.loadMore());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
  it('reports unsupported (so the page shows a Load more button) when IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const seen: boolean[] = [];
    expect(() => render(<Harness hasMore loading={false} onLoadMore={vi.fn()} onSupported={(s) => seen.push(s)} />)).not.toThrow();
    expect(seen.at(-1)).toBe(false);
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });
  it('reports supported when IntersectionObserver exists', () => {
    const seen: boolean[] = [];
    render(<Harness hasMore loading={false} onLoadMore={vi.fn()} onSupported={(s) => seen.push(s)} />);
    expect(seen.at(-1)).toBe(true);
  });
  it('renders on the server without touching IntersectionObserver or window', async () => {
    const { renderToString } = await import('react-dom/server');
    vi.stubGlobal('IntersectionObserver', undefined);
    const seen: boolean[] = [];
    expect(() => renderToString(<Harness hasMore loading={false} onLoadMore={vi.fn()} onSupported={(s) => seen.push(s)} />)).not.toThrow();
    expect(seen.at(-1)).toBe(true); // server snapshot: optimistic, corrected on the client
  });
});
