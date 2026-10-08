import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { MobileAlert } from '@/lib/mobile/types';
import { AlertCarousel, MAX_ALERTS } from '@/app/app/_home/AlertCarousel';
import { useAlertAction } from '@/app/app/_home/useAlertAction';
import { ToastHost } from '@/app/app/_kit/Toast';
import { SNAPSHOT_PREFIX, SNAPSHOT_CLEARED_EVENT } from '@/lib/mobile/snapshot-keys';
import { renderWithI18n, routeFetch, jsonResponse, touch, expectTouchTarget } from './test-utils';
import { homeFixture } from './fixtures';

const REMIND_URL = '/api/v1/agentbook-invoice/invoices/inv-1/remind';

function Harness({ alerts, onDone = () => {} }: { alerts: MobileAlert[]; onDone?: () => void }) {
  const actions = useAlertAction(onDone);
  return <AlertCarousel alerts={alerts} currency="CAD" actions={actions} />;
}

function renderCarousel(alerts: MobileAlert[], onDone?: () => void, locale = 'en') {
  return renderWithI18n(
    <ToastHost>
      <Harness alerts={alerts} onDone={onDone} />
    </ToastHost>,
    locale,
  );
}

const ALERTS = homeFixture().alerts; // [critical overdue (action), warn review (target), info receipts (target)]
const carousel = () => screen.getByTestId('alert-carousel');
const politeToasts = () => screen.getByRole('status', { name: 'Notifications' });
const urgentToasts = () => screen.getByRole('alert', { name: 'Alerts' });

function many(n: number): MobileAlert[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, kind: 'uncategorized' as const, severity: 'info' as const, params: { count: i + 1 } }));
}

function swipeLeft() {
  touch(carousel(), 'touchstart', 300, 10);
  touch(carousel(), 'touchend', 100, 10);
}

afterEach(() => {
  window.localStorage.clear();
});

