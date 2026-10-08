import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { usePullToRefresh } from '@/app/app/_lib/usePullToRefresh';
import { touch } from './test-utils';

function Harness({ onRefresh, scrollTop = 0 }: { onRefresh: () => void | Promise<void>; scrollTop?: number }) {
  const p = usePullToRefresh(onRefresh, { getScrollTop: () => scrollTop });
  return (
    <div data-testid="area" {...p.bind}>
      <span data-testid="distance">{p.distance}</span>
      <span data-testid="refreshing">{String(p.refreshing)}</span>
    </div>
  );
}

function pull(dy: number) {
  const area = screen.getByTestId('area');
  touch(area, 'touchstart', 100, 100);
  touch(area, 'touchmove', 100, 100 + dy);
  return () => touch(area, 'touchend', 100, 100 + dy);
}

describe('usePullToRefresh', () => {
  it('a long pull at the top refreshes once and shows the pull distance while dragging', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const release = pull(200);
    expect(Number(screen.getByTestId('distance').textContent)).toBeGreaterThanOrEqual(64);
    await act(async () => { release(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('distance').textContent).toBe('0');
  });

  it('a short pull does nothing', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    await act(async () => { pull(60)(); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does nothing when the list is scrolled down (it is a scroll, not a pull)', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} scrollTop={120} />);
    await act(async () => { pull(300)(); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('an upward drag does nothing', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    await act(async () => { pull(-200)(); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('ignores a second pull while the first refresh is still running', async () => {
    let finish!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    render(<Harness onRefresh={onRefresh} />);
    await act(async () => { pull(200)(); });
    expect(screen.getByTestId('refreshing').textContent).toBe('true');
    await act(async () => { pull(200)(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(screen.getByTestId('refreshing').textContent).toBe('false');
  });

  it('a refresh that throws still ends the refreshing state', async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error('x')));
    render(<Harness onRefresh={onRefresh} />);
    await act(async () => { pull(200)(); });
    expect(screen.getByTestId('refreshing').textContent).toBe('false');
  });
});

describe('usePullToRefresh — gesture discrimination', () => {
  it('a predominantly horizontal swipe (the banner carousel) never refreshes or shows a pull', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const area = screen.getByTestId('area');
    touch(area, 'touchstart', 100, 100);
    touch(area, 'touchmove', 300, 190); // dx 200, dy 90: sideways wins
    expect(screen.getByTestId('distance').textContent).toBe('0');
    // Even if the finger then wanders far down, the gesture was decided as a swipe.
    touch(area, 'touchmove', 310, 400);
    expect(screen.getByTestId('distance').textContent).toBe('0');
    await act(async () => { touch(area, 'touchend', 310, 400); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a slightly diagonal but mostly vertical pull still refreshes', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const area = screen.getByTestId('area');
    touch(area, 'touchstart', 100, 100);
    touch(area, 'touchmove', 130, 320); // dx 30, dy 220
    await act(async () => { touch(area, 'touchend', 130, 320); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a gesture that begins upward and then reverses downward is a scroll, not a pull', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const area = screen.getByTestId('area');
    touch(area, 'touchstart', 100, 300);
    touch(area, 'touchmove', 100, 250); // up 50 — decided: scroll
    touch(area, 'touchmove', 100, 600); // then down 300 from the start
    await act(async () => { touch(area, 'touchend', 100, 600); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('stops pulling the moment the scroller leaves the top mid-gesture', async () => {
    const onRefresh = vi.fn();
    let top = 0;
    function Live() {
      const p = usePullToRefresh(onRefresh, { getScrollTop: () => top });
      return <div data-testid="area" {...p.bind}><span data-testid="distance">{p.distance}</span></div>;
    }
    render(<Live />);
    const area = screen.getByTestId('area');
    touch(area, 'touchstart', 100, 100);
    touch(area, 'touchmove', 100, 140);
    top = 30;
    touch(area, 'touchmove', 100, 400);
    expect(screen.getByTestId('distance').textContent).toBe('0');
    await act(async () => { touch(area, 'touchend', 100, 400); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a cancelled touch (system gesture / scroll takeover) resets without refreshing', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const area = screen.getByTestId('area');
    touch(area, 'touchstart', 100, 100);
    touch(area, 'touchmove', 100, 300);
    expect(Number(screen.getByTestId('distance').textContent)).toBeGreaterThan(0);
    await act(async () => { touch(area, 'touchcancel', 100, 300); });
    expect(screen.getByTestId('distance').textContent).toBe('0');
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('usePullToRefresh — scroll container', () => {
  function WithRef({ onRefresh }: { onRefresh: () => void }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const p = usePullToRefresh(onRefresh, { scrollRef: ref });
    return (
      <div data-testid="scroller" ref={ref} {...p.bind}>
        <span data-testid="distance">{p.distance}</span>
      </div>
    );
  }

  it('reads scrollTop from the ref the screen passes in (not window.scrollY)', async () => {
    const onRefresh = vi.fn();
    render(<WithRef onRefresh={onRefresh} />);
    const el = screen.getByTestId('scroller');
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    try {
      // ref scroller at top, window "scrolled": must still arm.
      touch(el, 'touchstart', 100, 100);
      touch(el, 'touchmove', 100, 320);
      await act(async () => { touch(el, 'touchend', 100, 320); });
      expect(onRefresh).toHaveBeenCalledTimes(1);

      // ref scroller scrolled down: must not arm.
      el.scrollTop = 80;
      touch(el, 'touchstart', 100, 100);
      touch(el, 'touchmove', 100, 320);
      await act(async () => { touch(el, 'touchend', 100, 320); });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('with no option it falls back to the shell scroller #mobile-main', async () => {
    const main = document.createElement('main');
    main.id = 'mobile-main';
    document.body.appendChild(main);
    try {
      const onRefresh = vi.fn();
      function Default() {
        const p = usePullToRefresh(onRefresh);
        return <div data-testid="area" {...p.bind} />;
      }
      render(<Default />);
      const area = screen.getByTestId('area');
      main.scrollTop = 40;
      touch(area, 'touchstart', 100, 100);
      touch(area, 'touchmove', 100, 320);
      await act(async () => { touch(area, 'touchend', 100, 320); });
      expect(onRefresh).not.toHaveBeenCalled();

      main.scrollTop = 0;
      touch(area, 'touchstart', 100, 100);
      touch(area, 'touchmove', 100, 320);
      await act(async () => { touch(area, 'touchend', 100, 320); });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      main.remove();
    }
  });

  it('unmounting mid-refresh is safe and the refresh result is not applied to a dead component', async () => {
    let finish!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<Harness onRefresh={onRefresh} />);
    await act(async () => { pull(200)(); });
    unmount();
    await act(async () => { finish(); });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
