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
 * The `[...slug]` catch-all page (`app/(dashboard)/[...slug]/page.tsx`) reads
 * the SAME manifests from the database and would have resolved this path
 * correctly — but middleware's rewrite happens first, so that page is
 * effectively dead code for every `/agentbook/*` URL. This test compares
 * middleware's map against the manifests directly, so a route added to a
 * plugin without the matching middleware entry fails CI instead of shipping
 * silently, the way this one did.
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
