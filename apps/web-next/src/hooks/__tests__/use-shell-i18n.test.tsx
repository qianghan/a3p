/**
 * useShellI18n — the module that decides, for every page in the app, which
 * locale is in force, whether translated strings are allowed, and how money
 * and dates are formatted.
 *
 * It had no tests. That is the wrong module to leave uncovered: three separate
 * behaviours here are load-bearing and each has already gone wrong once.
 *
 *   1. THE SPLIT. Translated STRINGS are gated behind the feature flag;
 *      FORMATTING is not. Formatting follows the tenant locale unconditionally
 *      because those were correctness fixes (a bill due date rendered a day
 *      early for every viewer west of UTC), not new features waiting on a
 *      rollout. A test that only checked "flag off ⇒ everything English" would
 *      enshrine the opposite.
 *
 *   2. FAIL-CLOSED. The flag starts false, so the first render is English even
 *      for a tenant stored as fr-CA, and a failed config fetch leaves it
 *      false rather than defaulting open.
 *
 *   3. MONEY USES THE USER'S LOCALE, NOT ONE INFERRED FROM THE CURRENCY.
 *      The bare formatMoney() helper guesses a display locale from the
 *      currency code, which is right for call sites that have a currency and
 *      no locale — and wrong here, because the shell HAS the locale. Binding
 *      to it gave a French-Canadian tenant on CAD "$1,234.56" instead of
 *      "1 234,56 $". Asserted on the actual output below, not on which
 *      function is called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useShellI18n } from '../use-shell-i18n';
import * as catalogClient from '@agentbook/i18n/catalog-client';

/** Mirrors the real route: `{ success, data, i18nLocalesEnabled }`. */
function installConfig(opts: {
  locale?: string | null;
  currency?: string;
  i18nLocalesEnabled?: boolean;
  fail?: boolean;
}) {
  globalThis.fetch = vi.fn().mockImplementation(() => {
    if (opts.fail) return Promise.reject(new Error('network down'));
    return Promise.resolve({
      ok: true,
      json: async () => ({
        success: true,
        data: { locale: opts.locale ?? null, currency: opts.currency ?? 'USD' },
        i18nLocalesEnabled: opts.i18nLocalesEnabled ?? false,
      }),
    } as any);
  }) as any;
}

async function load(opts: Parameters<typeof installConfig>[0]) {
  installConfig(opts);
  const { result } = renderHook(() => useShellI18n());
  // Longer than waitFor's 1s default on purpose. `ready` now waits for a
  // non-English locale's pack, which is a real dynamic import — and the FIRST
  // one in a run also pays vite's cold module transform. That combination
  // overran the default once here, giving a failure that looked like the hook
  // resolving English when it was only slow. A generous ceiling costs a fast
  // run nothing, because waitFor returns as soon as the condition holds.
  await waitFor(() => expect(result.current.ready).toBe(true), { timeout: 5000 });
  return result;
}

beforeEach(() => {
  // navigator.language would otherwise leak the host's locale into
  // resolveLocale and make these assertions machine-dependent.
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the split: strings follow the flag, formatting follows the tenant', () => {
  it('with the flag OFF, a fr-CA tenant reads English strings', async () => {
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: false });
    expect(r.current.locale).toBe('fr-CA'); // resolution is not gated
    expect(r.current.t('common.cancel')).toBe('Cancel');
  });

  it('with the flag ON, the same tenant reads French strings', async () => {
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    expect(r.current.t('common.cancel')).toBe('Annuler');
  });

  it('formatting is NOT gated — a fr-CA tenant gets French dates with the flag OFF', async () => {
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: false });
    // The load-bearing half. If formatting were gated behind the flag, the
    // date-only UTC fix would silently stop applying whenever it was off.
    const en = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(
      new Date('2026-03-22T00:00:00.000Z'),
    );
    expect(r.current.formatDateOnly('2026-03-22')).not.toBe(en);
  });
});

describe('fail-closed', () => {
  it('a failed config fetch leaves translation OFF and does not block the UI', async () => {
    const r = await load({ fail: true });
    expect(r.current.ready).toBe(true);
    expect(r.current.t('common.cancel')).toBe('Cancel');
  });

  it('an absent i18nLocalesEnabled field is treated as OFF, not as missing-means-on', async () => {
    installConfig({ locale: 'fr-CA' });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { locale: 'fr-CA', currency: 'CAD' } }),
    } as any) as any;
    const { result } = renderHook(() => useShellI18n());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.t('common.cancel')).toBe('Cancel');
  });
});

