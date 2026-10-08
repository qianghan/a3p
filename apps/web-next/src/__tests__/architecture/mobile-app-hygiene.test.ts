/**
 * /app hygiene — the redesign's style rules, enforced rather than requested.
 *
 *   1. No hardcoded user-visible English in app/app/**. Every string goes
 *      through useT with en / fr-CA / zh-CN keys. (Green catalog guards have
 *      coexisted with a visibly English page before — the catalog being
 *      consistent says nothing about whether the component asks for a key.)
 *   2. No raw hex colours. Colours are kit tokens over the shell's HSL
 *      variables, so light and dark both work.
 *   3. Every literal t('…') key in app/app/** resolves in all three locales —
 *      i18n-shell-wiring.test.ts only scrapes two-segment keys, and every
 *      /app key is three segments (mobile.<screen>.<name>).
 *
 * LEGACY lists the pre-redesign pages. Each later PR converts one and must
 * delete its entry — the "still legacy" test fails if a listed file is clean,
 * so the list can only shrink.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

const SRC = join(__dirname, '..', '..');
const MOBILE = join(SRC, 'app', 'app');

const LEGACY: Record<string, string> = {
  'page.tsx': 'Home — converted in PR 3',
  'docs/page.tsx': 'Docs — converted in PR 4',
  'capture/page.tsx': 'Capture — converted in PR 5',
  'chat/page.tsx': 'Chat — converted in PR 6',
};

/** Product names are the same in every locale and are never catalog keys. */
const BRAND = new Set(['AgentBook']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(MOBILE, p).split(sep).join('/');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function findHex(src: string): string[] {
  return [...stripComments(src).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
}

export function findEnglish(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  // JSX text directly before a closing tag: <span>Home</span>
  for (const m of code.matchAll(/(?<![=\-])>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)<\//g)) {
    const text = m[1].trim();
    if (text && !BRAND.has(text)) out.push(text);
  }
  // User-visible string attributes: placeholder="Amount"
  for (const m of code.matchAll(/\b(placeholder|title|aria-label|alt|label)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) {
    if (!BRAND.has(m[2])) out.push(`${m[1]}="${m[2]}"`);
  }
  // Object-literal copy — the shape the old TABS array used: { label: 'Home' }
  for (const m of code.matchAll(/\b(label|title|placeholder|message|body|text)\s*:\s*'([A-Z][^']*[a-z][^']*)'/g)) {
    if (!BRAND.has(m[2])) out.push(`${m[1]}: '${m[2]}'`);
  }
  return out;
}

function keysIn(src: string): string[] {
  return [...stripComments(src).matchAll(/\bt\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/g)].map((m) => m[1]);
}

const files = walk(MOBILE);
const read = (p: string) => readFileSync(p, 'utf8');

describe('/app hygiene', () => {
  it('scanned a real tree', () => {
    // A floor, so a broken walk can't make every assertion below vacuous.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.map(rel)).toEqual(expect.arrayContaining(['layout.tsx', '_kit/tokens.ts', '_lib/api.ts', '_shell/TabBar.tsx']));
  });

  it('no raw hex colour outside the legacy pages', () => {
    const offenders = files.filter((f) => !(rel(f) in LEGACY)).flatMap((f) => findHex(read(f)).map((h) => `${rel(f)}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it('no hardcoded English outside the legacy pages', () => {
    const offenders = files.filter((f) => !(rel(f) in LEGACY)).flatMap((f) => findEnglish(read(f)).map((s) => `${rel(f)}: ${s}`));
    expect(offenders).toEqual([]);
  });

  it('every LEGACY entry is still legacy — delete the entry in the PR that converts the file', () => {
    for (const [file, why] of Object.entries(LEGACY)) {
      const p = join(MOBILE, file);
      expect(existsSync(p), `${file} (${why}) no longer exists — remove it from LEGACY`).toBe(true);
      const src = read(p);
      expect(findHex(src).length + findEnglish(src).length, `${file} is clean now — remove it from LEGACY`).toBeGreaterThan(0);
    }
  });

  it.each(['en', 'fr-CA', 'zh-CN'])('%s resolves every key /app asks for', (locale) => {
    const { t } = createTranslator(locale, CATALOG);
    const keys = [...new Set(files.flatMap((f) => keysIn(read(f))))].sort();
    expect(keys.length, 'no keys scraped — did the t() call shape change?').toBeGreaterThanOrEqual(10);
    // A plural key has no bare leaf; it resolves only through _one/_other.
    const missing = keys.filter((k) => t(k) === k && t(k, { count: 2 }) === k);
    expect(missing, `${locale}: unresolved -> ${missing.join(', ')}`).toEqual([]);
  });

  it('the detectors catch what they claim to (guard the guard)', () => {
    expect(findHex("<div style={{ color: '#10b981' }} />")).toEqual(['#10b981']);
    expect(findHex("<div style={{ color: 'var(--primary, #10b981)' }} />")).toEqual(['#10b981']);
    expect(findHex('<div style={{ color: tokens.color.primary }} />')).toEqual([]);
    expect(findEnglish('<span>Home</span>')).toEqual(['Home']);
    expect(findEnglish("<span>{t('mobile.tabs.home')}</span>")).toEqual([]);
    expect(findEnglish('<input placeholder="Type a message…" />')).toEqual(['placeholder="Type a message…"']);
    expect(findEnglish("const TABS = [{ href: '/app', label: 'Home' }];")).toEqual(["label: 'Home'"]);
    expect(findEnglish('<h1>AgentBook</h1>')).toEqual([]);
    expect(findEnglish('const f = (a: number) => a > 1;')).toEqual([]);
    expect(findEnglish('<span>{n} · {m}</span>')).toEqual([]);
  });

  it('the shell kept its service-worker, push and language wiring', () => {
    const shell = read(join(MOBILE, '_shell', 'MobileShell.tsx'));
    for (const needle of [
      "navigator.serviceWorker.register('/sw.js')",
      "addEventListener('controllerchange'",
      'initOfflineQueueReplay()',
      "'/api/v1/push/subscribe'",
      'pushManager.subscribe',
      '<LanguageSwitcher />',
    ]) {
      expect(shell, needle).toContain(needle);
    }
  });

  it('sign-out clears the offline snapshots (they hold the previous user’s figures)', () => {
    const auth = read(join(SRC, 'contexts', 'auth-context.tsx'));
    const start = auth.indexOf('function clearAllAuthStorage');
    expect(start).toBeGreaterThan(-1);
    expect(auth.slice(start, auth.indexOf('\n}', start))).toContain('clearMobileSnapshots()');
  });
});
