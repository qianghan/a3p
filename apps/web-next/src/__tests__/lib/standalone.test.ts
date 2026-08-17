import { describe, it, expect, afterEach, vi } from 'vitest';
import { isStandaloneDisplay, mobileEntryFor } from '@/lib/standalone';

/**
 * The installed app was opening the desktop dashboard.
 *
 * manifest.json sets `start_url: "/app"` and /app renders the mobile shell
 * correctly, so launching a freshly installed icon was fine. Every OTHER way
 * into the app landed on /agentbook — the full desktop UI — because three
 * separate entry points hardcode it:
 *
 *   /              → 307 /agentbook   (authenticated visitor)
 *   /login         → 307 /agentbook   (already authenticated)
 *   /signed-in     → link to /agentbook
 *
 * The last one is the sharpest: /signed-in exists ONLY for sign-in that began
 * inside the installed PWA, and its single button sent those users to the
 * desktop shell. The install guide also tells people to add to the home screen
 * from the site root, so a shortcut that captured "/" lands there on every
 * launch regardless of start_url.
 *
 * The fix is a display-mode gate, because "running as an installed app" is
 * exactly what `display-mode: standalone` means — not a viewport width, which
 * would hijack a desktop browser someone happened to narrow.
 */

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  delete (window.navigator as unknown as { standalone?: boolean }).standalone;
});

function setDisplayMode(standalone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: standalone && q === '(display-mode: standalone)',
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('detecting the installed app', () => {
  it('true when display-mode is standalone (Android/Chrome)', () => {
    setDisplayMode(true);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('true on iOS, which only sets navigator.standalone', () => {
    // Safari reports the legacy flag and not the media query for a home-screen
    // launch, so checking only display-mode misses every iPhone.
    setDisplayMode(false);
    (window.navigator as unknown as { standalone?: boolean }).standalone = true;
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('false in an ordinary browser tab', () => {
    setDisplayMode(false);
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('false when neither signal exists, rather than throwing', () => {
    // Older browsers have no matchMedia at all. A predicate that throws here
    // would take down the dashboard layout that calls it.
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(() => isStandaloneDisplay()).not.toThrow();
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('false during server rendering, where there is no window at all', () => {
    // The `typeof window === 'undefined'` guard. Without it this throws a
    // ReferenceError while Next prerenders the layout that calls it — and
    // jsdom always defines window, so the guard is unfalsifiable unless the
    // global is removed deliberately.
    const saved = globalThis.window;
    // @ts-expect-error deleting a global to simulate the server
    delete globalThis.window;
    try {
      expect(() => isStandaloneDisplay()).not.toThrow();
      expect(isStandaloneDisplay()).toBe(false);
    } finally {
      globalThis.window = saved;
    }
  });
});

describe('which paths an installed app is moved off', () => {
  it('redirects the desktop entry point to the mobile shell', () => {
    expect(mobileEntryFor('/agentbook')).toBe('/app');
    expect(mobileEntryFor('/agentbook/')).toBe('/app');
  });

  it('leaves deep links alone', () => {
    // A push notification pointing at an invoice must open that invoice.
    // Bouncing it to the mobile home loses what the user asked for — a worse
    // bug than the one being fixed.
    for (const p of ['/agentbook/invoices', '/agentbook/tax', '/agentbook/expenses/abc']) {
      expect(mobileEntryFor(p), `deep link hijacked: ${p}`).toBeNull();
    }
  });

  it('never redirects a path already inside the mobile shell', () => {
    // The loop this prevents: /app → /app → /app.
    for (const p of ['/app', '/app/chat', '/app/capture', '/app/docs']) {
      expect(mobileEntryFor(p), `would loop on ${p}`).toBeNull();
    }
  });

  it('leaves marketing, docs and guides alone', () => {
    for (const p of ['/', '/docs', '/docs/zh/setup/quickstart', '/guides', '/login']) {
      expect(mobileEntryFor(p)).toBeNull();
    }
  });
});

describe('the three entry points are wired to it', () => {
  /**
   * Structural, because the alternative is a helper nobody calls — the failure
   * mode of #444 (a reconciled skill array never handed to the classifier) and
   * of #451 (a message helper server.ts didn't invoke). Both passed their unit
   * tests while fixing nothing.
   */
  const read = async (rel: string) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return readFileSync(join(__dirname, '../../', rel), 'utf8');
  };

  it('the dashboard layout mounts the gate', async () => {
    const src = await read('app/(dashboard)/layout.tsx');
    expect(src).toContain('<StandaloneEntryGate />');
  });

  it('/signed-in no longer hardcodes the desktop dashboard', async () => {
    const src = await read('app/(auth)/signed-in/page.tsx');
    expect(src).toContain('isStandaloneDisplay');
    expect(
      src,
      'the one page only a PWA user sees must not send them to the desktop shell',
    ).not.toMatch(/href="\/agentbook"/);
  });

  it('auth-context uses the shared predicate, not a private copy', async () => {
    const src = await read('contexts/auth-context.tsx');
    expect(src).toContain('isStandaloneDisplay()');
    expect(
      src,
      'a device predicate that disagrees between call sites half-treats the PWA',
    ).not.toMatch(/display-mode: standalone/);
  });
});
