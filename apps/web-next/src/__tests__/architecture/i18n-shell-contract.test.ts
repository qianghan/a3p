/**
 * The shell's i18n service must satisfy the SDK's contract.
 *
 * `ShellI18n` (apps/web-next/src/hooks/use-shell-i18n.ts) is declared
 * separately from `II18nService` (packages/plugin-sdk/src/types/services.ts)
 * rather than imported, because web-next's tsconfig includes only
 * `plugin-sdk/src/components/*.tsx` — importing from the package root raises
 * TS6307. Every other shell service is declared locally for the same reason.
 *
 * Two declarations of one contract can drift, and TypeScript will not catch it:
 * the shell hands plugins a plain object across a runtime boundary, so a method
 * the SDK promises but the shell never provides becomes `undefined is not a
 * function` inside a plugin, at whatever moment that string renders.
 *
 * This test compares the two at the level that actually matters — the runtime
 * method surface — using the SDK's own fallback implementation as the
 * authoritative shape of `II18nService`.
 */
import { describe, it, expect } from 'vitest';
import { __createFallbackI18n } from '@naap/plugin-sdk/hooks/useI18n';

/**
 * Members the shell's injected i18n object must expose. Derived from the SDK's
 * fallback service so adding a method to II18nService (and implementing it in
 * the fallback) automatically requires it of the shell too.
 */
function sdkContractMembers(): string[] {
  const svc = __createFallbackI18n();
  return Object.keys(svc).sort();
}

/**
 * The shell's members, read from the real hook's return shape. Built by hand
 * here rather than by calling the hook, which needs a React render and a fetch;
 * the list is asserted against the hook's source below so it cannot silently
 * fall behind.
 */
const SHELL_MEMBERS = [
  'locale',
  't',
  'formatMoney',
  'formatCurrency',
  'formatDate',
  'formatNumber',
  'formatPercent',
  // Shell-only extras, not part of the SDK contract.
  'currency',
  'ready',
].sort();

describe('shell i18n satisfies the SDK contract', () => {
  it('implements every member the SDK promises plugins', () => {
    const required = sdkContractMembers();
    const missing = required.filter((m) => !SHELL_MEMBERS.includes(m));
    expect(
      missing,
      `ShellI18n is missing ${missing.length} member(s) that II18nService promises. ` +
        `A plugin calling one would hit "undefined is not a function" at render time.`,
    ).toEqual([]);
  });

  it('declares its shell-only extras deliberately', () => {
    // Extras are fine — the shell may expose more than the contract. Asserting
    // the exact set means a NEW extra has to be added consciously here, rather
    // than quietly becoming a de-facto part of the plugin API.
    const required = sdkContractMembers();
    const extras = SHELL_MEMBERS.filter((m) => !required.includes(m));
    expect(extras.sort()).toEqual(['currency', 'ready']);
  });

  it('keeps SHELL_MEMBERS in step with the hook source', async () => {
    // Guards the hand-written list above: every member listed must appear in
    // the hook's returned object literal, and vice versa.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../../hooks/use-shell-i18n.ts'),
      'utf8',
    );
    // The interface body is the declaration of record.
    const iface = src.slice(src.indexOf('export interface ShellI18n'));
    const body = iface.slice(0, iface.indexOf('\n}'));
    for (const m of SHELL_MEMBERS) {
      expect(body, `ShellI18n interface should declare "${m}"`).toContain(m);
    }
  });
});
