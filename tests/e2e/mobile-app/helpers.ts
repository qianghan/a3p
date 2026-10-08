import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatCurrencyCents } from '../../../apps/web-next/src/lib/jurisdiction-currency';

export const MOBILE_VIEWPORT = { width: 390, height: 844 };

export type Persona = 'maya' | 'alex' | 'sydney' | 'fresh';

export const PERSONAS: Record<Exclude<Persona, 'fresh'>, { email: string; currency: string; jurisdiction: 'ca' | 'us' | 'au' }> = {
  maya: { email: 'maya@agentbook.test', currency: 'CAD', jurisdiction: 'ca' },
  alex: { email: 'alex@agentbook.test', currency: 'USD', jurisdiction: 'us' },
  sydney: { email: 'sydney@agentbook.test', currency: 'AUD', jurisdiction: 'au' },
};

/** The seeded personas' shared password (seed-users.ts); override for another environment. */
const PERSONA_PASSWORD = process.env.E2E_PERSONA_PASSWORD || 'agentbook123';

function randomTag(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Hosts that are a developer's own machine — they have no seeded personas. */
export function isLocalHost(baseURL: string | undefined): boolean {
  try {
    const h = new URL(baseURL || '').hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Whether a real login can succeed against `baseURL`. The seeded personas
 * exist on the deployed site; a local dev server has none unless the caller
 * says so by supplying E2E_PERSONA_PASSWORD (a local DB seeded with them).
 * Returns a reason when it cannot, for `test.skip(reason !== null, reason)`.
 */
export function loginUnavailableReason(baseURL: string | undefined): string | null {
  if (isLocalHost(baseURL) && !process.env.E2E_PERSONA_PASSWORD) {
    return `no seeded personas on ${baseURL}: set E2E_PERSONA_PASSWORD (a DB seeded by agentbook/seed-users.ts) or run against a deployment`;
  }
  return null;
}

/** Sign in as a seeded persona, or register + sign in a brand-new empty account. */
export async function loginAs(page: Page, persona: Persona): Promise<{ email: string }> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  let email: string;
  let password: string;
  if (persona === 'fresh') {
    email = `e2e-mobile-fresh-${Date.now()}-${randomTag()}@agentbook.test`;
    password = `E2e-${randomTag()}-${randomTag()}!`;
    await page.goto('/login');
    const reg = await page.evaluate(
      async ({ email: e, password: p }) => {
        const r = await fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: e, password: p, displayName: 'E2E Mobile Fresh', ageConfirmed: true }),
        });
        return { status: r.status, body: await r.text() };
      },
      { email, password },
    );
    expect(reg.status, `register fresh account: ${reg.body}`).toBeLessThan(300);
  } else {
    email = PERSONAS[persona].email;
    password = PERSONA_PASSWORD;
  }

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // Anchored on the PATH: "/login?redirect=…" is where a FAILED login sits.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

  // A URL is not proof of a session — one authenticated request is.
  const status = await page.evaluate(async () => (await fetch('/api/v1/agentbook-core/tenant-config', { credentials: 'include' })).status);
  expect(status, `${persona}: authenticated probe`).toBe(200);
  return { email };
}

/** Unregister any service worker, clear Cache Storage, then give the page 2 s to settle. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      /* no service worker API */
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* no Cache Storage */
    }
  });
  await page.waitForTimeout(2_000);
}

/**
 * Which locale the page's STRINGS are in, and which locale its NUMBERS are in.
 * They differ by design: strings follow the i18n flag, formatting follows the
 * tenant locale unconditionally (use-shell-i18n.ts).
 */
export async function pageLocales(page: Page): Promise<{ stringLocale: string; formatLocale: string }> {
  return page.evaluate(async () => {
    const r = await fetch('/api/v1/agentbook-core/tenant-config', { credentials: 'include' });
    const j = (await r.json().catch(() => null)) as { i18nLocalesEnabled?: boolean } | null;
    const formatLocale = document.documentElement.lang || 'en';
    return { stringLocale: j?.i18nLocalesEnabled === true ? formatLocale : 'en', formatLocale };
  });
}

const LOCALES_DIR = join(__dirname, '..', '..', '..', 'packages', 'agentbook-i18n', 'src', 'locales');

type Tree = Record<string, unknown>;

function loadLocale(locale: string): Tree | null {
  const dir = join(LOCALES_DIR, locale);
  if (!existsSync(dir)) return null;
  const out: Tree = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}

function readKey(tree: Tree, key: string): string | undefined {
  let cur: unknown = tree;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Tree)) cur = (cur as Tree)[part];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

export type CatalogT = (key: string, params?: Record<string, string | number>) => string;

