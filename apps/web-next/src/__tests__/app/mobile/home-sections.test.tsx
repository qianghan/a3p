import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import type { UpcomingItem, RecentItem } from '@/lib/mobile/types';
import { NextUp, dueLabel, upcomingTitle } from '@/app/app/_home/NextUp';
import { RecentActivity, recentHref, DOC_VIEWER_ROUTE_SHIPPED } from '@/app/app/_home/RecentActivity';
import { QuickActions } from '@/app/app/_home/QuickActions';
import { BrandNewHome } from '@/app/app/_home/BrandNewHome';
import { HomeSkeleton, HomeError, StaleNotice, PullIndicator } from '@/app/app/_home/HomeStates';
import { renderWithI18n, expectTouchTarget, i18nT } from './test-utils';
import { homeFixture } from './fixtures';

const up = (over: Partial<UpcomingItem>): UpcomingItem => ({
  id: 'u', kind: 'tax', titleKey: 'mobile.upcoming.tax_instalment', params: { quarter: 3, year: 2026 }, date: '2026-10-15', daysAway: 8, amountCents: 300_000, ...over,
});

describe('NextUp', () => {
  it('lists up to three items with title, date, day count and amount', () => {
    const items = [
      up({ id: 'a' }),
      up({ id: 'b', kind: 'bill', titleKey: 'mobile.upcoming.bill_due', params: { vendor: 'Rogers' }, date: '2026-10-09', daysAway: 2, amountCents: 9_000 }),
      up({ id: 'c', daysAway: 0, date: '2026-10-07', amountCents: null }),
      up({ id: 'd' }),
    ];
    renderWithI18n(<NextUp items={items} currency="CAD" />);
    expect(screen.getByRole('heading', { name: 'Next up' })).toBeInTheDocument();
    const rows = document.querySelectorAll('[data-next-up]');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Estimated tax payment · Q3 2026');
    expect(rows[0]).toHaveTextContent('Oct 15 · In 8 days');
    expect(rows[0]).toHaveTextContent('CA$3,000');
    expect(rows[1]).toHaveTextContent('Rogers bill');
    expect(rows[1]).toHaveTextContent('In 2 days');
    expect(rows[2]).toHaveTextContent('Today');
    // No amount on the row means no amount shown — not a dash.
    expect(within(rows[2] as HTMLElement).queryByLabelText('Not available')).toBeNull();
  });

  it('renders a logical date without zone shifting (UTC-midnight date in a western zone)', () => {
    renderWithI18n(<NextUp items={[up({ date: '2026-01-01', daysAway: 1 })]} currency="CAD" />);
    expect(document.querySelector('[data-next-up]')).toHaveTextContent('Jan 1 · In 1 day');
  });

  it('says so when nothing is due', () => {
    renderWithI18n(<NextUp items={[]} currency="CAD" />);
    expect(screen.getByText('Nothing due in the next 30 days.')).toBeInTheDocument();
  });

  it('dueLabel: today, late, future — French zero/one singular', () => {
    const en = i18nT('en');
    const fr = i18nT('fr-CA');
    expect(dueLabel(en, 0)).toBe('Today');
    expect(dueLabel(en, -2)).toBe('2 days late');
    expect(dueLabel(en, 1)).toBe('In 1 day');
    expect(dueLabel(fr, 1)).toBe('Dans 1 jour');
    expect(dueLabel(fr, 5)).toBe('Dans 5 jours');
  });
});

describe('upcomingTitle — seeded calendar keys that may not be in the catalog', () => {
  const cal = (titleKey: string, params: UpcomingItem['params'] = {}) =>
    up({ kind: 'calendar', titleKey, params, amountCents: null });

  it('uses the localized catalog entry when the key resolves', () => {
    expect(upcomingTitle(i18nT('en'), cal('calendar.q1_estimated_tax_due'))).toBe('Q1 Estimated Tax Due');
    expect(upcomingTitle(i18nT('fr-CA'), cal('calendar.q1_estimated_tax_due'))).not.toBe('calendar.q1_estimated_tax_due');
  });

  it('never shows a raw key: an unknown tax key falls back to a localized neutral label', () => {
    // CA seeds `instalment` (British); the catalog spells it `installment` — a real miss.
    const item = cal('calendar.q1_instalment_due');
    expect(upcomingTitle(i18nT('en'), item)).toBe('Tax deadline');
    expect(upcomingTitle(i18nT('fr-CA'), item)).toBe('Échéance fiscale');
    expect(upcomingTitle(i18nT('zh-CN'), item)).toBe('税务截止日期');
    expect(upcomingTitle(i18nT('en'), cal('calendar.payg_q2_instalment'))).toBe('Tax deadline');
    expect(upcomingTitle(i18nT('en'), cal('calendar.bas_q1_due'))).toBe('Tax deadline');
  });

  it('a non-tax miss gets the generic label, and the humanised fallback is never used', () => {
    expect(upcomingTitle(i18nT('en'), cal('calendar.domain_renewal'))).toBe('Upcoming date');
    // useT's provider-less fallback humanises the last segment; that must not be shown either.
    const humanising = (key: string) => key.split('.').pop()!.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    expect(upcomingTitle(humanising, cal('calendar.domain_renewal'))).not.toBe('Domain renewal');
  });

  it('a key whose placeholders the server did not supply is treated as unresolved', () => {
    // calendar.invoice_due is "Invoice #{number} due — {client} ({amount})".
    expect(upcomingTitle(i18nT('en'), cal('calendar.invoice_due'))).toBe('Upcoming date');
  });

  it('rejects a key outside the dotted-identifier shape', () => {
    expect(upcomingTitle(i18nT('en'), cal('<b>oops</b>'))).toBe('Upcoming date');
  });
});

