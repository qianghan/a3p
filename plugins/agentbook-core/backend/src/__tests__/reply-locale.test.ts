import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { replyT, __clearReplyLocaleCache } from '../reply-locale';

/**
 * The agent's deterministic replies were the last layer of the chat surface
 * still hardcoded in English. The Telegram chrome (310 keys) and the LLM's
 * prose already follow the tenant, so a fr-CA tenant read French wrapped in
 * English — worse than either language alone.
 *
 * The `agent.*` keys these wire up already existed, in all three locales, and
 * were referenced by no code at all.
 */

describe('replyT', () => {
  beforeEach(() => __clearReplyLocaleCache());

  it('answers in the tenant locale, including the regional tag', () => {
    expect(replyT({ locale: 'fr-CA' })('agent.undo_success', { description: 'lunch' })).toBe(
      'Annulé : lunch',
    );
    expect(replyT({ locale: 'zh-CN' })('agent.undo_success', { description: 'lunch' })).toBe(
      '已撤销：lunch',
    );
    expect(replyT({ locale: 'en-US' })('agent.undo_success', { description: 'lunch' })).toBe(
      'Undone: lunch',
    );
  });

  it('falls back to English rather than throwing when the config is absent', () => {
    // A failed or missing AbTenantConfig read must cost wording, never the
    // answer — the caller passes `null` on a database error.
    for (const cfg of [null, undefined, {}, { locale: null }, { locale: 'xx-YY' }]) {
      expect(replyT(cfg)('agent.undo_success', { description: 'x' }), String(cfg)).toBe('Undone: x');
    }
  });

  it('reuses one translator per locale', () => {
    expect(replyT({ locale: 'fr-CA' })).toBe(replyT({ locale: 'fr-CA' }));
    expect(replyT({ locale: 'fr-CA' })).not.toBe(replyT({ locale: 'zh-CN' }));
  });
});

describe('every agent.* key the brain asks for exists', () => {
  // `t()` returns the KEY when it misses, so a typo ships to a user as
  // "agent.undo_sucess" rather than failing anywhere. Cross-locale parity
  // tests cannot see this: they compare catalogs to each other, not code to
  // catalog.
  const BRAIN = readFileSync(join(__dirname, '../agent-brain.ts'), 'utf8');
  const en = JSON.parse(
    readFileSync(
      join(__dirname, '../../../../../packages/agentbook-i18n/src/locales/en/agent.json'),
      'utf8',
    ),
  ) as Record<string, string>;

  const used = [...BRAIN.matchAll(/\bt\('agent\.([a-z0-9_]+)'/g)].map((m) => m[1]);

  it('finds the call sites (not vacuous)', () => {
    expect(used.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves every key, so none can ship as its own name', () => {
    const missing = used.filter((k) => !(k in en));
    expect(missing, `agent.* keys used in agent-brain.ts but absent from en/agent.json`).toEqual([]);
  });

  it('the three wired replies no longer hold an English literal', () => {
    const stripped = BRAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped).not.toMatch(/message: `Undone: \$\{/);
    expect(stripped).not.toMatch(/I couldn't undo "\$\{lastUndo\.description\}"/);
    expect(stripped).not.toMatch(/I'm not entirely sure I understood/);
  });
});
