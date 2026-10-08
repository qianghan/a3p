/**
 * Shared helpers for the /app PWA tests.
 *
 * renderWithI18n puts a REAL translator on ShellContext (the same
 * createTranslator + CATALOG the shell builds), so a test asserting English
 * text proves the catalog key exists — useT's provider-less fallback would
 * otherwise humanise `mobile.tabs.home` into "Home" and pass on a typo.
 */
import React from 'react';
import { render, fireEvent, type RenderOptions } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';
import { ShellContextReact } from '@/contexts/shell-context';
import { tokens } from '@/app/app/_kit/tokens';

export function i18nT(locale = 'en') {
  return createTranslator(locale, CATALOG).t;
}

function shellValue(locale: string) {
  return { i18n: { t: i18nT(locale), locale, currency: 'USD', ready: true } } as never;
}

export function renderWithI18n(ui: React.ReactElement, locale = 'en', options?: Omit<RenderOptions, 'wrapper'>) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ShellContextReact.Provider value={shellValue(locale)}>{children}</ShellContextReact.Provider>
  );
  return render(ui, { wrapper: Wrapper, ...options });
}

const TOKEN_COLOUR = /hsl\(var\(--[a-z-]+\)(?: \/ [\d.]+)?\)/g;

/** Every colour in a style object is a kit token — no hex, no ad-hoc rgb()/hsl(). */
export function expectTokenOnly(style: React.CSSProperties): void {
  for (const [prop, raw] of Object.entries(style)) {
    if (typeof raw !== 'string') continue;
    expect(raw, `${prop} uses a raw hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const rest = raw.split(tokens.color.scrim).join('').replace(TOKEN_COLOUR, '');
    expect(rest, `${prop} has a colour that is not a token: ${raw}`).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
  }
}

/** WCAG 2.5.5 / spec §3.6: every interactive target is at least 44×44 CSS px. */
export function expectTouchTarget(el: HTMLElement): void {
  expect(parseFloat(el.style.minHeight), `${el.tagName} min-height`).toBeGreaterThanOrEqual(44);
  expect(parseFloat(el.style.minWidth), `${el.tagName} min-width`).toBeGreaterThanOrEqual(44);
}

/** A fetch Response stand-in with a JSON body (or a body whose json() rejects). */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A Response whose body is not JSON — e.g. Vercel's plain-text 413 or an HTML 502. */
export function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.reject(new SyntaxError(`Unexpected token in JSON: ${text.slice(0, 20)}`)),
  } as unknown as Response;
}

type RouteHandler = (url: string, init?: RequestInit) => Response | Error | Promise<Response>;

/** Install a global fetch that dispatches on URL prefix; unmatched URLs answer 404. */
export function routeFetch(routes: Record<string, RouteHandler>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const prefix = Object.keys(routes)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) return jsonResponse(404, { success: false, error: `unmocked ${url}` });
    const out = await routes[prefix](url, init);
    if (out instanceof Error) throw out;
    return out;
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

/**
 * Dispatch a touch event jsdom can't construct natively (it has no Touch
 * constructor). React reads `touches` / `changedTouches` off the native event.
 */
export function touch(el: Element, type: 'touchstart' | 'touchmove' | 'touchend', x: number, y: number): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const point = [{ clientX: x, clientY: y }];
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : point });
  Object.defineProperty(ev, 'changedTouches', { value: point });
  fireEvent(el, ev);
}
