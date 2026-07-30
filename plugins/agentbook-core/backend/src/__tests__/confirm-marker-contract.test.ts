/**
 * The confirmation prompt's wording is a contract, because a test depends on it.
 *
 * The agent gates irreversible steps behind "Proceed? (yes/no)". The canonical
 * eval detects that prompt so it can answer "yes" and score the RESULT rather
 * than the question — before which a correct safety gate was being counted as a
 * failure: "no, that should be Travel category not Meals" was marked failed for
 * replying "Here's my plan: 1. Edit expense last (irreversible) Proceed?
 * (yes/no)", where the required word could not possibly have appeared yet.
 *
 * The response exposes no structured "awaiting approval" flag — verified against
 * production, which returns only
 * { message, actions, chartData, skillUsed, confidence, latencyMs, persona } —
 * so the harness matches the text. That makes the wording load-bearing, and this
 * pins it. If someone rewords the prompt, this fails here rather than silently
 * turning the eval back into scoring prompts as answers.
 *
 * The real fix is a structured flag on the response. Until then, this guard is
 * what keeps the text-matching honest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLANNER = readFileSync(join(__dirname, '../agent-planner.ts'), 'utf8');
const EVAL = readFileSync(
  // 5 levels: __tests__ -> src -> backend -> agentbook-core -> plugins -> root
  join(__dirname, '../../../../../scripts/run-canonical-eval.ts'),
  'utf8',
);

/** Must stay in sync with CONFIRM_MARKER in scripts/run-canonical-eval.ts. */
const MARKER = /Proceed\?\s*\(yes\/no\)/i;

describe('confirmation prompt contract', () => {
  it('the planner still emits the marker the eval looks for', () => {
    expect(PLANNER).toMatch(/Proceed\? \(yes\/no\)/);
  });

  it('emits it from exactly one place, so there is one wording to keep', () => {
    const hits = PLANNER.match(/Proceed\? \(yes\/no\)/g) ?? [];
    expect(hits.length).toBe(1);
  });

  it('the eval matches a real planner prompt', () => {
    // The shape production actually returned, reproduced verbatim.
    const real = "Here's my plan:\n\n1. Edit expense last (irreversible)\n\nProceed? (yes/no)";
    expect(MARKER.test(real)).toBe(true);
  });

  it('does not match an ordinary reply', () => {
    expect(MARKER.test('Recorded: $52.00 — lunch')).toBe(false);
    expect(MARKER.test('Invoice created (INV-2026-0001) — $5,000.00.')).toBe(false);
  });

  it('the eval and this guard use the same pattern', () => {
    expect(EVAL).toMatch(/const CONFIRM_MARKER = \/Proceed\\\?\\s\*\\\(yes\\\/no\\\)\/i;/);
  });
});
