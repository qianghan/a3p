/**
 * The Telegram adapter renders in the language the BRAIN replied in.
 *
 * The webhook enters `runWithBotLocale(...)` once per update, using
 * AbTenantConfig.locale. Everything the adapter composes itself — the
 * `botT(...)` button labels, the review prompts, the Breakdown block — is
 * therefore in the TENANT's language, even when the brain answered the user
 * in theirs. On a fr-CA tenant an English question came back as English prose
 * under a French "Procéder / Annuler" keyboard.
 *
 * Two fixes, both asserted here at the source level because both are WIRING
 * facts (which locale value is handed to the scope), and a test that mocked
 * the whole update pipeline would pass on a reverted call site:
 *
 *  1. the scope is entered with the language of the INCOMING message, so
 *     adapter-native replies (the ones the brain never sees) follow the user;
 *  2. when a brain result arrives, the scope is RE-entered with the locale
 *     the brain reports, so the chrome around its reply matches the reply.
 *
 * (2) has to hold on both paths that render a brain reply: the text handler
 * and the Proceed/Cancel `session:` callback. The callback path is the one
 * the prod transcript caught — turn 3 of a confirmed plan came back with
 * tenant-language chrome around an English execution summary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const ROUTE = readFileSync(
  join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'),
  'utf8',
);

describe('telegram reply locale', () => {
  it("re-enters the bot locale scope with the brain's replyLocale before rendering its reply", () => {
    // At least twice: the text path AND the Proceed-button session: callback.
    const rescopes = ROUTE.match(
      /runWithBotLocale\(\s*\{\s*\.\.\.botLocaleRowFor\(\)[^}]*locale:\s*result\.data\.replyLocale/g,
    ) || [];
    expect(
      rescopes.length,
      `re-scoped brain renders found:\n${rescopes.join('\n---\n')}`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('detects the incoming message language for adapter-native replies', () => {
    expect(ROUTE).toContain('resolveReplyLocale({');
    expect(ROUTE).toContain("from '@agentbook-core/reply-language'");
  });

  it('scopes the update with the resolved locale, not the raw tenant row', () => {
    // The bug was `runWithBotLocale(botLocaleRow, () => b.handleUpdate(update))`.
    expect(ROUTE).not.toMatch(/runWithBotLocale\(\s*botLocaleRow\s*,/);
    expect(ROUTE).toMatch(/runWithBotLocale\(\s*scopedRow\s*,\s*\(\)\s*=>\s*b\.handleUpdate\(update\)\)/);
  });

  it("carries the brain's replyLocale through callAgentBrain's return type", () => {
    // Without this the `result.data.replyLocale` reads above are `any`-typed
    // at best and a typo would be silent.
    expect(ROUTE).toMatch(/replyLocale\?: string/);
  });
});
