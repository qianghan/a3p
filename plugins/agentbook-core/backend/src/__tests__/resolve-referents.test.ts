import { describe, it, expect } from 'vitest';
import { resolveReferents } from '../agent-brain';

const turn = (question: string, answer: string) => ({ question, answer });

describe('resolveReferents (G-014)', () => {
  it('returns text unchanged when no pronouns present', () => {
    const r = resolveReferents('log $5 coffee', [turn('what did I spend last month', 'You spent $1,200.')]);
    expect(r).toBe('log $5 coffee');
  });

  it('returns text unchanged when conversation is empty', () => {
    const r = resolveReferents('fix it', []);
    expect(r).toBe('fix it');
  });

  it('rewrites "the invoice" to the most recent invoice number', () => {
    const conv = [
      turn('send invoice INV-2026-0042 to acme', 'Drafted invoice INV-2026-0042 to Acme for $5,000.'),
    ];
    const r = resolveReferents('send the invoice', conv);
    expect(r).toBe('send invoice INV-2026-0042');
  });

  it('rewrites short standalone "it" when most-recent entity is an invoice', () => {
    const conv = [
      turn('draft invoice for acme', 'Drafted invoice INV-2026-0042 to Acme for $5,000.'),
    ];
    const r = resolveReferents('send it', conv);
    expect(r).toBe('send invoice INV-2026-0042');
  });

  it('does not rewrite "it" in long sentences (false-positive guard)', () => {
    const conv = [
      turn('draft invoice', 'Drafted invoice INV-2026-0042 to Acme.'),
    ];
    // 7-word sentence — should NOT trigger the standalone-it rewrite.
    const r = resolveReferents('I want to discuss it with my accountant', conv);
    expect(r).toBe('I want to discuss it with my accountant');
  });

  it('does not rewrite contractions like "it\'s" or possessive "its"', () => {
    const conv = [
      turn('draft invoice', 'Drafted invoice INV-2026-0042.'),
    ];
    const r = resolveReferents('what\'s its status', conv);
    // "its" is possessive, should NOT be rewritten. Sentence is also too long.
    expect(r).toBe('what\'s its status');
  });

  it('picks the MOST RECENT invoice when multiple are in context', () => {
    const conv = [
      turn('send updated invoice', 'Drafted invoice INV-2026-0099 to Beta.'),
      turn('old draft', 'Drafted invoice INV-2026-0042 to Acme.'),
    ];
    const r = resolveReferents('send the invoice', conv);
    // Most recent (first in array since DESC ordered) wins.
    expect(r).toBe('send invoice INV-2026-0099');
  });

  it('rewrites "the client" using the most-recent client mention', () => {
    const conv = [
      turn('show me overdue', 'Client Acme Corp has 2 overdue invoices.'),
    ];
    const r = resolveReferents('remind the client', conv);
    expect(r).toMatch(/remind client Acme Corp/i);
  });

  it('falls back gracefully when no entity types match', () => {
    const conv = [
      turn('hello', 'Hi, how can I help?'),
    ];
    const r = resolveReferents('fix it', conv);
    // No entity in conv, so "it" stays as-is.
    expect(r).toBe('fix it');
  });

  it('case-insensitive match on "the" but preserves case of inserted entity', () => {
    const conv = [
      turn('send invoice', 'Drafted invoice INV-2026-0042.'),
    ];
    const r = resolveReferents('Send The Invoice', conv);
    expect(r).toMatch(/INV-2026-0042/);
  });
});

describe('referent from structured entityId', () => {
  // "spent $89 on office supplies at Staples" then "mark it as personal" failed
  // in every eval run: the agent asked WHICH expense, one turn after recording
  // it. The pronoun path needs lastExpenseId, and the only way to get it was to
  // match an id pattern in the conversation TEXT — but the reply is
  // "Recorded: $89.00 — office supplies at Staples", which contains no id,
  // because showing a user a cuid would be absurd.
  //
  // The id already exists in structured form on the turn. These pin that it is
  // read from there, and that doing so did not make invoice threads worse.
  const convo = [{ question: 'spent $89 on office supplies at Staples', answer: 'Recorded: $89.00 — office supplies at Staples' }];

  it('resolves "it" from the last turn entityId, with no id in the text', () => {
    const turns = [
      { role: 'user', text: 'spent $89 on office supplies at Staples' },
      { role: 'bot', text: 'Recorded: $89.00 — office supplies at Staples', entityId: 'clx9expense01' },
    ];
    const out = resolveReferents('mark it as personal', convo, turns);
    expect(out).toContain('clx9expense01');
    expect(out).not.toBe('mark it as personal');
  });

  it('is unchanged when the last turn recorded nothing', () => {
    const turns = [
      { role: 'user', text: 'how much did I spend last month?' },
      { role: 'bot', text: 'You spent $1,240.00 across 9 transactions.' },
    ];
    expect(resolveReferents('mark it as personal', convo, turns)).toBe('mark it as personal');
  });

  it('does NOT let a stale expense outrank a newer invoice turn', () => {
    // The regression this nearly introduced. entityId is expense-only, so
    // seeding from the most recent turn that HAS one would resolve "send it"
    // to the expense recorded two turns earlier. Only the last bot turn counts.
    const turns = [
      { role: 'bot', text: 'Recorded: $89.00 — office supplies', entityId: 'clx9expense01' },
      { role: 'bot', text: 'Invoice created (INV-2026-0007) for Acme — $5,000.00.' },
    ];
    const out = resolveReferents('send it', [
      { question: 'invoice Acme $5000', answer: 'Invoice created (INV-2026-0007) for Acme — $5,000.00.' },
    ], turns);
    expect(out).not.toContain('clx9expense01');
    expect(out).toContain('INV-2026-0007');
  });

  it('still works with no turns passed (existing callers)', () => {
    expect(resolveReferents('mark it as personal', convo)).toBe('mark it as personal');
  });
});
