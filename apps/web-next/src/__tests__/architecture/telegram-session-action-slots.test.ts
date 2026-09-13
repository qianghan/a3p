/**
 * Architectural invariant: the Telegram adapter does not convert a reply into
 * a `sessionAction` while a slot-fill question is outstanding.
 *
 * Two systems can ask the user a question on Telegram, and only one of them
 * writes to AbConvThread.turns:
 *
 *   - the agent brain, whose reply is stored as a turn (with `askedQuestion`);
 *   - runAgentLoop, whose `needs_clarify_partial` question is persisted as
 *     `pendingSlots` in agentbook-conversation-context and nowhere else.
 *
 * A bare "yes" after the second kind used to be mapped to
 * `sessionAction = 'confirm'`. That skipped runAgentLoop (gated on
 * `!sessionAction`), so the slot was never filled, and the brain — which has
 * no record of the question — answered "Nothing is waiting for a yes."
 *
 * Source-level on purpose: the derivation sits inside a 4000-line webhook
 * handler behind a Telegraf context, and the failure is that a guard is
 * absent, which no mock of the handler's dependencies can surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// apps/web-next/src/__tests__/architecture -> apps/web-next/src
const SRC = join(__dirname, '..', '..');
const ROUTE = join(SRC, 'app/api/v1/agentbook/telegram/webhook/route.ts');
const SOURCE = readFileSync(ROUTE, 'utf8');

/** The `sessionAction` derivation, from its declaration to its closing brace. */
const DERIVATION = (() => {
  const start = SOURCE.indexOf('let sessionAction: string | undefined;');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("sessionAction = 'status'", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
})();

describe('telegram sessionAction derivation', () => {
  it('is guarded by convCtx.pendingSlots', () => {
    expect(DERIVATION).toMatch(/if\s*\(!feedback\s*&&\s*!convCtx\.pendingSlots\)/);
  });

  it('still yields to an explicit correction (feedback) first', () => {
    expect(DERIVATION).toMatch(/!feedback/);
  });

  it('keeps runAgentLoop gated on the absence of a session action', () => {
    // If this gate ever goes away the guard above is pointless — the loop
    // would run regardless and the two paths would both answer the user.
    expect(SOURCE).toMatch(/if \(!sessionAction\) \{/);
  });

  it('loads convCtx before deriving the action', () => {
    const load = SOURCE.indexOf('await loadCtx(');
    const derive = SOURCE.indexOf('let sessionAction: string | undefined;');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(derive);
  });
});
