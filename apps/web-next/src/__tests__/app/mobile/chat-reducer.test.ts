import { describe, it, expect } from 'vitest';
import {
  chatReducer, initialChatState, historyToItems, classifyFailure, retryAfterFrom, serverMessage,
  PENDING_PLAN_TTL_MS, DEFAULT_RETRY_AFTER_MS, type ChatState, type BotItem, type UserItem,
} from '../../../app/app/chat/_lib/chat-reducer';
import type { ChatTurn } from '../../../app/app/_lib/api';
import type { FromReceiptResult } from '../../../lib/mobile/types';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ready = (s: Partial<ChatState> = {}): ChatState => ({ ...initialChatState, history: 'ready', ...s });

describe('historyToItems', () => {
  it('maps oldest-first turns to sent user / bot items', () => {
    const items = historyToItems(
      [
        { role: 'user', text: 'hi', at: iso(5000) },
        { role: 'bot', text: 'Hello!', at: iso(4000) },
      ] as ChatTurn[],
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'bot']);
    expect((items[0] as UserItem).status).toBe('sent');
    expect((items[1] as BotItem).pendingFromHistory).toBe(false);
  });

  it('marks a fresh trailing planner turn as a pending plan', () => {
    const items = historyToItems(
      [
        { role: 'user', text: 'edit my last expense', at: iso(60_000) },
        { role: 'bot', text: "Here's my plan:\n1. Edit expense last", at: iso(59_000), intent: 'planner' },
      ] as ChatTurn[],
      NOW,
    );
    const bot = items[1] as BotItem;
    expect(bot.pendingFromHistory).toBe(true);
    expect(bot.planState).toBe('open');
  });

  it('does not offer a plan older than the session TTL', () => {
    const items = historyToItems(
      [{ role: 'bot', text: 'plan', at: iso(PENDING_PLAN_TTL_MS + 1000), intent: 'planner' }] as ChatTurn[],
      NOW,
    );
    expect((items[0] as BotItem).pendingFromHistory).toBe(false);
  });

  it('does not offer a planner turn that is not the last turn', () => {
    const items = historyToItems(
      [
        { role: 'bot', text: 'plan', at: iso(10_000), intent: 'planner' },
        { role: 'user', text: 'never mind', at: iso(9_000) },
        { role: 'bot', text: 'ok', at: iso(8_000) },
      ] as ChatTurn[],
      NOW,
    );
    expect(items.some((i) => i.kind === 'bot' && i.pendingFromHistory)).toBe(false);
  });
});

