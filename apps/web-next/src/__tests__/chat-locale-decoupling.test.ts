// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lastBotMessageIsAboutExpense, normalizeAmounts } from '@/lib/agentbook-affirmative';

/**
 * Two places where chat behaviour was coupled to the ENGLISH WORDING of a
 * reply, rather than to a fact. Both had to go before the skill layer can be
 * translated (P1-2b), because both fail silently: the user sees a reply that
 * looks right and loses a control, or an affirmative that stops binding.
 *
 *   1. The Telegram Category/Personal keyboard was attached only when the
 *      reply contained the word "Recorded".
 *   2. The affirmative binder matched `toFixed(2)` against a reply formatted
 *      by Intl — which already failed in English for anything over $1,000.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const money = (cents: number, locale: string, currency: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);

describe('the affirmative binder matches an amount in any locale', () => {
  const active = { amountCents: 123456, vendorName: null, description: null };

  it('binds for amounts over a thousand — this failed in English before', () => {
    // "$1,234.56" vs toFixed(2) "1234.56". The grouping comma broke it, so an
    // ordinary four-figure expense stopped binding a "yes".
    const msg = `Recorded: ${money(123456, 'en-US', 'USD')} — office supplies`;
    expect(msg).toContain('1,234.56');
    expect(lastBotMessageIsAboutExpense(msg, active)).toBe(true);
  });

  it.each([
    ['en-US', 'USD'],
    ['fr-CA', 'CAD'],
    ['zh-CN', 'CNY'],
  ])('binds for %s, whose separators differ', (locale, currency) => {
    for (const cents of [8900, 123456, 1234567890]) {
      const msg = `Recorded: ${money(cents, locale, currency)} — office supplies`;
      expect(
        lastBotMessageIsAboutExpense(msg, { ...active, amountCents: cents }),
        `${locale} ${cents}: ${msg}`,
      ).toBe(true);
    }
  });

  it('still does not bind an unrelated amount', () => {
    expect(
      lastBotMessageIsAboutExpense('Recorded: $12.00 — coffee', { ...active, amountCents: 8900 }),
    ).toBe(false);
  });

  it('does not mistake a decimal comma for a grouping separator', () => {
    // "89,00" is eighty-nine, not eight thousand nine hundred.
    expect(normalizeAmounts('89,00 $')).toBe('89.00 $');
    expect(normalizeAmounts('1 234,56 $')).toBe('1234.56 $');
    expect(normalizeAmounts('$1,234.56')).toBe('$1234.56');
    // A four-digit group is not grouping: a year must survive intact.
    expect(normalizeAmounts('due 2026')).toBe('due 2026');
  });
});

describe('the Telegram expense keyboard is driven by a fact, not by wording', () => {
  const TG = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';
  const CORE = 'plugins/agentbook-core/backend/src/server.ts';
  const BRAIN = 'plugins/agentbook-core/backend/src/agent-brain.ts';

  it('the adapter no longer tests the reply for the word "Recorded"', () => {
    const src = stripComments(read(TG));
    expect(src).not.toMatch(/message\?\.includes\('Recorded'\)/);
    expect(src).toContain("result.data.skillUsed === 'record-expense' && result.data.recordedEntityId");
  });

  it('the core sets the signal where it builds that reply', () => {
    const src = stripComments(read(CORE));
    expect(src).toContain('recordedEntityId = String(data.id);');
    expect(src).toMatch(/\.\.\.\(recordedEntityId \? \{ recordedEntityId \} : \{\}\)/);
  });

  it('the brain forwards it on every path that forwards a skill reply', () => {
    const src = stripComments(read(BRAIN));
    // Both mapping sites — the session path and the main path. Forwarding on
    // only one is how a channel silently loses the signal.
    const forwards = src.match(/recordedEntityId: responseData\.recordedEntityId/g) || [];
    expect(forwards.length, 'expected both responseData mapping sites').toBe(2);
    expect(src).toMatch(/recordedEntityId\?: string;/);
  });
});