describe('AlertCarousel — one card at a time, in server order', () => {
  it('renders nothing when there are no alerts', () => {
    renderCarousel([]);
    expect(screen.queryByTestId('alert-carousel')).toBeNull();
  });

  it('shows one card at a time, in the SERVER order (the client never re-ranks)', () => {
    renderCarousel([ALERTS[1], ALERTS[0]]);
    expect(carousel()).toHaveTextContent('3 items are waiting for your review');
    expect(carousel().querySelector('[data-severity]')).toHaveAttribute('data-severity', 'warn');
    expect(carousel()).not.toHaveTextContent('Acme');
  });

  it('caps at five alerts', () => {
    expect(MAX_ALERTS).toBe(5);
    renderCarousel(many(7));
    expect(screen.getAllByRole('button', { name: /^Show alert \d of 5$/ })).toHaveLength(5);
  });

  it('a single alert has no dots and no prev/next', () => {
    renderCarousel([ALERTS[1]]);
    expect(screen.queryByRole('button', { name: /^Show alert/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous alert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next alert' })).toBeNull();
  });
});

describe('AlertCarousel — navigation', () => {
  it('swipes left to the next card and right back; stops at the ends; ignores a small drag', () => {
    renderCarousel(ALERTS);
    expect(carousel()).toHaveTextContent('Acme · CA$1,800 is 12 days overdue');
    swipeLeft();
    expect(carousel()).toHaveTextContent('3 items are waiting for your review');
    swipeLeft();
    swipeLeft();
    expect(carousel()).toHaveTextContent('4 expenses are missing a receipt');
    touch(carousel(), 'touchstart', 100, 10);
    touch(carousel(), 'touchend', 120, 10);
    expect(carousel()).toHaveTextContent('4 expenses are missing a receipt');
    touch(carousel(), 'touchstart', 100, 10);
    touch(carousel(), 'touchend', 300, 10);
    expect(carousel()).toHaveTextContent('3 items are waiting for your review');
  });

  it('a mostly-vertical drag (pull-to-refresh territory) never changes the card', () => {
    renderCarousel(ALERTS);
    touch(carousel(), 'touchstart', 300, 10);
    touch(carousel(), 'touchend', 240, 200);
    expect(carousel()).toHaveTextContent('Acme · CA$1,800 is 12 days overdue');
    touch(carousel(), 'touchstart', 300, 300);
    touch(carousel(), 'touchcancel', 100, 300);
    touch(carousel(), 'touchend', 100, 300);
    expect(carousel()).toHaveTextContent('Acme · CA$1,800 is 12 days overdue');
  });

  it('dots jump to a card, mark the current one, and are 44px targets', () => {
    renderCarousel(ALERTS);
    const third = screen.getByRole('button', { name: 'Show alert 3 of 3' });
    expectTouchTarget(third);
    fireEvent.click(third);
    expect(carousel()).toHaveTextContent('4 expenses are missing a receipt');
    expect(third).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Show alert 1 of 3' })).not.toHaveAttribute('aria-current');
  });

  it('prev/next buttons are the non-swipe alternative: 44px, disabled at the ends', () => {
    renderCarousel(ALERTS);
    const prev = screen.getByRole('button', { name: 'Previous alert' });
    const next = screen.getByRole('button', { name: 'Next alert' });
    expectTouchTarget(prev);
    expectTouchTarget(next);
    expect(prev).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(next);
    expect(carousel()).toHaveTextContent('3 items are waiting for your review');
    expect(prev).not.toHaveAttribute('aria-disabled');
    fireEvent.click(next);
    expect(carousel()).toHaveTextContent('4 expenses are missing a receipt');
    expect(next).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(next);
    expect(carousel()).toHaveTextContent('4 expenses are missing a receipt');
    fireEvent.click(prev);
    expect(carousel()).toHaveTextContent('3 items are waiting for your review');
  });

  it('is announced as a carousel of slides, politely, with the position of the current slide', () => {
    renderCarousel(ALERTS);
    const region = screen.getByRole('region', { name: 'Things that need attention' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    const slide = screen.getByRole('group', { name: 'Alert 1 of 3' });
    expect(slide).toHaveAttribute('aria-roledescription', 'slide');
    // No auto-advance, so every change is user-initiated: polite, never assertive.
    expect(slide.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    fireEvent.click(screen.getByRole('button', { name: 'Next alert' }));
    expect(screen.getByRole('group', { name: 'Alert 2 of 3' })).toBeInTheDocument();
  });

  it('nothing in it animates (prefers-reduced-motion holds by construction)', () => {
    const { container } = renderCarousel(ALERTS);
    const animated = [...container.querySelectorAll<HTMLElement>('[style]')].filter((el) => /transition|animation/.test(el.getAttribute('style') ?? ''));
    expect(animated).toEqual([]);
  });

  it('after a reload stays on the same alert by id, and clamps when the list shrinks', () => {
    const view = renderCarousel(ALERTS);
    fireEvent.click(screen.getByRole('button', { name: 'Show alert 3 of 3' }));
    view.rerender(
      <ToastHost>
        <Harness alerts={[ALERTS[2], ALERTS[0], ALERTS[1]]} />
      </ToastHost>,
    );
    expect(carousel()).toHaveTextContent('4 expenses are missing a receipt');
    expect(screen.getByRole('button', { name: 'Show alert 1 of 3' })).toHaveAttribute('aria-current', 'true');
    view.rerender(
      <ToastHost>
        <Harness alerts={[ALERTS[0]]} />
      </ToastHost>,
    );
    expect(carousel()).toHaveTextContent('Acme · CA$1,800 is 12 days overdue');
  });
});

describe('AlertCarousel — target links', () => {
  it('a target alert links to its mobile screen with the right label', () => {
    renderCarousel([ALERTS[1]]);
    const link = screen.getByRole('link', { name: 'Review' });
    expect(link).toHaveAttribute('href', '/app/docs?filter=needs-review');
    expectTouchTarget(link);
  });

  it('a target outside /app renders no action at all', () => {
    renderCarousel([{ ...ALERTS[1], target: { route: '/agentbook/expenses' as never } }]);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('a tax-deadline alert opens chat with its topic (prefill only)', () => {
    renderCarousel([{ id: 't1', kind: 'tax_deadline', severity: 'warn', params: { days: 5, amountCents: 300_000 }, target: { route: '/app/chat', query: { topic: 'tax_deadline' } } }]);
    expect(carousel()).toHaveTextContent('Tax payment of CA$3,000 due in 5 days');
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/app/chat?topic=tax_deadline');
  });
});

describe('useAlertAction — Remind in place', () => {
  it('Remind posts in place: "Reminded" before the server answers, "Reminder logged" once it does, then reloads', async () => {
    let answer!: (r: Response) => void;
    const fetchMock = routeFetch({ [REMIND_URL]: () => new Promise<Response>((r) => { answer = r; }) });
    const onDone = vi.fn();
    renderCarousel([ALERTS[0]], onDone);
    const btn = screen.getByRole('button', { name: 'Remind' });
    expectTouchTarget(btn);
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: 'Reminded' })).toHaveAttribute('aria-disabled', 'true');
    // The server has not answered: nothing claims the reminder was logged yet.
    expect(politeToasts().textContent).toBe('');
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { answer(jsonResponse(200, { success: true, data: { delivered: false, tone: 'gentle' } })); });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(politeToasts()).toHaveTextContent('Reminder logged');
    // Email delivery is deferred server-side: the UI must never claim it went out.
    expect(document.body).not.toHaveTextContent(/sent/i);
    expect(screen.getByRole('button', { name: 'Reminded' })).toHaveAttribute('aria-disabled', 'true');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REMIND_URL);
    expect(init.method).toBe('POST');
  });

  it('a failed Remind rolls back and says so in our words (never the server message), and does not reload', async () => {
    routeFetch({ [REMIND_URL]: () => jsonResponse(422, { success: false, error: 'Cannot remind — invoice is paid' }) });
    const onDone = vi.fn();
    renderCarousel([ALERTS[0]], onDone);
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(urgentToasts()).toHaveTextContent('That didn’t go through — try again'));
    expect(screen.getByRole('button', { name: 'Remind' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(document.body).not.toHaveTextContent('Cannot remind');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a rate limit, an offline drop and a network error each get their own copy', async () => {
    const replies: Array<() => Response | Error> = [
      () => jsonResponse(429, { success: false, error: 'Slow down there' }, { 'Retry-After': '30' }),
      () => jsonResponse(503, {}, { 'X-Agentbook-Offline': '1' }),
      () => new TypeError('Failed to fetch'),
    ];
    let call = 0;
    routeFetch({ [REMIND_URL]: () => replies[call++]() });
    const onDone = vi.fn();
    renderCarousel([ALERTS[0]], onDone);

    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(urgentToasts()).toHaveTextContent('Too many requests — wait a moment and try again'));
    expect(document.body).not.toHaveTextContent('Slow down there');

    fireEvent.click(await screen.findByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(urgentToasts()).toHaveTextContent('You’re offline — reconnect and try again'));

    fireEvent.click(await screen.findByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(urgentToasts().textContent?.match(/You’re offline — reconnect and try again/g)).toHaveLength(2));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remind' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('unauthorized: signed-out copy, the session’s snapshots are dropped, and the screen reloads into its signed-out state', async () => {
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, JSON.stringify({ data: { secret: 1 }, savedAt: '2026-10-07T00:00:00.000Z' }));
    const cleared = vi.fn();
    window.addEventListener(SNAPSHOT_CLEARED_EVENT, cleared);
    routeFetch({ [REMIND_URL]: () => jsonResponse(401, { success: false, error: 'invalid session' }) });
    const onDone = vi.fn();
    renderCarousel([ALERTS[0]], onDone);
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(urgentToasts()).toHaveTextContent('You’ve been signed out — sign in and try again'));
    window.removeEventListener(SNAPSHOT_CLEARED_EVENT, cleared);
    expect(document.body).not.toHaveTextContent('invalid session');
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect((cleared.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: 'unauthorized' });
    // No stale optimistic state survives, and the screen is told to re-read (it lands in its 401 state).
    expect(screen.getByRole('button', { name: 'Remind' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(politeToasts()).not.toHaveTextContent('Reminder logged');
  });

  it('a double tap sends one request', async () => {
    let answer!: (r: Response) => void;
    const fetchMock = routeFetch({ [REMIND_URL]: () => new Promise<Response>((r) => { answer = r; }) });
    renderCarousel([ALERTS[0]]);
    const btn = screen.getByRole('button', { name: 'Remind' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => { answer(jsonResponse(200, { success: true, data: {} })); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('run() called twice synchronously (before any re-render) still sends one request, and never rejects', async () => {
    let answer!: (r: Response) => void;
    const fetchMock = routeFetch({ [REMIND_URL]: () => new Promise<Response>((r) => { answer = r; }) });
    let actions!: ReturnType<typeof useAlertAction>;
    function Grab() {
      actions = useAlertAction(() => {});
      return null;
    }
    renderWithI18n(<ToastHost><Grab /></ToastHost>);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = actions.run(ALERTS[0]);
      second = actions.run(ALERTS[0]);
    });
    await act(async () => { answer(jsonResponse(500, { success: false, error: 'boom' })); });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a steered endpoint is refused before any fetch and rolls back', async () => {
    const fetchMock = routeFetch({});
    const onDone = vi.fn();
    const evil: MobileAlert = { ...ALERTS[0], action: { type: 'post', endpoint: 'https://evil.example/remind', labelKey: 'mobile.alerts.action_remind' } };
    renderCarousel([evil], onDone);
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(urgentToasts()).toHaveTextContent('That didn’t go through — try again'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remind' })).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('AlertCarousel — localized', () => {
  it('localizes the card (fr-CA)', () => {
    renderCarousel([ALERTS[1]], undefined, 'fr-CA');
    expect(carousel()).toHaveTextContent('3 éléments attendent votre vérification');
    expect(screen.getByRole('link', { name: 'Vérifier' })).toBeInTheDocument();
  });

  it('localizes the controls and roles (zh-CN)', () => {
    renderCarousel(ALERTS, undefined, 'zh-CN');
    expect(screen.getByRole('button', { name: '下一条提醒' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一条提醒' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '需要关注的事项' })).toHaveAttribute('aria-roledescription', '轮播');
    expect(screen.getByRole('group', { name: '第 1 条提醒，共 3 条' })).toHaveAttribute('aria-roledescription', '幻灯片');
  });
});
