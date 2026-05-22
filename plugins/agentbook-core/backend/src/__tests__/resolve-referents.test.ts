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