describe('chatReducer', () => {
  it('history_loaded keeps messages the user sent while history was loading, after the history', () => {
    let s = chatReducer(initialChatState, { type: 'send_started', id: 'u1', text: 'quick' });
    s = chatReducer(s, { type: 'history_loaded', turns: [{ role: 'user', text: 'old', at: iso(1) }] as ChatTurn[], now: NOW });
    expect(s.items.map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['old', 'quick']);
    expect(s.history).toBe('ready');
  });

  it('send → reply marks the user message sent and appends the bot reply', () => {
    let s = chatReducer(ready(), { type: 'send_started', id: 'u1', text: 'hi' });
    expect(s.busy).toBe(true);
    s = chatReducer(s, { type: 'reply', userId: 'u1', replyId: 'b1', reply: { message: 'Hello', suggestions: ['a', '', 'b'] } });
    expect(s.busy).toBe(false);
    expect((s.items[0] as UserItem).status).toBe('sent');
    expect((s.items[1] as BotItem).suggestions).toEqual(['a', 'b']);
  });

  it('send_failed keeps the text; retry_started flips it back to sending', () => {
    let s = chatReducer(ready(), { type: 'send_started', id: 'u1', text: 'keep me' });
    s = chatReducer(s, { type: 'send_failed', id: 'u1', failure: 'server' });
    expect(s.items[0]).toMatchObject({ status: 'failed', text: 'keep me', failure: 'server' });
    s = chatReducer(s, { type: 'retry_started', id: 'u1' });
    expect(s.items[0]).toMatchObject({ status: 'sending', text: 'keep me' });
  });

  it('a plan reply opens a card; confirming resolves it on the next reply', () => {
    let s = chatReducer(ready(), {
      type: 'reply', userId: null, replyId: 'b1',
      reply: { message: 'plan', plan: { steps: [{ id: 'step-1', description: 'Edit expense last' }], requiresConfirmation: true } },
    });
    expect(s.items[0]).toMatchObject({ planState: 'open', plan: { steps: [{ id: 'step-1' }] } });
    s = chatReducer(s, { type: 'action_started', botId: 'b1', action: 'confirm' });
    expect(s.items[0]).toMatchObject({ planState: 'proceeding' });
    s = chatReducer(s, { type: 'reply', userId: null, replyId: 'b2', reply: { message: 'Updated.' } });
    expect(s.items[0]).toMatchObject({ planState: 'done' });
    expect(s.items[1]).toMatchObject({ planState: null, text: 'Updated.' });
  });

  it('a plan without requiresConfirmation shows no card', () => {
    const s = chatReducer(ready(), {
      type: 'reply', userId: null, replyId: 'b1',
      reply: { message: 'done', plan: { steps: [{ id: 's', description: 'x' }], requiresConfirmation: false } },
    });
    expect(s.items[0]).toMatchObject({ plan: null, planState: null });
  });

  it('a newer plan supersedes an older open one (the server expired its session)', () => {
    const plan = { steps: [{ id: 's', description: 'x' }], requiresConfirmation: true };
    let s = chatReducer(ready(), { type: 'reply', userId: null, replyId: 'b1', reply: { message: 'p1', plan } });
    s = chatReducer(s, { type: 'reply', userId: null, replyId: 'b2', reply: { message: 'p2', plan } });
    expect(s.items[0]).toMatchObject({ planState: 'done' });
    expect(s.items[1]).toMatchObject({ planState: 'open' });
  });

  it('action_failed reopens the card and appends an error item', () => {
    let s = chatReducer(ready(), {
      type: 'reply', userId: null, replyId: 'b1',
      reply: { message: 'p', plan: { steps: [], requiresConfirmation: true } },
    });
    s = chatReducer(s, { type: 'action_started', botId: 'b1', action: 'cancel' });
    s = chatReducer(s, { type: 'action_failed', botId: 'b1', errorId: 'e1', restoreUndo: false });
    expect(s.items[0]).toMatchObject({ planState: 'open' });
    expect(s.items[1]).toMatchObject({ kind: 'bot', errorKey: 'action_failed' });
    expect(s.busy).toBe(false);
  });

  it('undo is offered only on the latest reply and cleared when used', () => {
    let s = chatReducer(ready(), { type: 'reply', userId: null, replyId: 'b1', reply: { message: 'Recorded', undoAvailable: true } });
    s = chatReducer(s, { type: 'undo_started', botId: 'b1' });
    expect(s.items[0]).toMatchObject({ undoAvailable: false });
    s = chatReducer(s, { type: 'action_failed', botId: 'b1', errorId: 'e1', restoreUndo: true });
    expect(s.items[0]).toMatchObject({ undoAvailable: true });
    s = chatReducer(s, { type: 'reply', userId: null, replyId: 'b2', reply: { message: 'next', undoAvailable: false } });
    expect(s.items[0]).toMatchObject({ undoAvailable: false });
  });

  it('rate_limited / rate_limit_cleared', () => {
    let s = chatReducer(ready(), { type: 'rate_limited', until: NOW + 5000, message: 'Slow down' });
    expect(s).toMatchObject({ rateLimitedUntil: NOW + 5000, rateLimitMessage: 'Slow down' });
    s = chatReducer(s, { type: 'rate_limit_cleared' });
    expect(s).toMatchObject({ rateLimitedUntil: null, rateLimitMessage: null });
  });

  it('a rate limit never touches the transcript', () => {
    const items = [
      { kind: 'user', id: 'u1', text: 'hello', status: 'failed' },
      { kind: 'bot', id: 'b1', text: 'Hi', undoAvailable: true },
    ] as unknown as ChatState['items'];
    const before = ready({ items });
    let s = chatReducer(before, { type: 'rate_limited', until: NOW + 5000, message: 'Slow down' });
    expect(s.items).toBe(before.items);
    s = chatReducer(s, { type: 'rate_limit_cleared' });
    expect(s.items).toBe(before.items);
  });

  it('receipt lifecycle keeps one item per id across a retry', () => {
    const result = { doc: { id: 'd1' }, duplicate: false, ocr: { amountCents: 450, vendor: 'Cafe', date: null } } as unknown as FromReceiptResult;
    let s = chatReducer(ready(), { type: 'receipt_started', id: 'r1', idempotencyKey: 'k1' });
    s = chatReducer(s, { type: 'receipt_failed', id: 'r1' });
    s = chatReducer(s, { type: 'receipt_started', id: 'r1', idempotencyKey: 'k1' });
    s = chatReducer(s, { type: 'receipt_done', id: 'r1', result });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'receipt', status: 'done', idempotencyKey: 'k1', result });
  });
});

describe('error helpers', () => {
  it('classifyFailure', () => {
    expect(classifyFailure({ status: 429 }, true)).toBe('rate_limited');
    expect(classifyFailure({ status: 500 }, false)).toBe('offline');
    expect(classifyFailure(new TypeError('Failed to fetch'), true)).toBe('offline');
    expect(classifyFailure({ status: 503, code: 'offline' }, true)).toBe('offline');
    expect(classifyFailure({ status: 0 }, true)).toBe('offline');
    expect(classifyFailure({ status: 500 }, true)).toBe('server');
  });
  it('retryAfterFrom falls back to the route default', () => {
    expect(retryAfterFrom({ retryAfterMs: 1500 })).toBe(1500);
    expect(retryAfterFrom({})).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterFrom({ retryAfterMs: -1 })).toBe(DEFAULT_RETRY_AFTER_MS);
  });
  it('serverMessage ignores machine codes', () => {
    expect(serverMessage(new Error('Slow down'))).toBe('Slow down');
    expect(serverMessage(new Error('rate_limited'))).toBeNull();
    expect(serverMessage(new Error(''))).toBeNull();
    expect(serverMessage('nope')).toBeNull();
  });
});
