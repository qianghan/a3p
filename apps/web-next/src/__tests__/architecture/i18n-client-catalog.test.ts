/**
 * The CLIENT catalog is a subset of the full one, and both facts about that
 * subset are enforced here.
 *
 * WHY THERE ARE TWO CATALOGS
 *
 * `catalog.ts` is one frozen object holding all three locale packs. Nothing
 * tree-shakes it — a default-imported JSON module is one opaque value, and
 * `CATALOG[loc]` plus `readKey()` are dynamic property access, so no bundler
 * can prove any part unreachable. Measured, it is 97 kB GZIPPED, landing in
 * one chunk that the root layout pulls into every page route: the largest
 * single chunk in First Load JS, bigger than React itself.
 *
 * 36 kB of that was namespaces no browser can ever render. `bot` alone is
 * 76.6 kB of raw Telegram copy across three locales, reached only by the
 * webhook; `skill`, `proactive` and `rate` are likewise server-side. So the
 * client gets its own entry point with those namespaces left out.
 *
 * WHY THIS IS NOT A PER-ROUTE SPLIT
 *
 * The obvious shape — each route imports only the namespaces it uses — cannot
 * work here, and it is worth writing down so nobody spends a day rediscovering
 * it. Routes do not import the catalog at all: ShellProvider does, once, and
 * the root layout puts it on every page. And the namespaces actually needed at
 * runtime are not statically knowable, because plugin frontends are UMD
 * bundles injected by lib/plugins/umd-loader.ts — outside webpack entirely —
 * which resolve keys through the shell's injected `t`. Which plugins mount is
 * tenant data from the database. `/plugins/[pluginName]` can mount any of them.
 *
 * Namespaces no client code references AT ALL are the part that is decidable,
 * and that is exactly what this file decides.
 *
 * THE FAILURE MODE IT GUARDS
 *
 * Dropping a namespace the client does need is SILENT. useT() falls back to
 * humanising the key, so `core_ui.gst_help_unknown` renders as "Gst help
 * unknown" — plausible-looking English, no error, no warning. That is the same
 * mechanism that once made every plugin page untranslatable. So the subset is
 * not a hand-maintained list that is merely reviewed: the second test below
 * recomputes what client source actually references and fails if the client
 * catalog is missing any of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, NAMESPACES } from '@agentbook/i18n/catalog';
import {
  CLIENT_CATALOG,
  CLIENT_NAMESPACES,
  SERVER_ONLY_NAMESPACES,
  AVAILABLE_LOCALES,
} from '@agentbook/i18n/catalog-client';
import { LOCALE_TAGS } from '../../../../../packages/agentbook-i18n/src/locale-meta';

const REPO = join(__dirname, '../../../../..');

/** Every source file that can end up in a browser bundle. */
function clientSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      // API route handlers never reach a browser.
      if (p.includes(join('src', 'app', 'api'))) continue;
      out.push(p);
    }
  };
  walk(join(REPO, 'apps/web-next/src'));
  for (const plugin of readdirSync(join(REPO, 'plugins'))) {
    walk(join(REPO, 'plugins', plugin, 'frontend/src'));
  }
  return out;
}

/** Namespaces that client source actually resolves keys from: t('nav.…'). */
function referencedNamespaces(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of clientSources()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*['"]([a-z][a-z0-9_]*)\./g)) {
      if (!found.has(m[1])) found.set(m[1], file.slice(REPO.length + 1));
    }
  }
  return found;
}

describe('i18n client catalog: the subset is exactly what it claims', () => {
  it('leaves the server-only namespaces out', () => {
    for (const locale of Object.keys(CLIENT_CATALOG)) {
      const present = Object.keys(CLIENT_CATALOG[locale]);
      for (const ns of SERVER_ONLY_NAMESPACES) {
        expect(present, `${locale} still ships server-only '${ns}'`).not.toContain(ns);
      }
    }
  });

  it('accounts for every namespace in the full catalog', () => {
    // No namespace may be silently absent from BOTH lists — that is how a new
    // pack would end up in neither the client bundle nor the server's reckoning.
    expect([...CLIENT_NAMESPACES, ...SERVER_ONLY_NAMESPACES].sort()).toEqual(NAMESPACES);
  });

  /**
   * This is the assertion that pays for LOCALE_TAGS being declared instead of
   * computed. `AVAILABLE_LOCALES` was `Object.keys(CATALOG)` precisely so the
   * two could never disagree — a good instinct with a 97 kB price tag, since
   * importing it retained every string in the product. Declaring the list and
   * asserting it here keeps the guarantee and drops the payload; without this
   * test the change would be a straight regression in safety.
   */
  it('declares the same locales the full catalog defines', () => {
    expect(LOCALE_TAGS.slice().sort()).toEqual(Object.keys(CATALOG).sort());
    expect(AVAILABLE_LOCALES.slice().sort()).toEqual(Object.keys(CATALOG).sort());
  });

  it('keeps the same locales and key shape as the full catalog', () => {
    expect(Object.keys(CLIENT_CATALOG).sort()).toEqual(Object.keys(CATALOG).sort());
    for (const locale of Object.keys(CLIENT_CATALOG)) {
      expect(Object.keys(CLIENT_CATALOG[locale]).sort(), `namespaces for ${locale}`)
        .toEqual([...CLIENT_NAMESPACES].sort());
      // The subset must be the SAME data, not a re-typed copy.
      for (const ns of CLIENT_NAMESPACES) {
        expect(CLIENT_CATALOG[locale][ns], `${locale}.${ns}`).toBe(
          (CATALOG[locale] as Record<string, unknown>)[ns],
        );
      }
    }
  });
});

