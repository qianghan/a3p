import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_SELECTOR_IDS, SEL_ELEMENTS } from '../../../../../tests/e2e/mobile-app/selectors';

/**
 * The launch gates locate everything by data-testid. A testid that drifts from
 * the source turns a gate into a timeout that reads like a product failure (or
 * worse, a `.or()` branch that passes for the wrong reason). This pins them.
 */
const APP = join(__dirname, '..', '..', 'app', 'app');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(e) ? [readFileSync(p, 'utf8')] : [];
  });
}

/**
 * Is `id` DEFINED in `src`, not merely mentioned? Substring matching passed `tabbar` while no element had it,
 * because chat/page.tsx QUERIES `[data-testid="tabbar"]`. So: drop selector queries first, then require the id as an
 * exact quoted string, or as the static prefix of a template literal (`docs-filter-${f}`).
 */
export function isDefined(id: string, src: string): boolean {
  const defs = src.replace(/\[data-testid[^\]]*\]/g, '').replace(/getByTestId\([^)]*\)/g, '');
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(["'\`])${esc}\\1`).test(defs)) return true;
  for (const m of defs.matchAll(/`([^`$]*)\$\{/g)) if (m[1] && id.startsWith(m[1])) return true;
  return false;
}

describe('isDefined (the guard must be able to fail)', () => {
  it('a selector QUERY is not a definition (the old vacuous pass)', () => {
    expect(isDefined('tabbar', `const el = document.querySelector('[data-testid="tabbar"]');`)).toBe(false);
    expect(isDefined('tabbar', `page.getByTestId('tabbar')`)).toBe(false);
  });
  it('an attribute, a map value and a template prefix are definitions', () => {
    expect(isDefined('tabbar', `<nav data-testid="tabbar">`)).toBe(true);
    expect(isDefined('tab-home', `const M = { home: 'tab-home' };`)).toBe(true);
    expect(isDefined('docs-filter-all', 'testId={`docs-filter-${f}`}')).toBe(true);
  });
  it('a longer id does not satisfy a shorter one', () => {
    expect(isDefined('doc-viewer', `<div data-testid="doc-viewer-error">`)).toBe(false);
  });
});

describe('mobile e2e selector contract', () => {
  const all = sources(APP).join('\n');
  it('scans the real app tree', () => {
    expect(all.length).toBeGreaterThan(20_000);
  });
  it('every contract id is defined in app/app source', () => {
    const missing = ALL_SELECTOR_IDS.filter((id) => !isDefined(id, all));
    expect(missing.map((id) => `${id} → ${SEL_ELEMENTS[id] ?? '(chat; see PR 6)'}`)).toEqual([]);
  });
  it('filter chips expose pressed state', () => {
    expect(all).toMatch(/aria-pressed/);
  });
});
