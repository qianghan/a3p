import React from 'react';
import { vi } from 'vitest';
import { ShellContextReact } from '@/contexts/shell-context';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

export interface Call { method: string; path: string; body: unknown }

/** Mock global fetch (never the api module): api.ts's real request/error code runs. */
export function installFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* keep raw string */ }
    }
    const call = { method, path, body };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Real translator + CAD money, so tests assert real copy and catch hardcoded strings. */
export function withShell(ui: React.ReactElement, locale = 'en') {
  const tr = createTranslator(locale, CATALOG);
  const value = {
    i18n: {
      locale,
      currency: 'CAD',
      t: (k: string, p?: Record<string, string | number>) => tr.t(k, p),
      formatMoney: (cents: number) =>
        new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100),
    },
  } as unknown as React.ContextType<typeof ShellContextReact>;
  return <ShellContextReact.Provider value={value}>{ui}</ShellContextReact.Provider>;
}