describe('RecentActivity', () => {
  it('lists up to five items; labels are text; expense rows link to Docs until the viewer ships', () => {
    const items: RecentItem[] = [
      ...homeFixture().recent,
      ...Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, kind: 'invoice' as const, label: `INV-${i}`, amountCents: 1_000, at: '2026-10-01T12:00:00.000Z' })),
    ];
    renderWithI18n(<RecentActivity items={items} currency="CAD" />);
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-recent]')).toHaveLength(5);
    const link = screen.getByRole('link', { name: /Staples/ });
    // PR 4 ships /app/docs/[docId]; until DOC_VIEWER_ROUTE_SHIPPED flips, link the list (never a 404).
    expect(DOC_VIEWER_ROUTE_SHIPPED).toBe(false);
    expect(link).toHaveAttribute('href', '/app/docs');
    expect(link).toHaveTextContent('CA$43');
    expectTouchTarget(link);
    const payment = document.querySelector('[data-recent="payment"]') as HTMLElement;
    expect(within(payment).queryByRole('link')).toBeNull();
    expect(payment).toHaveTextContent('Payment from Acme');
  });

  it('recentHref: viewer link only for expenses with a docId, encoded, once the flag is on', () => {
    const exp: RecentItem = { id: 'r', kind: 'expense', label: 'x', amountCents: 1, at: '2026-10-01T00:00:00.000Z', docId: 'a/b c' };
    expect(recentHref(exp, true)).toBe('/app/docs/a%2Fb%20c');
    expect(recentHref(exp, false)).toBe('/app/docs');
    expect(recentHref({ ...exp, docId: undefined }, true)).toBeNull();
    expect(recentHref({ ...exp, kind: 'invoice' }, true)).toBeNull();
  });

  it('renders a hostile label as inert text', () => {
    const items: RecentItem[] = [{ id: 'h', kind: 'payment', label: '<img src=x onerror=alert(1)>', amountCents: 500, at: '2026-10-01T12:00:00.000Z' }];
    renderWithI18n(<RecentActivity items={items} currency="CAD" />);
    expect(document.querySelector('[data-recent] img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('says so when there is no activity', () => {
    renderWithI18n(<RecentActivity items={[]} currency="CAD" />);
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});

describe('QuickActions', () => {
  it('offers Snap, Add expense and Ask as 44px links to existing mobile screens', () => {
    renderWithI18n(<QuickActions />);
    const expected: Array<[string, string]> = [
      ['Snap receipt', '/app/capture'],
      ['Add expense', '/app/capture'],
      ['Ask advisor', '/app/chat'],
    ];
    for (const [name, href] of expected) {
      const a = screen.getByRole('link', { name });
      expect(a).toHaveAttribute('href', href);
      expectTouchTarget(a);
    }
  });
});

describe('BrandNewHome', () => {
  it('keeps the three existing next-step cards', () => {
    renderWithI18n(<BrandNewHome />);
    expect(screen.getByRole('heading', { name: 'Welcome — let’s get your books started' })).toBeInTheDocument();
    expect(screen.getByText(/start filling in/i)).toBeInTheDocument();
    const cards = Array.from(document.querySelectorAll('a[data-action-card]'));
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(['/app/capture', '/app/chat', '/app/docs']);
    expect(cards[0]).toHaveTextContent('Snap a receipt');
    expect(cards[1]).toHaveTextContent('Just tell your advisor');
    expect(cards[2]).toHaveTextContent('See what else it can do');
    for (const a of cards) expectTouchTarget(a as HTMLElement);
  });
});

describe('Home states', () => {
  it('skeleton is a labelled loading status', () => {
    renderWithI18n(<HomeSkeleton />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('error: distinct copy for offline vs server failure, and Retry calls back', () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithI18n(<HomeError offline={false} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<HomeError offline onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You’re offline');
  });

  it('error: the ApiError code picks the copy — unauthorized is a signed-out state with a sign-in link', () => {
    const onRetry = vi.fn();
    renderWithI18n(<HomeError offline={false} code="unauthorized" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('You’ve been signed out');
    expect(alert).not.toHaveTextContent('Couldn’t load this');
    const link = screen.getByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', '/login');
    expectTouchTarget(link);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('error: rate_limited has its own copy and keeps Retry', () => {
    renderWithI18n(<HomeError offline={false} code="rate_limited" onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('error: an unknown code falls back to the generic copy (the server message is never rendered)', () => {
    renderWithI18n(<HomeError offline={false} code="boom_internal_stack" onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this');
    expect(screen.getByRole('alert')).not.toHaveTextContent('boom_internal_stack');
  });

  it('stale notice names the time and differs offline vs failed refresh', () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithI18n(<StaleNotice offline time="3:04 PM" onRetry={onRetry} />);
    expect(screen.getByTestId('stale-notice')).toHaveTextContent('Offline · showing data as of 3:04 PM');
    rerender(<StaleNotice offline={false} time="3:04 PM" onRetry={onRetry} />);
    expect(screen.getByTestId('stale-notice')).toHaveTextContent('Couldn’t refresh · showing data as of 3:04 PM');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('pull indicator is absent at rest and labelled while pulling or refreshing', () => {
    const { rerender } = renderWithI18n(<PullIndicator distance={0} busy={false} />);
    expect(screen.queryByTestId('pull-indicator')).toBeNull();
    rerender(<PullIndicator distance={40} busy={false} />);
    expect(screen.getByTestId('pull-indicator')).toHaveTextContent('Pull to refresh');
    rerender(<PullIndicator distance={0} busy />);
    expect(screen.getByTestId('pull-indicator')).toHaveTextContent('Refreshing');
  });
});
