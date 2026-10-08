import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { renderHook, act } from '@testing-library/react';
import { readJson, writeJson } from '@/app/app/_lib/safe-storage';
import { useDebouncedValue } from '@/app/app/_lib/useDebouncedValue';
import { useOnlineStatus } from '@/app/app/_lib/useOnlineStatus';
import { formatDocDate, isPdfUrl, formatAmountInput, todayIso } from '@/app/app/_lib/format';
import { getRecentCategories, pushRecentCategory, orderWithRecents, RECENTS_KEY } from '@/app/app/_lib/category-recents';
import { parseDocFilter, saveDocNav, readDocNav, neighbors, removeFromDocNav, docsHref } from '@/app/app/_lib/doc-nav';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe('safe-storage', () => {
  it('round-trips JSON', () => {
    writeJson('local', 'k', { a: 1 });
    expect(readJson('local', 'k', null)).toEqual({ a: 1 });
  });
  it('returns the fallback when storage throws (private mode / blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    expect(() => writeJson('local', 'k', 1)).not.toThrow();
    expect(readJson('local', 'k', 'fallback')).toBe('fallback');
  });
  it('returns the fallback on corrupt JSON', () => {
    localStorage.setItem('k', '{not json');
    expect(readJson('local', 'k', 7)).toBe(7);
  });
});

describe('useDebouncedValue', () => {
  it('only publishes the last value after the delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    rerender({ v: 'abc' });
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('abc');
    vi.useRealTimers();
  });
});

describe('useDebouncedValue cleanup', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a superseded value never publishes (stale timer is cleared on replace)', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const { rerender } = renderHook(({ v }) => { const d = useDebouncedValue(v, 300); seen.push(d); return d; }, { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    act(() => { vi.advanceTimersByTime(200); });
    rerender({ v: 'abc' });
    // 'ab' would have fired at t=300 had its timer not been cleared; at t=400 only 'abc' (due t=500) is pending.
    act(() => { vi.advanceTimersByTime(200); });
    expect(seen).not.toContain('ab');
    act(() => { vi.advanceTimersByTime(100); });
    expect(seen[seen.length - 1]).toBe('abc');
  });

  it('clears the pending timer on unmount', () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ v }) => useDebouncedValue(v, 300), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useOnlineStatus', () => {
  function setOnLine(v: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
  }
  afterEach(() => { delete (navigator as { onLine?: boolean }).onLine; });

  it('tracks online/offline events', () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    act(() => { setOnLine(false); window.dispatchEvent(new Event('offline')); });
    expect(result.current).toBe(false);
    act(() => { setOnLine(true); window.dispatchEvent(new Event('online')); });
    expect(result.current).toBe(true);
  });

  it('removes both listeners on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useOnlineStatus());
    const added = add.mock.calls.filter(([t]) => t === 'online' || t === 'offline');
    expect(added.map(([t]) => t).sort()).toEqual(['offline', 'online']);
    unmount();
    for (const [type, handler] of added) {
      expect(remove).toHaveBeenCalledWith(type, handler);
    }
  });

  it('server snapshot is online, so a client that hydrates offline re-renders', () => {
    setOnLine(false);
    const html = renderToString(createElement(() => String(useOnlineStatus())));
    expect(html).toBe('true');
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });
});

