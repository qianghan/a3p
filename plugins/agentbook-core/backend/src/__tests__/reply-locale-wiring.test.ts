import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The resolver from reply-language.ts only helps if the two places that build
 * deterministic reply text actually call it. Both used to read
 * AbTenantConfig.locale directly, which is how an English question on a fr-CA
 * tenant came back as English prose with `42 014,79 CA$` in the middle of it
 * and a French template line underneath.
 *
 * Source-level assertions on purpose: these are WIRING facts (which value is
 * handed to replyT / fmtCurrency), and the behavioural half — what
 * resolveReplyLocale decides — is covered by reply-language.test.ts. A test
 * that mocked the whole reply path would pass on a reverted call site.
 */
const SERVER = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const BRAIN = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');

describe('reply locale wiring', () => {
  it('server.ts derives the reply locale from the user text, not the tenant row alone', () => {
    expect(SERVER).toContain('resolveReplyLocale({');
    expect(SERVER).toMatch(/const t = replyT\(\{ locale: replyLocale \}\)/);
    expect(SERVER).not.toMatch(/replyT\(\{ locale: tenantLocale \}\)/);
    // money in replies formats with the reply locale
    expect(SERVER).toMatch(/const tenantMoney = \(cents: number, currency\?: string\) =>\s*fmtCurrency\(cents, currency \|\| tenantCurrency, replyLocale\)/);
  });

  it('server.ts feeds the thread to the resolver so a bare "yes" keeps the language', () => {
    expect(SERVER).toMatch(/previousUserTexts:\s*\(classification\.conversation/);
    // `conversation` is NEWEST FIRST (pairTurns contract) — reversing it here
    // would make the resolver read the OLDEST turn as the most recent one.
    expect(SERVER).not.toMatch(/previousUserTexts:[\s\S]{0,160}\.reverse\(\)/);
  });

  it('server.ts formats no reply-facing value with the tenant locale any more', () => {
    expect(SERVER).not.toMatch(/fmtCurrency\([^)]*tenantLocale\)/);
    expect(SERVER).not.toMatch(/toLocaleDateString\(tenantLocale/);
  });

  it('server.ts reports the locale it replied in', () => {
    // The Telegram adapter renders its own buttons/labels and needs to know.
    expect(SERVER).toMatch(/responseData: \{[\s\S]{0,400}replyLocale/);
  });

  it('agent-brain.ts uses the same resolver for its own templates and reports it', () => {
    expect(BRAIN).toContain('resolveReplyLocale({');
    expect(BRAIN).not.toMatch(/const t = replyT\(replyConfig\)/);
    expect(BRAIN).toContain('replyLocale');
  });

  it('agent-brain.ts re-resolves once the thread is loaded', () => {
    // The first resolve happens before Step 2, so it has no history: a bare
    // "oui" after a French turn would fall back to the tenant locale there.
    expect(BRAIN).toMatch(/previousUserTexts:/);
  });

  it('buildResponse carries replyLocale through to the caller', () => {
    expect(BRAIN).toMatch(/replyLocale\?: string/);
    expect(BRAIN).toMatch(/replyLocale: responseData\.replyLocale \?\? replyLocale/);
  });
});
