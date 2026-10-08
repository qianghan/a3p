import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, sendChat, loadChatHistory } from '@/app/app/_lib/api';
import { jsonResponse, routeFetch } from './test-utils';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  // stubGlobal records the real fetch so afterEach restores it — including
  // when a test replaces it again through routeFetch.
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const BRAIN_REPLY = {
  success: true,
  data: {
    message: 'I can record 3 expenses. Proceed?',
    skillUsed: 'record-expense',
    confidence: 0.9,
    plan: {
      requiresConfirmation: true,
      steps: [
        { id: 's1', action: 'record-expense', description: 'Record $12 coffee', params: {}, dependsOn: [], canUndo: true, status: 'pending' },
        { id: 's2', action: 'record-expense', description: 'Record $40 taxi', params: {}, dependsOn: [], canUndo: true, status: 'pending' },
      ],
    },
    suggestions: ['Show my expenses', 42, 'What do I owe?'],
    undoAvailable: false,
    sessionId: 'sess-1',
  },
};

describe('sendChat', () => {
  it('posts text and maps the brain reply to ChatReply', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, BRAIN_REPLY));
    const reply = await sendChat({ text: 'spent 12 on coffee and 40 on taxi' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agentbook-core/agent/message');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ text: 'spent 12 on coffee and 40 on taxi' });
    expect(reply).toEqual({
      message: 'I can record 3 expenses. Proceed?',
      plan: {
        requiresConfirmation: true,
        steps: [
          { id: 's1', description: 'Record $12 coffee', status: 'pending' },
          { id: 's2', description: 'Record $40 taxi', status: 'pending' },
        ],
      },
      suggestions: ['Show my expenses', 'What do I owe?'],
      undoAvailable: false,
      sessionId: 'sess-1',
    });
  });

  it('sends a session action with no text (Proceed / Cancel)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { message: 'Done — 2 recorded.' } }));
    const reply = await sendChat({ sessionAction: 'confirm' });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ sessionAction: 'confirm' });
    expect(reply).toEqual({ message: 'Done — 2 recorded.' });
  });

  it('forwards photo attachments', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { message: 'Got it' } }));
    await sendChat({ text: 'this one', attachments: [{ type: 'photo', url: 'https://x.public.blob.vercel-storage.com/a.jpg' }] });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).attachments).toEqual([
      { type: 'photo', url: 'https://x.public.blob.vercel-storage.com/a.jpg' },
    ]);
  });

  it('refuses an empty message without calling the server', async () => {
    await expect(sendChat({ text: '   ' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 429 rejects with the server message and retryAfterMs (send stays disabled that long)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { success: false, error: 'rate_limited', reason: 'minute', retryAfterMs: 20_000, message: 'Slow down — try again in a minute.' }, { 'Retry-After': '20' }),
    );
    const err = await sendChat({ text: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterMs: 20_000, message: 'Slow down — try again in a minute.' });
  });

  it('a 500 rejects with the public message the route sends', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false, error: 'agent brain failed', message: 'Something went wrong.' }));
    await expect(sendChat({ text: 'hi' })).rejects.toMatchObject({ status: 500, message: 'Something went wrong.' });
  });
});

describe('loadChatHistory', () => {
  it('asks for the active web thread and picks the MOST RECENT by lastActiveAt, not by array index', async () => {
    const mock = routeFetch({
      '/api/v1/agentbook-core/threads?': () =>
        jsonResponse(200, {
          success: true,
          data: [
            { id: 'old', channel: 'web', status: 'active', lastActiveAt: '2026-10-01T10:00:00.000Z' },
            { id: 'new', channel: 'web', status: 'active', lastActiveAt: '2026-10-07T10:00:00.000Z' },
          ],
        }),
      '/api/v1/agentbook-core/threads/new/turns': () => jsonResponse(200, { success: true, data: [] }),
      '/api/v1/agentbook-core/threads/old/turns': () => jsonResponse(500, { success: false, error: 'wrong thread' }),
    });
    await expect(loadChatHistory()).resolves.toEqual([]);
    const urls = mock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe('/api/v1/agentbook-core/threads?channel=web&status=active');
    expect(urls).toContain('/api/v1/agentbook-core/threads/new/turns');
  });

  it('returns turns OLDEST-FIRST by timestamp even when the server sends them newest-first', async () => {
    routeFetch({
      '/api/v1/agentbook-core/threads?': () =>
        jsonResponse(200, { success: true, data: [{ id: 't1', channel: 'web', status: 'active', lastActiveAt: '2026-10-07T10:00:00.000Z' }] }),
      '/api/v1/agentbook-core/threads/t1/turns': () =>
        jsonResponse(200, {
          success: true,
          data: [
            { role: 'bot', text: 'Recorded $12 coffee.', at: '2026-10-07T10:00:03.000Z' },
            { role: 'user', text: 'spent 12 on coffee', at: '2026-10-07T10:00:01.000Z' },
            { role: 'assistant', text: 'Hi Maya', at: '2026-10-07T09:59:00.000Z' },
            { role: 'user', text: '', at: '2026-10-07T09:58:00.000Z' },
            { role: 'user', text: 'no timestamp' },
          ],
        }),
    });
    await expect(loadChatHistory()).resolves.toEqual([
      { role: 'bot', text: 'Hi Maya', at: '2026-10-07T09:59:00.000Z' },
      { role: 'user', text: 'spent 12 on coffee', at: '2026-10-07T10:00:01.000Z' },
      { role: 'bot', text: 'Recorded $12 coffee.', at: '2026-10-07T10:00:03.000Z' },
    ]);
  });

  it('passes a string intent through (so Chat can rebuild a pending-plan card) and drops a non-string one', async () => {
    routeFetch({
      '/api/v1/agentbook-core/threads?': () =>
        jsonResponse(200, { success: true, data: [{ id: 't1', channel: 'web', status: 'active', lastActiveAt: '2026-10-07T10:00:00.000Z' }] }),
      '/api/v1/agentbook-core/threads/t1/turns': () =>
        jsonResponse(200, {
          success: true,
          data: [
            { role: 'bot', text: "Here's my plan", at: '2026-10-07T10:00:03.000Z', intent: 'planner' },
            { role: 'user', text: 'edit my last expense', at: '2026-10-07T10:00:01.000Z', intent: 42 },
          ],
        }),
    });
    await expect(loadChatHistory()).resolves.toEqual([
      { role: 'user', text: 'edit my last expense', at: '2026-10-07T10:00:01.000Z' },
      { role: 'bot', text: "Here's my plan", at: '2026-10-07T10:00:03.000Z', intent: 'planner' },
    ]);
  });

  it('no active web thread means an empty history and a single request', async () => {
    const mock = routeFetch({ '/api/v1/agentbook-core/threads?': () => jsonResponse(200, { success: true, data: [] }) });
    await expect(loadChatHistory()).resolves.toEqual([]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('a failing thread list rejects (the screen shows its error state, not an empty chat)', async () => {
    routeFetch({ '/api/v1/agentbook-core/threads?': () => jsonResponse(500, { success: false, error: 'x' }) });
    await expect(loadChatHistory()).rejects.toBeInstanceOf(ApiError);
  });
});