describe('money formatting uses the resolved locale, not one inferred from the currency', () => {
  it('a fr-CA tenant on CAD sees French money formatting', async () => {
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    const out = r.current.formatMoney(123456);

    // The regression this guards: currency-inference maps CAD -> en-CA and
    // produces "$1,234.56". French-Canadian formatting puts the symbol last
    // and uses a comma decimal separator.
    expect(out).not.toBe('$1,234.56');
    expect(out).toMatch(/1\s*234,56/);
  });

  it('formatMoney and formatCurrency agree — they are the same operation', async () => {
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    expect(r.current.formatMoney(123456)).toBe(r.current.formatCurrency(123456));
  });

  it('an explicit currency argument still overrides the tenant default', async () => {
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    expect(r.current.formatMoney(123456, 'USD')).not.toBe(r.current.formatMoney(123456, 'CAD'));
  });

  it('is not gated by the flag either — money is formatting, not a string', async () => {
    const on = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    const onOut = on.current.formatMoney(123456);
    const off = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: false });
    expect(off.current.formatMoney(123456)).toBe(onOut);
  });
});

describe('locale resolution', () => {
  it('falls back to the browser locale when the tenant has none stored', async () => {
    const r = await load({ locale: null, i18nLocalesEnabled: true });
    expect(r.current.locale).toBe('en');
  });

  it('sets <html lang> so screen readers and CJK font selection follow', async () => {
    await load({ locale: 'zh-CN', currency: 'CNY', i18nLocalesEnabled: true });
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
  });
});

/**
 * Non-English locales are no longer in the bundle; they arrive as a chunk.
 * That saved 43 kB on every page route and introduced exactly one new way to
 * fail — the chunk not arriving — so each branch is pinned here.
 *
 * The point of these is the DEGRADATION. A missing pack must read as English,
 * because the alternative is what useT()'s humanising fallback produces:
 * `common.cancel` rendered as "Cancel" is fine, but `core_ui.gst_help_unknown`
 * renders as "Gst help unknown", and a page of that looks like a product bug
 * rather than a network one.
 */
describe('lazily-loaded locale packs', () => {
  it('an English tenant loads no pack at all', async () => {
    const spy = vi.spyOn(catalogClient, 'loadLocalePack');
    const r = await load({ locale: 'en', i18nLocalesEnabled: true });
    expect(r.current.t('common.cancel')).toBe('Cancel');
    // The common case must cost nothing: no request, no chunk.
    expect(spy).not.toHaveBeenCalled();
  });

  it('loads no pack when the flag is off, whatever the tenant locale', async () => {
    const spy = vi.spyOn(catalogClient, 'loadLocalePack');
    const r = await load({ locale: 'fr-CA', i18nLocalesEnabled: false });
    expect(r.current.locale).toBe('fr-CA'); // resolution is still not gated
    expect(spy).not.toHaveBeenCalled();
  });

  it('a pack that fails to load leaves the page in English, not in raw keys', async () => {
    vi.spyOn(catalogClient, 'loadLocalePack').mockRejectedValue(new Error('chunk load failed'));
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    expect(r.current.t('common.cancel')).toBe('Cancel');
    // Formatting is unaffected — it never depended on the pack.
    expect(r.current.formatMoney(123456)).toContain('1');
  });

  it('a failed pack still reports ready, rather than loading forever', async () => {
    vi.spyOn(catalogClient, 'loadLocalePack').mockRejectedValue(new Error('offline'));
    const r = await load({ locale: 'fr-CA', i18nLocalesEnabled: true });
    expect(r.current.ready).toBe(true);
  });

  it('a locale this build cannot serve degrades to English', async () => {
    // An AbTenantConfig row can hold a tag that no longer ships. resolveLocale
    // should normally catch that, so this is the belt to that braces: a null
    // pack must not leave `ready` false forever either.
    vi.spyOn(catalogClient, 'loadLocalePack').mockResolvedValue(null);
    const r = await load({ locale: 'fr-CA', i18nLocalesEnabled: true });
    expect(r.current.ready).toBe(true);
    expect(r.current.t('common.cancel')).toBe('Cancel');
  });

  it('a pack that loads is not also recorded as failed', async () => {
    // The `finally` used to read `packs[wanted]` out of a closure captured
    // BEFORE the pack was merged, so every success was booked as a failure.
    // `ready` was true either way, which is what would have hidden it — so
    // this asserts the observable consequence instead: French actually renders,
    // and it keeps rendering across the re-render the merge causes.
    const r = await load({ locale: 'fr-CA', currency: 'CAD', i18nLocalesEnabled: true });
    expect(r.current.t('common.cancel')).toBe('Annuler');
    await waitFor(() => expect(r.current.ready).toBe(true));
    expect(r.current.t('common.cancel')).toBe('Annuler');
  });

  it('does not report ready until the pack has actually arrived', async () => {
    // The race the derived-readiness change fixed: `configRead` and the flag
    // are set in one batch, so a `ready` computed from a state flag went true
    // for one render with English still in force.
    let release: (v: unknown) => void = () => {};
    vi.spyOn(catalogClient, 'loadLocalePack').mockReturnValue(
      new Promise((res) => {
        release = res;
      }) as never,
    );
    installConfig({ locale: 'fr-CA', i18nLocalesEnabled: true });
    const { result } = renderHook(() => useShellI18n());
    // Give the config fetch every chance to resolve while the pack is pending.
    await waitFor(() => expect(result.current.locale).toBe('fr-CA'));
    expect(result.current.ready, 'ready must wait for the pack, not just the config').toBe(false);
    release(null);
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});
