/**
 * Every shell-side constructor of the plugin ShellContext must include `i18n`.
 *
 * THE BUG THIS GUARDS
 *
 * Two places in the shell build the context object that plugins receive, and
 * both do it by ENUMERATING services by hand:
 *
 *   - PluginLoader.tsx  -> baseContext
 *   - sandbox.ts        -> sandboxedContext   (rebuilt from scratch, not merged)
 *
 * Neither included `i18n`. So every plugin page called useI18n(), found no
 * service on the context, and fell back to humanising the key —
 * `invoice_ui.total_outstanding` renders as "Total outstanding". Plausible
 * English, no error, no warning, permanently untranslatable. That is the whole
 * mechanism behind "when I select Chinese or French the UI does not change".
 *
 * WHY THE TYPE SYSTEM DID NOT CATCH IT
 *
 * `ShellContext.i18n` is declared optional, and legitimately so: a CDN plugin
 * bundle can be newer than the shell serving it, so plugins must tolerate a
 * shell with no i18n. Making it required would break that skew contract. The
 * cost is that an omission on the shell side compiles cleanly.
 *
 * WHY THE 167 OTHER i18n TESTS DID NOT CATCH IT
 *
 * Every one of them constructs the shell itself:
 *
 *     render(<ShellProvider value={shellFor('fr-CA')}><Page /></ShellProvider>)
 *
 * They prove a page translates GIVEN a correct service. They cannot see the
 * real shell failing to supply one — they supply it themselves. A green suite
 * was compatible with the feature being completely broken in production.
 *
 * WHY THIS TEST IS A SOURCE CHECK
 *
 * The sandbox half is verified behaviourally below, which is the stronger
 * form. PluginLoader's baseContext is a local inside a useEffect in a
 * component with heavy runtime dependencies, and there is no seam to observe
 * it through without restructuring the component purely to make it testable.
 * A source assertion is the honest tool for "this hand-written list of
 * services is missing an entry" — and it cannot be satisfied without the key
 * actually being there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandboxedContext } from '@/lib/plugins/sandbox';

const ROOT = join(__dirname, '../../..');

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('PluginLoader hands i18n to plugins', () => {
  const src = source('src/components/plugin/PluginLoader.tsx');

  it('baseContext includes i18n from the shell', () => {
    // Anchored on the assignment, not just the substring "i18n": a comment
    // mentioning i18n must not be able to satisfy this.
    expect(src).toMatch(/i18n:\s*currentShell\.i18n/);
  });

  it('does not pass a hardcoded or stubbed i18n', () => {
    // A literal object here would be a locale frozen at mount time, which
    // would look correct in a screenshot and never respond to the switcher.
    expect(src).not.toMatch(/i18n:\s*\{/);
  });
});

describe('the shell itself puts i18n on the context', () => {
  // The step ABOVE PluginLoader: ShellProvider calls useShellI18n() and must
  // place the result on its own context value, and useShellServices() — the
  // plugin-facing accessor — must forward it. If either dropped it, the fix in
  // PluginLoader would be reading `undefined` and everything below is moot.
  const src = source('src/contexts/shell-context.tsx');

  it('ShellProvider resolves i18n via useShellI18n', () => {
    expect(src).toMatch(/const i18n = useShellI18n\(\)/);
  });

  it('useShellServices forwards it to plugins', () => {
    expect(src).toMatch(/i18n:\s*shell\.i18n/);
  });
});

describe('the sandbox passes i18n through', () => {
  /** Minimal real-shaped context; only i18n matters to these assertions. */
  function contextWith(i18n: unknown) {
    const noop = () => {};
    return {
      auth: { user: null, isAuthenticated: false, getToken: () => null, onAuthStateChange: () => noop },
      notifications: { show: noop, success: noop, error: noop, warning: noop, info: noop },
      navigate: noop,
      eventBus: { emit: noop, on: () => noop, off: noop, request: async () => null },
      theme: { mode: 'dark', colors: {}, onThemeChange: () => noop },
      logger: { debug: noop, info: noop, warn: noop, error: noop, child: () => ({}) },
      permissions: { has: () => true, list: () => [] },
      integrations: {},
      capabilities: { has: () => true, list: () => [] },
      api: {},
      tenant: {},
      team: {},
      version: '2.0.0',
      i18n,
    } as never;
  }

  const i18nService = {
    locale: 'fr-CA',
    t: (key: string) => (key === 'common.cancel' ? 'Annuler' : key),
    formatMoney: () => '1 234,56 $',
    formatCurrency: () => '1 234,56 $',
    formatDate: () => '',
    formatDateOnly: () => '',
    formatNumber: () => '',
    formatPercent: () => '',
    parseAmount: () => ({ ok: true, cents: 0, ambiguous: false, formatted: '' }),
  };

  it('survives sandboxing in strict mode', () => {
    const out = createSandboxedContext(contextWith(i18nService), {
      pluginName: 'agentbook-invoice',
      pluginBasePath: '/plugins/agentbook-invoice',
      strictMode: true,
    });
    expect(out.i18n).toBeDefined();
  });

  it('the surviving service still WORKS — not merely present', () => {
    // Presence alone would pass on a stripped or frozen stub. Assert output.
    const out = createSandboxedContext(contextWith(i18nService), {
      pluginName: 'agentbook-invoice',
      pluginBasePath: '/plugins/agentbook-invoice',
      strictMode: true,
    });
    expect(out.i18n?.locale).toBe('fr-CA');
    expect(out.i18n?.t('common.cancel')).toBe('Annuler');
  });

  it('is passed through for trusted plugins too', () => {
    const out = createSandboxedContext(contextWith(i18nService), {
      pluginName: 'agentbook-core',
      pluginBasePath: '/plugins/agentbook-core',
      strictMode: false,
    });
    expect(out.i18n?.t('common.cancel')).toBe('Annuler');
  });

  it('an absent i18n stays absent rather than becoming a broken object', () => {
    // The skew case the optional field exists for: an older shell genuinely has
    // no i18n, and the SDK's useI18n() must see undefined so it can degrade.
    // Manufacturing an empty object here would defeat that.
    const out = createSandboxedContext(contextWith(undefined), {
      pluginName: 'agentbook-invoice',
      pluginBasePath: '/plugins/agentbook-invoice',
      strictMode: true,
    });
    expect(out.i18n).toBeUndefined();
  });
});
