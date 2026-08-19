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
  await waitFor(() => expect(result.current.ready).toBe(true));
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
