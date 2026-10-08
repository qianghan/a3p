/**
 * /app hygiene — the redesign's style rules, enforced rather than requested.
 *
 *   1. No hardcoded user-visible English in app/app/**. Every string goes
 *      through useT with en / fr-CA / zh-CN keys. (Green catalog guards have
 *      coexisted with a visibly English page before — the catalog being
 *      consistent says nothing about whether the component asks for a key.)
 *   2. No raw colours. Colours are kit tokens over the shell's HSL variables,
 *      so light and dark both work.
 *   3. Every `mobile.*` key literal anywhere in app/app/** exists in each
 *      locale's OWN catalog, and every t(...) call names its key as a literal.
 *
 * The detectors are AST-based (helpers/mobile-hygiene.ts, which documents the
 * rules); this file runs them over the real tree and proves each one fires on
 * inline fixtures, so a detector that stops seeing a shape fails here.
 *
 * LEGACY lists the pre-redesign pages. Each later PR converts one and must
 * delete its entry — the "still legacy" test fails if a listed file is clean,
 * so the list can only shrink. SUPPRESSIONS are capped so `i18n-ignore` can
 * not become an escape hatch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { analyzeSource, findColours, flattenKeys, unresolvedKeys, type Finding } from './helpers/mobile-hygiene';

const SRC = join(__dirname, '..', '..');
const MOBILE = join(SRC, 'app', 'app');
const LOCALES = ['en', 'fr-CA', 'zh-CN'];
/** Reasoned `// i18n-ignore:` / `// i18n-dynamic:` markers allowed across the tree. */
const MAX_SUPPRESSIONS = 3;

const LEGACY: Record<string, string> = {
  'page.tsx': 'Home — converted in PR 3',
  'docs/page.tsx': 'Docs — converted in PR 4',
  'capture/page.tsx': 'Capture — converted in PR 5',
  'chat/page.tsx': 'Chat — converted in PR 6',
};

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
const read = (p: string) => readFileSync(p, 'utf8');

const files = walk(MOBILE);
const analyses = new Map(files.map((f) => [rel(f), analyzeSource(rel(f), read(f))]));
const fmt = (file: string, f: Finding) => `${file}:${f.line} ${f.kind} ${f.text}`;
const offenders = (kinds: Finding['kind'][]) =>
  [...analyses.entries()]
    .filter(([file]) => !(file in LEGACY))
    .flatMap(([file, a]) => a.findings.filter((f) => kinds.includes(f.kind)).map((f) => fmt(file, f)));

/** Shorthand for the fixtures: "kind text" for every finding. */
const run = (src: string, path = 'x.tsx') => analyzeSource(path, src).findings.map((f) => `${f.kind} ${f.text}`);

