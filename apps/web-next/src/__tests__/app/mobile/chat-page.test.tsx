import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { installFetch, json, withShell, type Call } from './chat-test-utils';

vi.mock('@/app/app/_lib/image', () => ({ compressImage: vi.fn(async (f: File) => f) }));

import MobileChat from '../../../app/app/chat/page';

const THREAD = { id: 'th1', channel: 'web', chatId: 'maya', status: 'active', lastActiveAt: '2026-10-07T00:00:00Z', summary: null, lastTurn: null };
const MSG = '/api/v1/agentbook-core/agent/message';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ok = (data: unknown) => json(200, { success: true, data });

function server(opts: {
  turns?: unknown[] | null;          // null = no web thread
  threadsStatus?: number;
  reply?: (call: Call) => Response | Promise<Response>;
}) {
  return installFetch(async (call) => {
    if (call.path === '/api/v1/agentbook-core/threads') {
      if (opts.threadsStatus && opts.threadsStatus !== 200) return json(opts.threadsStatus, { success: false, error: 'boom' });
      return ok(opts.turns === null || opts.turns === undefined ? [] : [THREAD]);
    }
    if (call.path === '/api/v1/agentbook-core/threads/th1/turns') return ok(opts.turns ?? []);
    if (call.path === MSG && call.method === 'POST') {
      return opts.reply ? opts.reply(call) : ok({ message: 'ok', skillUsed: 'general-question', confidence: 1 });
    }
    return json(404, { success: false, error: `unmocked ${call.method} ${call.path}` });
  });
}
const posts = (calls: Call[]) => calls.filter((c) => c.path === MSG && c.method === 'POST');
const type = (text: string) => fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
const send = () => fireEvent.click(screen.getByTestId('chat-send'));

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('MobileChat — history states', () => {
  it('loading: shows a labelled loading state while history is in flight', async () => {
    installFetch(() => new Promise<Response>(() => {}));
    render(withShell(<MobileChat />));
    expect(screen.getByTestId('chat-history-loading')).toHaveTextContent('Loading your conversation…');
  });

  it('brand-new: empty state with three starter chips; a chip sends its text', async () => {
    const { calls } = server({ turns: null });
    render(withShell(<MobileChat />));
    const empty = await screen.findByTestId('chat-empty');
    expect(empty).toHaveTextContent('Ask me anything about your books');
    const chips = within(empty).getAllByTestId('chat-starter');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Give me a daily briefing', 'How much did I spend this month?', 'Log $5 coffee',
    ]);
    fireEvent.click(chips[1]);
    await screen.findByText('ok');
    expect(posts(calls)[0].body).toMatchObject({ text: 'How much did I spend this month?' });
  });

  it('error: shows the error with Retry; Retry reloads and renders history', async () => {
    let fail = true;
    installFetch(async (call) => {
      if (call.path === '/api/v1/agentbook-core/threads') {
        if (fail) return json(500, { success: false, error: 'boom' });
        return ok([THREAD]);
      }
      if (call.path === '/api/v1/agentbook-core/threads/th1/turns') {
        return ok([{ role: 'user', text: 'old question', at: ago(9000) }, { role: 'bot', text: 'old answer', at: ago(8000) }]);
      }
      return json(404, {});
    });
    render(withShell(<MobileChat />));
    const err = await screen.findByTestId('chat-history-error');
    expect(err).toHaveTextContent("Couldn't load your conversation.");
    fail = false;
    fireEvent.click(screen.getByTestId('chat-history-retry'));
    expect(await screen.findByText('old answer')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-history-error')).toBeNull();
  });

  it('populated: renders turns oldest-first with formatting', async () => {
    server({ turns: [
      { role: 'user', text: 'first', at: ago(9000) },
      { role: 'bot', text: 'You spent **$12.00**', at: ago(8000) },
    ] });
    render(withShell(<MobileChat />));
    await screen.findByText('$12.00');
    const bubbles = screen.getAllByTestId(/chat-bubble-(user|bot)/);
    expect(bubbles.map((b) => b.getAttribute('data-testid'))).toEqual(['chat-bubble-user', 'chat-bubble-bot']);
    expect(screen.getByText('$12.00').tagName).toBe('STRONG');
  });

  it('pending plan from history: Pending action card posts confirm', async () => {
    const { calls } = server({
      turns: [
        { role: 'user', text: 'edit my last expense', at: ago(60_000) },
        { role: 'bot', text: "Here's my plan:\n1. Edit expense last", at: ago(59_000), intent: 'planner' },
      ],
      reply: () => ok({ message: 'Expense updated.' }),
    });
    render(withShell(<MobileChat />));
    const card = await screen.findByTestId('chat-plan-pending');
    fireEvent.click(within(card).getByTestId('chat-plan-proceed'));
    await screen.findByText('Expense updated.');
    expect(posts(calls)[0].body).toMatchObject({ sessionAction: 'confirm' });
    expect((posts(calls)[0].body as { text?: string }).text ?? '').toBe('');
  });

  it('stale planner turn (older than 24h) shows no pending card', async () => {
    server({ turns: [{ role: 'bot', text: 'plan', at: ago(25 * 3600_000), intent: 'planner' }] });
    render(withShell(<MobileChat />));
    await screen.findByText('plan');
    expect(screen.queryByTestId('chat-plan-pending')).toBeNull();
  });
});

