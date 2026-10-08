/**
 * The server emits i18n KEYS (UpcomingItem.titleKey, MobileAlert.action.labelKey)
 * and the client renders t(key). A key the server sends but the catalog lacks
 * renders as a humanised fallback in every locale — so every literal key in the
 * PR 1 modules must resolve in all three.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

const LIB = join(__dirname, '..', '..', '..', 'lib', 'mobile');
const FILES = ['alerts.ts', 'home.ts', 'upcoming.ts'].map((f) => join(LIB, f)).filter(existsSync);
const KEYS = [
  ...new Set(
    FILES.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\b(?:titleKey|labelKey)\s*:\s*'([a-z0-9_.]+)'/g)].map((m) => m[1])),
  ),
].sort();

describe('server-emitted i18n keys', () => {
  it('found the keys (a broken scan must not pass vacuously)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(2);
    expect(KEYS.length, `no titleKey/labelKey literals in ${FILES.join(', ')} — if PR 1 builds keys dynamically, list them here explicitly`).toBeGreaterThan(0);
    // The three keys PR 1 emits today; if one is renamed this fails loudly instead of silently shrinking the scan.
    expect(KEYS).toEqual(expect.arrayContaining(['mobile.alerts.action_remind', 'mobile.upcoming.bill_due', 'mobile.upcoming.tax_instalment']));
  });

  it.each(['en', 'fr-CA', 'zh-CN'])('%s resolves every one', (locale) => {
    const { t } = createTranslator(locale, CATALOG);
    const missing = KEYS.filter((k) => t(k, { vendor: 'V', title: 'T', count: 2, quarter: 2, year: 2026 }) === k);
    expect(missing).toEqual([]);
  });

  it('interpolates the params the server sends (no raw {placeholder} left behind)', () => {
    for (const locale of ['en', 'fr-CA', 'zh-CN']) {
      const { t } = createTranslator(locale, CATALOG);
      expect(t('mobile.upcoming.tax_instalment', { quarter: 2, year: 2026 }), locale).toMatch(/2026/);
      expect(t('mobile.upcoming.tax_instalment', { quarter: 2, year: 2026 }), locale).not.toMatch(/[{}]/);
      expect(t('mobile.upcoming.bill_due', { vendor: 'Rogers' }), locale).toContain('Rogers');
    }
  });

  it('the Remind label the invoice_overdue alert carries exists', () => {
    expect(createTranslator('en', CATALOG).t('mobile.alerts.action_remind')).toBe('Remind');
  });

  it('calendar titleKeys the jurisdiction packs seed resolve (they come from the calendar namespace)', () => {
    for (const locale of ['en', 'fr-CA', 'zh-CN']) {
      const { t } = createTranslator(locale, CATALOG);
      expect(t('calendar.q1_estimated_tax_due'), locale).not.toBe('calendar.q1_estimated_tax_due');
    }
  });
});
