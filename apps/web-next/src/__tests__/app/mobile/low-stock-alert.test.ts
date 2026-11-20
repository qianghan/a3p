import { describe, it, expect } from 'vitest';
import type { MobileAlert } from '@/lib/mobile/types';
import { alertCopy } from '@/app/app/_lib/alert-copy';
import { i18nT } from './test-utils';

/** PR 5A — the Home low-stock alert reads in every locale and opens chat. */
const money = (c: number) => `$${c / 100}`;
const alert = (params: Record<string, string | number>): MobileAlert => ({
  id: 'low_stock', kind: 'low_stock', severity: 'warn', params, target: { route: '/app/chat', query: { topic: 'low_stock' } },
});

describe('low_stock alert copy', () => {
  it('names the single item, counts several', () => {
    expect(alertCopy(alert({ count: 1, item: 'Widget' }), i18nT('en'), money).title).toBe('Widget is low on stock');
    expect(alertCopy(alert({ count: 3, item: 'Widget' }), i18nT('en'), money).title).toBe('3 items are low on stock');
    expect(alertCopy(alert({ count: 3, item: 'Widget' }), i18nT('fr-CA'), money).title).toBe('3 articles ont un stock bas');
    expect(alertCopy(alert({ count: 1, item: 'Widget' }), i18nT('zh-CN'), money).title).toBe('Widget 库存不足');
  });

  it('links to the chat prefill, never a desktop page', () => {
    expect(alertCopy(alert({ count: 2 }), i18nT('en'), money).href).toBe('/app/chat?topic=low_stock');
  });
});
