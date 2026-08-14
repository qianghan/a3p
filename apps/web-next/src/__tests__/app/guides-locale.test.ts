import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GUIDE_ROUTES,
  guidesLocaleOf,
  guidesHref,
  guidesCounterpart,
  GUIDES_UI,
} from '@/app/guides/_i18n';

/**
 * Chinese marketing guides.
 *
 * Unlike the docs — which are MDX and mirror a content tree — these are React
 * pages, so each guide has a translated twin under guides/zh/ that shares the
 * layout, guides.css, Flow and EarningsCalculator. The prose is duplicated
 * because prose in two languages IS two pieces of prose. The structure is not,
 * and neither is the arithmetic in the earnings calculator.
 *
 * The risk that duplication creates is a half-translated section: an English
 * guide ships, nobody adds the Chinese twin, and the language switcher drops a
 * reader onto a 404. GUIDE_ROUTES is the single list of what exists and the
 * first test below walks it against the filesystem, so that fails CI instead.
 */

const GUIDES_DIR = join(__dirname, '../../app/guides');
const pageFor = (route: string, locale: 'en' | 'zh') =>
  join(GUIDES_DIR, locale === 'zh' ? 'zh' : '', route, 'page.tsx');

describe('every guide exists in both languages', () => {
  it.each([...GUIDE_ROUTES])('%s has an English page', (route) => {
    expect(existsSync(pageFor(route, 'en')), `missing: ${pageFor(route, 'en')}`).toBe(true);
  });

  it.each([...GUIDE_ROUTES])('%s has a Chinese page', (route) => {
    expect(existsSync(pageFor(route, 'zh')), `not translated: ${route || '(index)'}`).toBe(true);
  });

  it('the route list is not silently empty', () => {
    // A vacuous it.each over [] would report all green.
    expect(GUIDE_ROUTES.length).toBeGreaterThan(5);
  });
});

describe('the switcher lands on the same guide, not the index', () => {
  it.each([...GUIDE_ROUTES])('%s round-trips', (route) => {
    const en = guidesHref(route, 'en');
    const zh = guidesHref(route, 'zh');
    expect(guidesCounterpart(en)).toEqual({ href: zh, to: 'zh' });
    expect(guidesCounterpart(zh)).toEqual({ href: en, to: 'en' });
  });

  it('a deep guide does not collapse to the section root', () => {
    // The bug this catches: a sloppy prefix strip turning
    // /guides/sales-rep/earnings into /guides/zh/sales-rep.
    expect(guidesCounterpart('/guides/sales-rep/earnings').href).toBe('/guides/zh/sales-rep/earnings');
  });

  it('tolerates a trailing slash', () => {
    expect(guidesCounterpart('/guides/students/').href).toBe('/guides/zh/students');
  });
});

describe('locale detection', () => {
  it.each([
    ['/guides', 'en'],
    ['/guides/students', 'en'],
    ['/guides/zh', 'zh'],
    ['/guides/zh/students', 'zh'],
    // Not a locale segment — a guide that merely starts with "zh" would be en.
    ['/guides/zhuangbi', 'en'],
  ])('%s → %s', (path, want) => expect(guidesLocaleOf(path)).toBe(want));
});

describe('chrome is translated', () => {
  it('the Chinese chrome is actually Chinese', () => {
    const zh = Object.values(GUIDES_UI.zh).join(' ');
    expect(zh).toMatch(/[一-鿿]/);
    expect(zh).not.toMatch(/All guides|Get started/);
  });

  it('each switcher label is written in the language it switches TO', () => {
    // A reader who cannot read the current page still has to read the way out.
    expect(GUIDES_UI.en.switchTo).toMatch(/[一-鿿]/);
    expect(GUIDES_UI.zh.switchTo).toBe('English');
  });

  it('the English chrome stays English', () => {
    expect(Object.values(GUIDES_UI.en).join(' ')).not.toMatch(/全部指南|立即开始/);
  });
});
