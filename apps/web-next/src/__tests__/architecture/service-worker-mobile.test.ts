// @vitest-environment node
/**
 * sw.js, executed. The invariants file pins the SOURCE; this runs the worker
 * in a vm sandbox with fake caches/fetch/clients and dispatches real events,
 * so a rule that reads right but routes wrong still fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SW_SOURCE = readFileSync(join(__dirname, '..', '..', '..', 'public', 'sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

function loadWorker() {
  const handlers: Record<string, Handler> = {};
  const cachePut = vi.fn(async (_req: unknown, _res: unknown) => undefined);
  const caches = {
    open: vi.fn(async (_name: string) => ({ put: cachePut, addAll: vi.fn(async (_urls: string[]) => undefined) })),
    match: vi.fn(async (_req: unknown) => undefined),
    keys: vi.fn(async () => ['agentbook-static-v5', 'agentbook-api-v5', 'agentbook-static-v6', 'agentbook-api-v6']),
    delete: vi.fn(async (_name: string) => true),
  };
  const fetchMock = vi.fn(async (_req: unknown) => new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const openWindow = vi.fn(async (_url: string) => null);
  const self = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), openWindow },
    registration: { showNotification: vi.fn() },
  };
  vm.runInContext(SW_SOURCE, vm.createContext({ self, caches, fetch: fetchMock, Response, URL, FormData, console }));
  return { handlers, caches, fetchMock, openWindow };
}

async function dispatchFetch(w: ReturnType<typeof loadWorker>, url: string) {
  let responded: Promise<Response> | undefined;
  const request = { url, method: 'GET', mode: 'cors' };
  w.handlers.fetch({ request, respondWith: (p: Promise<Response>) => { responded = p; } });
  expect(responded, `no respondWith for ${url}`).toBeDefined();
  await responded;
  await new Promise((r) => setTimeout(r, 0)); // let any un-awaited cache write run
  return request;
}

describe('sw.js — mobile routes', () => {
  it.each([
    'https://agentbook.brainliber.com/api/v1/agentbook-core/mobile/home',
    'https://agentbook.brainliber.com/api/v1/agentbook-core/calendar/upcoming?days=30',
  ])('%s goes straight to the network and touches no cache', async (url) => {
    const w = loadWorker();
    const request = await dispatchFetch(w, url);
    expect(w.fetchMock).toHaveBeenCalledWith(request);
    expect(w.caches.open).not.toHaveBeenCalled();
    expect(w.caches.match).not.toHaveBeenCalled();
  });

  it('control: an ordinary API GET IS written to the v6 API cache (proves the harness can see a write)', async () => {
    const w = loadWorker();
    await dispatchFetch(w, 'https://agentbook.brainliber.com/api/v1/agentbook-expense/expenses?limit=30');
    expect(w.caches.open).toHaveBeenCalledWith('agentbook-api-v6');
  });

  it('activate deletes the v5 caches and keeps v6', async () => {
    const w = loadWorker();
    let waited: Promise<unknown> | undefined;
    w.handlers.activate({ waitUntil: (p: Promise<unknown>) => { waited = p; } });
    await waited;
    const deleted = w.caches.delete.mock.calls.map((c) => c[0]);
    expect(deleted.sort()).toEqual(['agentbook-api-v5', 'agentbook-static-v5']);
  });

  it('a notification tap with no url opens /app; with a url, that url', async () => {
    const w = loadWorker();
    const tap = (data: Record<string, unknown>) =>
      w.handlers.notificationclick({ notification: { close: vi.fn(), data }, waitUntil: () => undefined });
    tap({});
    tap({ url: '/app/docs?filter=needs-review' });
    expect(w.openWindow.mock.calls.map((c) => c[0])).toEqual(['/app', '/app/docs?filter=needs-review']);
  });
});
