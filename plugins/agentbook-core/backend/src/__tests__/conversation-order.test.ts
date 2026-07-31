import { describe, it, expect } from 'vitest';
import { pairTurns } from '../agent-brain';

/**
 * The order of `conversation[]` is a CONTRACT, not an implementation detail.
 *
 * There are two producers of it and they disagreed:
 *   - the brain: AbConvThread.turns, appended chronologically, then pairTurns
 *   - the fallback in classifyAndExecuteV1: abConversation.findMany with
 *     `orderBy: { createdAt: 'desc' }` — newest-first
 *
 * Every CONSUMER assumes newest-first:
 *   - resolveReferents scans front-to-back and keeps the FIRST match ("newer
 *     mentions win", per its own comment)
 *   - brainAccountantFallback takes .slice(0, 3) as "recent conversation"
 *   - the planner takes .slice(0, 5).reverse() to get chronological order
 *
 * So the brain's oldest-first array made all three read the wrong end of the
 * thread: "send the invoice" resolved to the OLDEST invoice in the window, and
 * the LLM prompts labelled "recent conversation" dropped the newest exchange.
 * pairTurns is the one place to fix it.
 */
describe('pairTurns returns newest-first', () => {
  const turns = [
    { role: 'user', text: 'invoice Acme $5000' },
    { role: 'bot', text: 'Invoice created (INV-2026-0001) for Acme.' },
    { role: 'user', text: 'invoice Beta $900' },
    { role: 'bot', text: 'Invoice created (INV-2026-0002) for Beta.' },
  ];

  it('puts the most recent exchange first', () => {
    const pairs = pairTurns(turns);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe('invoice Beta $900');
    expect(pairs[1].question).toBe('invoice Acme $5000');
  });

  it('a .slice(0, n) consumer therefore gets the NEWEST n', () => {
    // This is what brainAccountantFallback does. With 4 pairs and slice(0, 3)
    // the oldest-first order silently dropped the turn the user just sent.
    const newest = pairTurns(turns).slice(0, 1);
    expect(newest[0].answer).toContain('INV-2026-0002');
  });

  it('a .reverse() consumer gets chronological order', () => {
    // This is what the planner does to build its prompt.
    const chronological = pairTurns(turns).slice(0, 5).reverse();
    expect(chronological[0].question).toBe('invoice Acme $5000');
  });

  it('ignores unpaired trailing turns', () => {
    const pairs = pairTurns([...turns, { role: 'user', text: 'and meals?' }]);
    expect(pairs).toHaveLength(2);
  });

  it('is empty for an empty thread', () => {
    expect(pairTurns([])).toEqual([]);
  });
});