describe('MobileChat — sending', () => {
  it('shows the typing indicator while waiting, then the reply', async () => {
    let release: (r: Response) => void = () => {};
    server({ turns: [], reply: () => new Promise<Response>((r) => { release = r; }) });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('hi');
    send();
    expect(await screen.findByRole('status', { name: 'Advisor is typing' })).toBeInTheDocument();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
    release(ok({ message: 'Hello Maya' }));
    await screen.findByText('Hello Maya');
    expect(screen.queryByTestId('chat-typing')).toBeNull();
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('send is disabled for blank text', async () => {
    server({ turns: [] });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('   ');
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  it('plan reply: Proceed posts confirm, card resolves, no further buttons', async () => {
    let n = 0;
    const { calls } = server({
      turns: [],
      reply: () => (++n === 1
        ? ok({ message: "Here's my plan:\n\n1. Edit expense last (irreversible)\n\nProceed? (yes/no)", plan: { steps: [{ id: 'step-1', description: 'Edit expense last' }], requiresConfirmation: true }, sessionId: 's1' })
        : ok({ message: 'Expense updated.' })),
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('edit my last expense');
    send();
    const card = await screen.findByTestId('chat-plan-card');
    expect(card).toHaveTextContent('Edit expense last');
    fireEvent.click(within(card).getByTestId('chat-plan-proceed'));
    await screen.findByText('Expense updated.');
    expect(posts(calls)[1].body).toMatchObject({ sessionAction: 'confirm' });
    expect(within(screen.getByTestId('chat-plan-card')).queryByTestId('chat-plan-proceed')).toBeNull();
    expect(screen.getByTestId('chat-plan-card')).toHaveAttribute('data-state', 'done');
  });

  it('plan reply: Cancel posts cancel', async () => {
    let n = 0;
    const { calls } = server({
      turns: [],
      reply: () => (++n === 1
        ? ok({ message: 'plan', plan: { steps: [{ id: 's', description: 'x' }], requiresConfirmation: true } })
        : ok({ message: 'Plan cancelled.' })),
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('edit my last expense');
    send();
    fireEvent.click(await screen.findByTestId('chat-plan-cancel'));
    await screen.findByText('Plan cancelled.');
    expect(posts(calls)[1].body).toMatchObject({ sessionAction: 'cancel' });
  });

  it('suggestion chips send their text', async () => {
    let n = 0;
    const { calls } = server({
      turns: [],
      reply: () => (++n === 1 ? ok({ message: 'Done.', suggestions: ['Show my expenses'] }) : ok({ message: 'Here they are.' })),
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('hi');
    send();
    fireEvent.click(await screen.findByTestId('chat-suggestion'));
    await screen.findByText('Here they are.');
    expect(posts(calls)[1].body).toMatchObject({ text: 'Show my expenses' });
    expect(screen.getAllByTestId('chat-bubble-user').map((b) => b.textContent)).toEqual(['hi', 'Show my expenses']);
  });

  it('undo: posts sessionAction undo and hides the button afterwards', async () => {
    let n = 0;
    const { calls } = server({
      turns: [],
      reply: () => (++n === 1 ? ok({ message: 'Recorded $5 coffee', undoAvailable: true }) : ok({ message: 'Undone: coffee', undoAvailable: false })),
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('log $5 coffee');
    send();
    fireEvent.click(await screen.findByTestId('chat-undo'));
    await screen.findByText('Undone: coffee');
    expect(posts(calls)[1].body).toMatchObject({ sessionAction: 'undo' });
    expect(screen.queryByTestId('chat-undo')).toBeNull();
  });

  it('server failure: inline Retry preserves the text and resends it', async () => {
    let n = 0;
    const { calls } = server({
      turns: [],
      reply: () => (++n === 1 ? json(500, { success: false, error: 'agent brain failed', message: 'x' }) : ok({ message: 'Second time lucky' })),
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('keep this text');
    send();
    const bubble = await screen.findByText('keep this text');
    await waitFor(() => expect(screen.getByTestId('chat-bubble-user')).toHaveAttribute('data-status', 'failed'));
    expect(screen.getByText('Not sent.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-retry'));
    await screen.findByText('Second time lucky');
    expect(bubble).toBeInTheDocument();
    expect(screen.getByTestId('chat-bubble-user')).toHaveAttribute('data-status', 'sent');
    expect(posts(calls).map((c) => (c.body as { text: string }).text)).toEqual(['keep this text', 'keep this text']);
  });

  it('offline failure uses the offline copy and shows the offline banner', async () => {
    server({ turns: [], reply: () => Promise.reject(new TypeError('Failed to fetch')) });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByTestId('chat-offline')).toHaveTextContent("You're offline.");
    type('hi');
    send();
    expect(await screen.findByText("You're offline — not sent.")).toBeInTheDocument();
  });

  it('429: shows the server message, disables send + retry, re-enables after retryAfterMs', async () => {
    server({
      turns: [],
      reply: () => json(429, { success: false, error: 'rate_limited', reason: 'minute', retryAfterMs: 1200, message: 'Slow down — try again shortly.', locale: 'en' }, { 'Retry-After': '2' }),
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('hi');
    send();
    const notice = await screen.findByTestId('chat-ratelimit');
    expect(notice).toHaveTextContent('Slow down — try again shortly.');
    expect(notice).toHaveTextContent(/Send available in \ds/);
    type('again');
    expect(screen.getByTestId('chat-send')).toBeDisabled();
    expect(screen.getByTestId('chat-retry')).toBeDisabled();
    await waitFor(() => expect(screen.queryByTestId('chat-ratelimit')).toBeNull(), { timeout: 3500 });
    expect(screen.getByTestId('chat-send')).toBeEnabled();
    expect(screen.getByTestId('chat-retry')).toBeEnabled();
  });
});

describe('MobileChat — localization', () => {
  it('renders zh-CN copy from the catalog (no hardcoded English)', async () => {
    server({ turns: null });
    render(withShell(<MobileChat />, 'zh-CN'));
    expect(await screen.findByTestId('chat-empty')).toHaveTextContent('关于账目，尽管问我');
    expect(screen.getByTestId('chat-header')).toHaveTextContent('咨询您的顾问');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeInTheDocument();
  });
});

describe('MobileChat — invariants', () => {
  const FROM_RECEIPT = '/api/v1/agentbook-expense/expenses/from-receipt';
  const doc = { id: 'doc9', amountCents: 500, vendorName: 'Cafe', status: 'confirmed' };

  it('receipt retry reuses the SAME idempotencyKey (no second expense)', async () => {
    let n = 0;
    const keys: string[] = [];
    installFetch(async (call) => {
      if (call.path === '/api/v1/agentbook-core/threads') return ok([]);
      if (call.path === FROM_RECEIPT) {
        keys.push((call.body as FormData).get('idempotencyKey') as string);
        return ++n === 1
          ? json(500, { success: false, error: 'boom' })
          : ok({ doc, duplicate: false, ocr: { amountCents: 500, vendor: 'Cafe', date: null } });
      }
      return json(404, {});
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    const file = new File([new Uint8Array(10)], 'r.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('chat-file-library'), { target: { files: [file] } });
    fireEvent.click(await screen.findByTestId('chat-receipt-retry'));
    await screen.findByTestId('chat-receipt-open');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('429 keeps the transcript; Proceed/Cancel/Undo stay enabled, send disabled', async () => {
    let n = 0;
    const { calls } = server({
      turns: [],
      reply: () => {
        n++;
        if (n === 1) return ok({ message: 'plan', plan: { steps: [{ id: 's', description: 'x' }], requiresConfirmation: true } });
        if (n === 2) return ok({ message: 'Recorded', undoAvailable: true });
        if (n === 3) return json(429, { success: false, error: 'rate_limited', retryAfterMs: 30000, message: 'Slow down', locale: 'en' });
        return ok({ message: 'Undone' });
      },
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    type('one'); send();
    await screen.findByTestId('chat-plan-card');
    type('two'); send();
    await screen.findByTestId('chat-undo');
    type('three'); send();
    await screen.findByTestId('chat-ratelimit');
    // transcript intact
    expect(screen.getAllByTestId('chat-bubble-user')).toHaveLength(3);
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.getByText('three')).toBeInTheDocument();
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
    expect(screen.getByTestId('chat-plan-proceed')).toBeEnabled();
    expect(screen.getByTestId('chat-plan-cancel')).toBeEnabled();
    expect(screen.getByTestId('chat-undo')).toBeEnabled();
    fireEvent.click(screen.getByTestId('chat-undo'));
    await screen.findByText('Undone');
    expect(posts(calls).at(-1)!.body).toMatchObject({ sessionAction: 'undo' });
  });
});