describe('format', () => {
  it('formats a date-only ISO as that calendar day (zone-pinned variant: docs-helpers-tz.test.ts)', () => {
    expect(formatDocDate('2026-10-01', 'en')).toBe('Oct 1, 2026');
    expect(formatDocDate('2026-10-01T00:00:00.000Z', 'en')).toBe('Oct 1, 2026');
  });
  it('returns empty for an unparseable date', () => {
    expect(formatDocDate('nope', 'en')).toBe('');
  });
  it('detects PDF receipts by path, ignoring query strings', () => {
    expect(isPdfUrl('https://x.public.blob.vercel-storage.com/r/a.PDF?download=1')).toBe(true);
    expect(isPdfUrl('https://x.public.blob.vercel-storage.com/r/a.jpg')).toBe(false);
    expect(isPdfUrl(null)).toBe(false);
  });
  it('formats an editable amount with the locale decimal separator and no grouping', () => {
    expect(formatAmountInput(123456, 'en')).toBe('1234.56');
    expect(formatAmountInput(4700, 'fr-CA')).toBe('47,00');
  });
  it('formatAmountInput never emits NaN or Infinity text for non-finite input', () => {
    expect(formatAmountInput(NaN, 'en')).toBe('');
    expect(formatAmountInput(Infinity, 'en')).toBe('');
    expect(formatAmountInput(-Infinity, 'en')).toBe('');
    expect(formatAmountInput(undefined as unknown as number, 'en')).toBe('');
    expect(formatAmountInput(null as unknown as number, 'en')).toBe('');
  });
  it('formatAmountInput still formats zero and negative amounts', () => {
    expect(formatAmountInput(0, 'en')).toBe('0.00');
    expect(formatAmountInput(-4700, 'en')).toBe('-47.00');
    expect(formatAmountInput(-4700, 'fr-CA')).toBe('-47,00');
  });
  it('todayIso is a local YYYY-MM-DD', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('category recents', () => {
  it('pushes most-recent-first, de-duplicates and caps at 5', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) pushRecentCategory({ id, name: id.toUpperCase() });
    pushRecentCategory({ id: 'c', name: 'C' });
    expect(getRecentCategories().map((r) => r.id)).toEqual(['c', 'f', 'e', 'd', 'b']);
  });
  it('ignores malformed storage', () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ nope: 1 }, 'x', { id: 'ok', name: 'OK' }]));
    expect(getRecentCategories()).toEqual([{ id: 'ok', name: 'OK' }]);
  });
  it('orders recents first, rest alphabetically, and drops recents that no longer exist', () => {
    const all = [
      { id: '1', name: 'Travel', code: '5100' },
      { id: '2', name: 'Meals', code: '5200' },
      { id: '3', name: 'Advertising', code: '5000' },
    ];
    const { recent, rest } = orderWithRecents(all, [{ id: '2', name: 'Meals' }, { id: 'gone', name: 'Old' }]);
    expect(recent.map((c) => c.name)).toEqual(['Meals']);
    expect(rest.map((c) => c.name)).toEqual(['Advertising', 'Travel']);
  });
});

describe('doc-nav', () => {
  it('parses only known filters', () => {
    expect(parseDocFilter('needs-review')).toBe('needs-review');
    expect(parseDocFilter('archived')).toBe('archived');
    expect(parseDocFilter('bogus')).toBe('all');
    expect(parseDocFilter(null)).toBe('all');
  });
  it('computes neighbours from the saved list', () => {
    saveDocNav({ ids: ['a', 'b', 'c'], filter: 'no-category', q: 'cafe' });
    const nav = readDocNav();
    expect(neighbors(nav, 'b')).toEqual({ prev: 'a', next: 'c' });
    expect(neighbors(nav, 'a')).toEqual({ prev: null, next: 'b' });
    expect(neighbors(nav, 'zzz')).toEqual({ prev: null, next: null });
    expect(docsHref(nav)).toBe('/app/docs?filter=no-category&q=cafe');
  });
  it('removes a deleted id', () => {
    saveDocNav({ ids: ['a', 'b'], filter: 'all', q: '' });
    removeFromDocNav('a');
    expect(readDocNav()?.ids).toEqual(['b']);
    expect(docsHref(readDocNav())).toBe('/app/docs');
  });
  it('drops the previous list when saving fails, so prev/next never walks a stale list', () => {
    saveDocNav({ ids: ['a', 'b', 'c'], filter: 'all', q: '' });
    expect(readDocNav()?.ids).toEqual(['a', 'b', 'c']);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    saveDocNav({ ids: ['x', 'y'], filter: 'no-receipt', q: 'new' });
    expect(readDocNav()).toBeNull();
    expect(neighbors(readDocNav(), 'b')).toEqual({ prev: null, next: null });
  });
  it('survives sessionStorage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readDocNav()).toBeNull();
    expect(neighbors(null, 'a')).toEqual({ prev: null, next: null });
    expect(docsHref(null)).toBe('/app/docs');
  });
});
