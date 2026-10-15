import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

/**
 * Every key the mobile chat uses must resolve in all three locales, and the
 * non-English values must actually be translated. `t()` never throws on a
 * missing key and useT() humanises it into plausible English, so a typo or a
 * missing entry is invisible on the page; this file is what makes it loud.
 *
 * The shell-wiring guard (architecture/i18n-shell-wiring.test.ts) only scrapes
 * TWO-segment keys (`ns.key`), so three-segment `mobile.chat.x` keys would
 * pass it vacuously. Hence a dedicated check.
 */
export const CHAT_KEYS = [
  'mobile.chat.title',
  'mobile.chat.subtitle',
  'mobile.chat.history_loading',
  'mobile.chat.history_error',
  'mobile.chat.retry',
  'mobile.chat.empty_title',
  'mobile.chat.starter_briefing',
  'mobile.chat.starter_spend',
  'mobile.chat.starter_log',
  'mobile.chat.placeholder',
  'mobile.chat.send',
  'mobile.chat.attach',
  'mobile.chat.attach_camera',
  'mobile.chat.attach_library',
  'mobile.chat.attach_close',
  'mobile.chat.typing',
  'mobile.chat.not_sent',
  'mobile.chat.not_sent_offline',
  'mobile.chat.rate_limited',
  'mobile.chat.rate_limited_wait',
  'mobile.chat.plan_title',
  'mobile.chat.proceed',
  'mobile.chat.cancel',
  'mobile.chat.plan_working',
  'mobile.chat.plan_resolved',
  'mobile.chat.pending_title',
  'mobile.chat.undo',
  'mobile.chat.action_failed',
  'mobile.chat.receipt_uploading',
  'mobile.chat.receipt_saved',
  'mobile.chat.receipt_needs_review',
  'mobile.chat.receipt_duplicate',
  'mobile.chat.receipt_failed',
  'mobile.chat.receipt_open',
  'mobile.chat.new_messages',
  'mobile.chat.offline_banner',
  'mobile.chat.unreadable_amount',
] as const;

const SRC = join(__dirname, '..', '..', '..');
const CHAT_DIRS = [join(SRC, 'app', 'app', 'chat')];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?)$/.test(e)) out.push(p);
  }
  return out;
}

export function scrapeChatKeys(): string[] {
  const keys = new Set<string>();
  for (const f of CHAT_DIRS.flatMap(walk)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('(mobile\.chat\.[a-z0-9_]+)'/g)) keys.add(m[1]);
  }
  return [...keys].sort();
}

describe('mobile chat i18n keys', () => {
  it.each(['en', 'fr-CA', 'zh-CN'])('%s resolves every chat key', (locale) => {
    const tr = createTranslator(locale, CATALOG);
    const missing = CHAT_KEYS.filter((k) => tr.t(k) === k || tr.t(k).trim() === '');
    expect(missing, `${locale}: unresolved ${missing.join(', ')}`).toEqual([]);
  });

  it.each(['fr-CA', 'zh-CN'])('%s actually translates every chat key', (locale) => {
    const en = createTranslator('en', CATALOG);
    const tr = createTranslator(locale, CATALOG);
    const same = CHAT_KEYS.filter((k) => tr.t(k) === en.t(k));
    expect(same, `${locale}: identical to English ${same.join(', ')}`).toEqual([]);
  });

  it('keeps the {seconds} placeholder in every locale', () => {
    for (const locale of ['en', 'fr-CA', 'zh-CN']) {
      const tr = createTranslator(locale, CATALOG);
      expect(tr.t('mobile.chat.rate_limited', { seconds: 7 }), locale).toContain('7');
      expect(tr.t('mobile.chat.rate_limited_wait', { seconds: 7 }), locale).toContain('7');
    }
  });

  it('every key the chat source calls is in CHAT_KEYS', () => {
    const extra = scrapeChatKeys().filter((k) => !(CHAT_KEYS as readonly string[]).includes(k));
    expect(extra, `keys used in source but not declared: ${extra.join(', ')}`).toEqual([]);
  });

  it('the scrape is not vacuous once the page exists', () => {
    expect(scrapeChatKeys().length).toBeGreaterThanOrEqual(30);
  });
});