/** The app's own catalog, read from source — the same lookup chain and plural rule as @agentbook/i18n. */
export function catalogT(locale: string): CatalogT {
  const chain = [...new Set([locale, locale.split('-')[0], 'en'])]
    .map((l) => ({ l, tree: loadLocale(l) }))
    .filter((x): x is { l: string; tree: Tree } => x.tree !== null);
  return (key, params) => {
    for (const { l, tree } of chain) {
      let tpl: string | undefined;
      if (params?.count !== undefined) {
        const cat = new Intl.PluralRules(l).select(Number(params.count));
        tpl = readKey(tree, `${key}_${cat}`) ?? readKey(tree, `${key}_other`);
      }
      tpl = tpl ?? readKey(tree, key);
      if (tpl !== undefined) {
        return params ? tpl.replace(/\{(\w+)\}/g, (lit, n: string) => (params[n] === undefined ? lit : String(params[n]))) : tpl;
      }
    }
    return key;
  };
}

/** Exactly the app's money formatting (same function, imported from source). */
export function money(cents: number, currency: string, locale: string): string {
  return formatCurrencyCents(Math.round(cents), currency, locale);
}

export type ScreenRoute = '/app' | '/app/docs' | '/app/capture' | '/app/chat';

/**
 * Assert a screen RENDERED (content), not merely that the URL changed.
 * One marker per screen; the PR that rebuilds a screen updates its marker here.
 */
export async function expectScreen(page: Page, route: string, t: CatalogT): Promise<void> {
  const main = page.locator('main');
  if (route === '/app') {
    await expect(main.getByRole('heading', { level: 1, name: 'AgentBook' })).toBeVisible();
  } else if (route === '/app/docs' || route.startsWith('/app/docs?')) {
    await expect(main.getByRole('heading', { name: t('common.documents') })).toBeVisible();
  } else if (route.startsWith('/app/capture')) {
    await expect(main.getByRole('heading', { name: 'Capture expense' })).toBeVisible();
  } else if (route.startsWith('/app/chat')) {
    await expect(main.getByRole('heading', { name: 'Ask AgentBook' })).toBeVisible();
  } else {
    throw new Error(`expectScreen: no marker for ${route} yet`);
  }
}

export function tabNav(page: Page, t: CatalogT): Locator {
  return page.getByRole('navigation', { name: t('mobile.tabs.nav_label') });
}

/** An iPhone 14/15 installed-PWA's safe-area insets (status bar / home indicator). */
export const IPHONE_INSETS = { top: 59, bottom: 34, left: 0, right: 0 };

/**
 * Make `env(safe-area-inset-*)` evaluate to the iPhone's real insets
 * (Chromium CDP). Returns false when the browser cannot emulate them — the
 * caller should skip rather than assert against a layout with no insets.
 */
export async function applySafeAreaInsets(context: BrowserContext, page: Page, insets = IPHONE_INSETS): Promise<boolean> {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    return true;
  } catch {
    return false;
  }
}

export interface ShellGeometry {
  vh: number;
  navTop: number;
  navPaddingBottom: string;
  headerPaddingTop: string | null;
  mainPaddingBottom: string;
  /** Bottom of main's last content element after main is scrolled to its end. */
  lastContentBottom: number | null;
  /** Document scroll overflow in px (0 = the page itself does not scroll). */
  docOverflow: number;
}

/**
 * Screen-agnostic measurements of the shell: tab bar, header, and the bottom of
 * whatever the current screen put in <main>. Scrolls main to its end first, so a
 * long list is judged at its last row, not its first.
 */
export async function measureShell(page: Page): Promise<ShellGeometry> {
  return page.evaluate(() => {
    const main = document.getElementById('mobile-main');
    const nav = document.querySelector('[data-mobile-shell] nav');
    const header = document.querySelector('[data-mobile-shell] > header');
    if (!main || !nav) throw new Error('mobile shell not rendered (#mobile-main / nav missing)');
    main.scrollTop = main.scrollHeight;
    // The lowest edge of anything the screen lays out in main's own scroll flow.
    // Skip fixed-position nodes, and anything inside a nested scroller (a chat
    // transcript scrolls on its own, so its overflowing rows say nothing about
    // whether the screen clears the tab bar).
    const inFlow = (el: Element): boolean => {
      for (let n: Element | null = el; n && n !== main; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.position === 'fixed') return false;
        if (n !== el && /(auto|scroll)/.test(st.overflowY)) return false;
      }
      return true;
    };
    const bottoms = Array.from(main.querySelectorAll('*'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && inFlow(el);
      })
      .map((el) => el.getBoundingClientRect().bottom);
    const last = bottoms.length ? Math.max(...bottoms) : null;
    const cs = (el: Element | null, p: 'paddingTop' | 'paddingBottom') => (el ? getComputedStyle(el)[p] : null);
    return {
      vh: window.innerHeight,
      navTop: nav.getBoundingClientRect().top,
      navPaddingBottom: cs(nav, 'paddingBottom') as string,
      headerPaddingTop: cs(header, 'paddingTop'),
      mainPaddingBottom: cs(main, 'paddingBottom') as string,
      lastContentBottom: last,
      docOverflow: (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight,
    };
  });
}
