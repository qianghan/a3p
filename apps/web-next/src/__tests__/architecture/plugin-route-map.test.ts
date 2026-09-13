/**
 * The `/agentbook/*` route middleware must know about every route a plugin
 * manifest declares.
 *
 * `/agentbook/sales-tax-return` (the GST/BAS return, linked from the Tax tab
 * bar) was added to `plugins/agentbook-tax/plugin.json`, to the plugin's own
 * router (`App.tsx`), and to its tab bar (`TaxLayout.tsx`) — everywhere a
 * developer would naturally think to add it. It was never added to
 * `PLUGIN_ROUTE_MAP` in `middleware.ts`, a second, hand-maintained map that
 * the comment above it says to "keep in sync" but nothing enforces.
 *
 * That map is checked BEFORE any React code runs. Its final entry is a
 * catch-all — `'/agentbook': 'agentbookCore'` — that matches any
 * `/agentbook/*` path not claimed by an earlier, more specific entry. So a
 * missing entry doesn't 404; it silently rewrites to agentbook-core's own
 * app, which renders whatever ITS internal router falls back to (the chat
 * page) — with no error, and a URL bar that still reads
 * `/agentbook/sales-tax-return`. The user sees the wrong plugin's UI instead
 * of a broken link, which is why the report was "wrong page", not "404".
 *
 * There used to be a `[...slug]` catch-all page that would have resolved this
 * path correctly — but middleware's rewrite happens first, so that page was
 * dead code for every `/agentbook/*` URL. It has since been deleted (it made
 * every unmatched path in the app return `200 text/html`), so this map is the
 * only thing standing between a plugin route and a 404. This test compares it
 * against the manifests directly, so a route added to a plugin without the
 * matching middleware entry fails CI instead of shipping silently, the way
 * this one did.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PLUGIN_ROUTE_MAP } from '@/middleware';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

function toCamelCase(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

interface ManifestRoute {
  plugin: string;
  expectedName: string;
  base: string;
}

/**
 * Every `/agentbook/<something>` base route declared by a plugin manifest,
 * excluding the bare `/agentbook` root — that one belongs to agentbook-core
 * itself and is already the map's own fallback entry.
 */
function declaredAgentbookRoutes(): ManifestRoute[] {
  const out: ManifestRoute[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    const manifestPath = path.join(PLUGINS_DIR, dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const routes: string[] = manifest.frontend?.routes ?? [];
    const bases = new Set(
      routes
        .map((r) => r.replace(/\/?\*$/, ''))
        .filter((base) => base.startsWith('/agentbook/')),
    );
    for (const base of bases) {
      out.push({ plugin: manifest.name, expectedName: toCamelCase(manifest.name), base });
    }
  }
  return out;
}

/**
 * Every base route any plugin manifest declares, with the plugin that owns it.
 * Unlike `declaredAgentbookRoutes` this does not filter by prefix — the point
 * is to account for ALL of them.
 */
function allDeclaredRoutes(): ManifestRoute[] {
  const out: ManifestRoute[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    const manifestPath = path.join(PLUGINS_DIR, dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const routes: string[] = manifest.frontend?.routes ?? [];
    const bases = new Set(routes.map((r) => r.replace(/\/?\*$/, '')).filter(Boolean));
    for (const base of bases) {
      out.push({ plugin: manifest.name, expectedName: toCamelCase(manifest.name), base });
    }
  }
  return out;
}

describe('PLUGIN_ROUTE_MAP vs plugin manifests', () => {
  it('has an entry for every /agentbook/* route a manifest declares', () => {
    const declared = declaredAgentbookRoutes();
    const missing = declared.filter((r) => !(r.base in PLUGIN_ROUTE_MAP));
    if (missing.length > 0) {
      const detail = missing
        .map((r) => `  ${r.base}  (declared by ${r.plugin}, needs '${r.base}': '${r.expectedName}')`)
        .join('\n');
      throw new Error(
        `${missing.length} route(s) declared in plugin.json but missing from ` +
        `PLUGIN_ROUTE_MAP in middleware.ts. A missing entry does not 404 — it ` +
        `silently falls through to the '/agentbook' catch-all and renders ` +
        `agentbook-core's chat UI instead:\n${detail}`,
      );
    }
    // Not a vacuous pass: fail loudly if manifests changed shape and this
    // measure stopped seeing anything at all.
    expect(declared.length).toBeGreaterThan(0);
  });

  it('maps each declared route to the plugin that actually owns it', () => {
    const declared = declaredAgentbookRoutes();
    const wrong = declared
      .filter((r) => r.base in PLUGIN_ROUTE_MAP)
      .filter((r) => PLUGIN_ROUTE_MAP[r.base] !== r.expectedName);
    if (wrong.length > 0) {
      const detail = wrong
        .map((r) => `  ${r.base}  maps to '${PLUGIN_ROUTE_MAP[r.base]}', but ${r.plugin} owns it (expected '${r.expectedName}')`)
        .join('\n');
      throw new Error(`${wrong.length} route(s) point at the wrong plugin:\n${detail}`);
    }
  });
});

/**
 * Nothing catches an unrecognised path any more.
 *
 * `app/(dashboard)/[...slug]/page.tsx` used to match every path Next.js had no
 * route for. It was a client component, so it answered `200 text/html` and
 * drew a 404 screen only once JavaScript ran. That is what broke MCP OAuth
 * discovery (PR #556): the SDK falls back to the root metadata URL only on a
 * 4xx, so a 200 meant "found it" and it threw parsing an HTML page as JSON.
 *
 * Deleting that page is what lets Next.js return a genuine 404 — it does so at
 * the routing layer, before any rendering, which is the only point where the
 * status can still be set. (Calling `notFound()` from a page does NOT work
 * here: an ancestor `loading.tsx` and the `(dashboard)` client layout both put
 * the route into streaming mode, and a streamed response has already committed
 * `200` by the time the page renders. Measured, not assumed.)
 *
 * The consequence is that a plugin route this map does not know about is now a
 * hard 404 instead of a slow success. So every base route a manifest declares
 * has to be accounted for by one of the two things that can still serve it.
 * This test is that accounting.
 */
describe('every declared plugin route has something that serves it', () => {
  it('is served by /plugins/[pluginName] or by PLUGIN_ROUTE_MAP', () => {
    const declared = allDeclaredRoutes();

    const unserved = declared.filter(
      (r) =>
        // `/plugins/<name>` and its sub-paths have their own page.
        !r.base.startsWith('/plugins/') &&
        // Everything else needs a middleware rewrite to reach its plugin.
        !(r.base in PLUGIN_ROUTE_MAP),
    );

    if (unserved.length > 0) {
      const detail = unserved
        .map((r) => `  ${r.base}  (declared by ${r.plugin}, needs '${r.base}': '${r.expectedName}')`)
        .join('\n');
      throw new Error(
        `${unserved.length} route(s) declared in plugin.json that nothing serves. ` +
        `There is no [...slug] catch-all any more, so these return a genuine 404 ` +
        `in production instead of rendering. Add each to PLUGIN_ROUTE_MAP in ` +
        `middleware.ts:\n${detail}`,
      );
    }

    // Not a vacuous pass: fail loudly if manifests changed shape and this
    // measure stopped seeing anything at all.
    expect(declared.length).toBeGreaterThan(0);
  });
});