describe('i18n client catalog: nothing the client needs is missing', () => {
  it('contains every namespace client source resolves keys from', () => {
    const referenced = referencedNamespaces();
    const missing = [...referenced.entries()]
      .filter(([ns]) => !CLIENT_NAMESPACES.includes(ns))
      // A key that is not in the catalog at all is a different bug, caught by
      // the unwired-key guard; only real namespaces are this file's business.
      .filter(([ns]) => NAMESPACES.includes(ns))
      .map(([ns, where]) => `${ns} (first seen in ${where})`);
    expect(
      missing,
      'client code resolves these namespaces but the client catalog omits ' +
        'them, so they will render as humanised key names rather than text',
    ).toEqual([]);
  });

  it('finds a non-trivial number of references', () => {
    // Guard the guard: a broken scan reports zero and makes the test above
    // vacuously true, which is exactly how a silent regression would ship.
    expect(referencedNamespaces().size).toBeGreaterThan(15);
  });
});

describe('i18n client catalog: no client module reaches the full catalog', () => {
  /**
   * Importing ANYTHING derived from CATALOG retains all of it. `AVAILABLE_LOCALES`
   * is `Object.keys(CATALOG)` and `offerableLocales()` is built on it, so a
   * component that only wants the list of languages pulls in 97 kB of strings —
   * measured on a bundle whose sole import was `offerableLocales`.
   *
   * This is not a theoretical hazard. The first attempt at this split cut
   * 108 kB of raw JSON out of the client catalog and every route got 3-4 kB
   * BIGGER, because one `AVAILABLE_LOCALES` import was left behind and the
   * build carried both catalogs. A split that leaves one derived import behind
   * is not a partial win, it is a loss — hence a check rather than a comment.
   */
  const FORBIDDEN = /from\s+['"]@agentbook\/i18n\/catalog['"]/;

  it('no browser-reachable file imports @agentbook/i18n/catalog', () => {
    const offenders = clientSources()
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        if (!FORBIDDEN.test(text)) return false;
        // `server-only` modules are compile-time fenced out of client bundles.
        return !/^\s*import\s+['"]server-only['"]/m.test(text);
      })
      .map((f) => f.slice(REPO.length + 1));
    expect(
      offenders,
      "these reach the full catalog; import '@agentbook/i18n/catalog-client' " +
        "instead, or add `import 'server-only'` if the module is server-side",
    ).toEqual([]);
  });
});

describe('i18n client catalog: the bundle guard uses sound markers', () => {
  /**
   * bin/i18n-bundle-guard.sh --shell greps the built chunks for these strings.
   * A marker that also occurs in a client namespace would fail the guard on a
   * correct build; one that has drifted out of the packs would pass it on a
   * broken build, which is the worse direction. Both are checked here because
   * a shell script cannot check itself.
   */
  const GUARD = readFileSync(join(REPO, 'bin/i18n-bundle-guard.sh'), 'utf8');

  function markers(): string[] {
    const block = GUARD.match(/SERVER_ONLY_MARKERS=\(([\s\S]*?)\n\)/);
    if (!block) return [];
    return [...block[1].matchAll(/^\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) =>
      m[1].replace(/\\(.)/g, '$1'),
    );
  }

  /** Every string value in a namespace, flattened one level. */
  function valuesOf(locale: string, ns: string): string[] {
    const data = (CATALOG[locale] as Record<string, unknown>)[ns] as Record<string, unknown>;
    const out: string[] = [];
    for (const v of Object.values(data ?? {})) {
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') {
        out.push(...Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === 'string'));
      }
    }
    return out;
  }

  it('declares one marker per server-only namespace', () => {
    expect(markers()).toHaveLength(SERVER_ONLY_NAMESPACES.length);
  });

  it('every marker is still present in a server-only namespace', () => {
    const serverText = SERVER_ONLY_NAMESPACES.flatMap((ns) => valuesOf('en', ns));
    for (const marker of markers()) {
      expect(
        serverText.some((v) => v.includes(marker)),
        `marker "${marker}" is no longer in any server-only pack, so the ` +
          'guard would pass a build that leaked one',
      ).toBe(true);
    }
  });

  it('no marker occurs in a namespace the client legitimately ships', () => {
    const clientText = CLIENT_NAMESPACES.flatMap((ns) => valuesOf('en', ns));
    for (const marker of markers()) {
      const clash = clientText.filter((v) => v.includes(marker));
      expect(clash, `marker "${marker}" also appears in a client namespace`).toEqual([]);
    }
  });

  it('every marker is ASCII', () => {
    // The minifier escapes non-ASCII in some chunks, so a grep for a French or
    // Chinese marker can miss a pack that is genuinely there.
    for (const marker of markers()) {
      expect(/^[\x20-\x7e]+$/.test(marker), `marker "${marker}" is not ASCII`).toBe(true);
    }
  });
});