describe('/app hygiene — the real tree', () => {
  it('scanned a real tree', () => {
    // A floor, so a broken walk can't make every assertion below vacuous.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.map(rel)).toEqual(expect.arrayContaining(['layout.tsx', '_kit/tokens.ts', '_lib/api.ts', '_shell/TabBar.tsx']));
  });

  it('no hardcoded English outside the legacy pages', () => {
    expect(offenders(['english'])).toEqual([]);
  });

  it('no raw colour outside the legacy pages', () => {
    expect(offenders(['colour'])).toEqual([]);
  });

  it('every t() names its key as a literal, and every suppression has a reason', () => {
    expect(offenders(['dynamic-key', 'bad-suppression'])).toEqual([]);
  });

  it(`suppressions stay under the cap (${MAX_SUPPRESSIONS})`, () => {
    const used = [...analyses.entries()].filter(([f]) => !(f in LEGACY)).reduce((n, [, a]) => n + a.suppressions, 0);
    expect(used, 'i18n-ignore / i18n-dynamic is for intentional exceptions, not a way around the guard').toBeLessThanOrEqual(MAX_SUPPRESSIONS);
  });

  it('every LEGACY entry is still legacy — delete the entry in the PR that converts the file', () => {
    for (const [file, why] of Object.entries(LEGACY)) {
      const p = join(MOBILE, file);
      expect(existsSync(p), `${file} (${why}) no longer exists — remove it from LEGACY`).toBe(true);
      const bad = analyses.get(file)!.findings.filter((f) => f.kind === 'english' || f.kind === 'colour');
      expect(bad.length, `${file} is clean now — remove it from LEGACY`).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s catalog has every mobile.* key /app uses (own catalog, no fallback)', (locale) => {
    const keys = [...new Set([...analyses.values()].flatMap((a) => a.keys))].sort();
    expect(keys.length, 'no keys scraped — did the key shape change?').toBeGreaterThanOrEqual(10);
    const missing = unresolvedKeys(keys, CATALOG, [locale])[locale];
    expect(missing, `${locale}: missing -> ${missing.join(', ')}`).toEqual([]);
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

describe('/app hygiene — the detectors (guard the guard)', () => {
  describe('English: JSX text', () => {
    it('plain, interpolated and mixed text', () => {
      expect(run('const a = <span>Home</span>;')).toEqual(['english "Home"']);
      expect(run('const a = <p>Saved {n} receipts</p>;')).toEqual(['english "Saved"', 'english "receipts"']);
      expect(run('const a = <p>Retry <b>now</b></p>;')).toEqual(['english "Retry"', 'english "now"']);
      expect(run('const a = <label>Name<input /></label>;')).toEqual(['english "Name"']);
      expect(run('const a = <p>{n} receipts</p>;')).toEqual(['english "receipts"']);
    });
    it('does not flag translated, symbolic, entity or brand text', () => {
      expect(run("const a = <span>{t('mobile.tabs.home')}</span>;")).toEqual([]);
      expect(run('const a = <span>{n} · {m}</span>;')).toEqual([]);
      expect(run('const a = <span>&nbsp;&middot;&nbsp;→ 50%</span>;')).toEqual([]);
      expect(run('const a = <h1>AgentBook</h1>;')).toEqual([]);
      expect(run('const f = (a: number) => a > 1;')).toEqual([]);
    });
  });

  describe('English: string / template / conditional children', () => {
    it('{"x"} {\'x\'} {`x`}', () => {
      expect(run("const a = <p>{'Retry'}</p>;")).toEqual(['english "Retry"']);
      expect(run('const a = <p>{"Retry"}</p>;')).toEqual(['english "Retry"']);
      expect(run('const a = <p>{`Retry`}</p>;')).toEqual(['english "Retry"']);
      expect(run('const a = <p>{`Saved ${n} items`}</p>;')).toEqual(['english "Saved "', 'english " items"']);
    });
    it('either arm of a ternary and the value of && / || / ??', () => {
      expect(run("const a = <p>{ok ? 'Saved' : 'Failed'}</p>;")).toEqual(['english "Saved"', 'english "Failed"']);
      expect(run("const a = <p>{cond && 'Retry'}</p>;")).toEqual(['english "Retry"']);
      expect(run("const a = <p>{name || 'Unknown'}</p>;")).toEqual(['english "Unknown"']);
      expect(run("const a = <p>{ok ? t('mobile.a.b') : '—'}</p>;")).toEqual([]);
      expect(run("const a = <p>{cond && 'x' in obj}</p>;")).toEqual([]);
    });
  });

  describe('English: attributes and object keys', () => {
    it('both quote styles and the brace form', () => {
      expect(run('const a = <input placeholder="Amount" />;')).toEqual(['english placeholder="Amount"']);
      expect(run("const a = <input placeholder='Amount' />;")).toEqual(['english placeholder="Amount"']);
      expect(run("const a = <input placeholder={'Amount'} />;")).toEqual(['english placeholder="Amount"']);
      expect(run('const a = <button aria-label={`Close`} />;')).toEqual(['english aria-label="Close"']);
      expect(run("const a = <button aria-label={ok ? 'Open' : 'Close'} />;")).toEqual(['english aria-label="Open"', 'english aria-label="Close"']);
    });
    it.each([
      'title', 'body', 'text', 'label', 'description', 'subtitle', 'hint', 'helper', 'caption', 'heading', 'placeholder', 'alt',
      'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
      'actionLabel', 'emptyText', 'sheetTitle',
    ])('copy prop %s', (prop) => {
      expect(run(`const a = <X ${prop}="Hello there" />;`)).toEqual([`english ${prop}="Hello there"`]);
    });
    it('does not flag non-copy props', () => {
      const src = `const a = <div className="card big" id="x" role="dialog" type="button" aria-live="polite" aria-hidden="true"
        aria-current="page" aria-expanded="false" aria-controls="menu" aria-labelledby="h" aria-describedby="d"
        href="/app/docs" data-testid="tab" style={{ display: 'flex', textAlign: 'center' }} name="amount" htmlFor="amount" />;`;
      expect(run(src)).toEqual([]);
      expect(run('const a = <X title={t("mobile.a.b")} label={label} />;')).toEqual([]);
      expect(run('const a = <X title="·" label="%" />;')).toEqual([]);
      expect(run('const a = <X label="AgentBook" />;')).toEqual([]);
    });
    it("object-literal copy: { label: 'Home' }, string key, ternary", () => {
      expect(run("const TABS = [{ href: '/app', label: 'Home' }];")).toEqual(['english label="Home"']);
      expect(run("const T = { 'aria-label': 'Close', ariaLabel: ok ? 'A' : 'B' };")).toEqual(['english aria-label="Close"', 'english ariaLabel="A"', 'english ariaLabel="B"']);
      expect(run("const T = { labelKey: 'mobile.tabs.home', type: 'button' };")).toEqual([]);
    });
  });

  describe('English: toast, error and alert arguments', () => {
    it('flags the call shapes', () => {
      expect(run("toast.show('Saved');")).toEqual(['english "Saved"']);
      expect(run("useToast().show('Saved', { tone: 'good' });")).toEqual(['english "Saved"']);
      expect(run("toast('Saved');")).toEqual(['english "Saved"']);
      expect(run("setError('Could not load');")).toEqual(['english "Could not load"']);
      expect(run("setSaveError(ok ? null : 'Could not save');")).toEqual(['english "Could not save"']);
      expect(run("throw new Error('Request failed');")).toEqual(['english "Request failed"']);
      expect(run("alert('Hi there');")).toEqual(['english "Hi there"']);
      expect(run("toast.error('Nope');")).toEqual(['english "Nope"']);
    });
    it('does not flag translated, symbolic or developer-log calls', () => {
      expect(run("toast.show(t('mobile.a.b'));")).toEqual([]);
      expect(run('setError(null);')).toEqual([]);
      expect(run("setError(t('mobile.a.b'));")).toEqual([]);
      expect(run("console.error('boom');")).toEqual([]);
      expect(run("toast.show('✓');")).toEqual([]);
    });
  });

  describe('suppression', () => {
    it('a reasoned marker on the same or previous line exempts the node', () => {
      expect(run("const a = <b>{'English'}</b>; // i18n-ignore: language endonym")).toEqual([]);
      expect(run("// i18n-ignore: language endonym\nconst a = <b>{'English'}</b>;")).toEqual([]);
      expect(run("const a = <p>\n  {/* i18n-ignore: language endonym */}\n  Français\n</p>;")).toEqual([]);
      expect(analyzeSource('x.tsx', "// i18n-ignore: language endonym\nconst a = <b>{'English'}</b>;").suppressions).toBe(1);
    });
    it('a marker two lines away does not reach', () => {
      expect(run("// i18n-ignore: language endonym\n\nconst a = <b>{'English'}</b>;")).toEqual(['english "English"']);
    });
    it('a bare marker is a violation and exempts nothing', () => {
      expect(run("const a = <b>{'English'}</b>; // i18n-ignore")).toEqual(['bad-suppression i18n-ignore needs a reason', 'english "English"']);
      expect(run("const a = <b>{'English'}</b>; // i18n-ignore:")).toEqual(['bad-suppression i18n-ignore needs a reason', 'english "English"']);
    });
    it('the cap is a number the test compares against, and suppressions are counted', () => {
      const src = Array.from({ length: 4 }, (_, i) => `// i18n-ignore: r${i}\nconst a${i} = <b>{'English'}</b>;`).join('\n');
      const a = analyzeSource('x.tsx', src);
      expect(a.suppressions).toBe(4);
      expect(a.suppressions).toBeGreaterThan(MAX_SUPPRESSIONS);
    });
  });

  describe('colour', () => {
    it('hex as a whole string, inside CSS, and in the old var() fallback shape', () => {
      expect(run("const s = { color: '#10b981' };")).toEqual(['colour #10b981']);
      expect(run("const s = { border: '1px solid #ddd' };")).toEqual(['colour #ddd']);
      expect(run("const s = { color: 'var(--primary, #10b981)' };")).toEqual(['colour #10b981']);
      expect(run('const s = `1px solid #ddd ${x}`;')).toEqual(['colour #ddd']);
      expect(run('const s = { color: tokens.color.primary };')).toEqual([]);
    });
    it('a hex-looking anchor in a URL or path is not a colour', () => {
      expect(run("const u = 'https://example.com/#abc123';")).toEqual([]);
      expect(run("const u = '/app/docs#bad';")).toEqual([]);
      expect(run("const u = 'see #section for more';")).toEqual([]);
    });
    it('comment handling cannot hide or invent a colour', () => {
      // `//` inside a string used to make the regex stripper eat the rest of the line.
      expect(run("const s = ['http://x.test', '#10b981'];")).toEqual(['colour #10b981']);
      // `/*` inside a glob string used to open a comment that swallowed real code.
      expect(run("const g = 'src/**/*.ts'; const c = '#abc';")).toEqual(['colour #abc']);
      expect(run('// #10b981 in a comment\n/* #fff */ const x = 1;')).toEqual([]);
    });
    it('rgb/rgba/hsl/hsla with raw numbers, except in the kit tokens file', () => {
      expect(run("const s = 'rgba(0,0,0,.5)';")).toEqual(['colour rgba(…)']);
      expect(run("const s = 'hsl(0 0% 0% / 0.5)';")).toEqual(['colour hsl(…)']);
      expect(run('const s = `rgb(16 185 129 / ${a})`;')).toEqual(['colour rgb(…)']);
      expect(run("const s = 'rgba(0,0,0,.5)';", '_kit/tokens.ts')).toEqual([]);
      // Digits that come from a variable are not raw.
      expect(run('const s = `hsl(var(--primary) / ${a})`;')).toEqual([]);
      expect(run("const s = 'hsl(var(--primary))';")).toEqual([]);
      expect(findColours('#12345', 'x.tsx')).toEqual([]);
    });
    it('hex is still flagged in tokens.ts', () => {
      expect(run("const s = '#10b981';", '_kit/tokens.ts')).toEqual(['colour #10b981']);
    });
  });

  describe('keys', () => {
    it('scrapes every mobile.* literal, not only t() arguments', () => {
      const a = analyzeSource('x.tsx', "const T = [{ labelKey: 'mobile.tabs.home' }]; t('mobile.kit.close'); const q = `mobile.a.b`; const n = 'mobiles.x';");
      expect(a.keys).toEqual(['mobile.a.b', 'mobile.kit.close', 'mobile.tabs.home']);
    });
    it('a t() whose key is not a literal fails unless marked with a reason', () => {
      expect(run('const a = t(key);')).toEqual(['dynamic-key t(key)']);
      expect(run('const a = t(`mobile.${x}`);')).toEqual(['dynamic-key t(`mobile.${x}`)']);
      expect(run('const a = ui.t(key);')).toEqual(['dynamic-key t(key)']);
      expect(run('const a = t(key); // i18n-dynamic: key is one of the TAB_KEYS table entries')).toEqual([]);
      expect(run('// i18n-dynamic: enumerated in STATUS_KEYS\nconst a = t(key);')).toEqual([]);
      expect(run('const a = t(key); // i18n-dynamic')).toEqual(['bad-suppression i18n-dynamic needs a reason', 'dynamic-key t(key)']);
      expect(run("const a = t('mobile.a.b', { count: 2 });")).toEqual([]);
    });
    it('checks each locale against its OWN catalog, with plural families', () => {
      const cat = {
        en: { mobile: { a: { b: 'x', n_one: '1', n_other: 'many' } } },
        'fr-CA': { mobile: { a: { b: 'x' } } }, // missing n_*
        'zh-CN': { mobile: { a: { n_other: 'n' } } }, // missing b
      };
      const keys = ['mobile.a.b', 'mobile.a.n', 'mobile.a'];
      expect(unresolvedKeys(keys, cat, LOCALES)).toEqual({
        en: ['mobile.a'], // a namespace prefix is not a key
        'fr-CA': ['mobile.a.n', 'mobile.a'],
        'zh-CN': ['mobile.a.b', 'mobile.a'],
      });
      expect(flattenKeys(cat.en)).toEqual(['mobile.a.b', 'mobile.a.n_one', 'mobile.a.n_other']);
    });
    it('the real catalogs flatten to mobile.* leaves in every locale', () => {
      for (const l of LOCALES) expect(flattenKeys(CATALOG[l]).filter((k) => k.startsWith('mobile.')).length, l).toBeGreaterThan(10);
    });
  });
});
