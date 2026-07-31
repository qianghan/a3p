import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SECURITY GUARD — the e2e escape hatch must not be an open door.
 *
 * The Telegram webhook's secret check read:
 *
 *     if (expectedSecret && secret !== expectedSecret && !E2E_CAPTURE) → 401
 *
 * where `E2E_CAPTURE` is just
 * `E2E_TELEGRAM_CAPTURE === '1' && E2E_TELEGRAM_CHAT_ID !== ''`.
 *
 * So setting those two variables switched the secret check OFF. Neither is a
 * secret, both were about to be set on production to bring the 14 Telegram
 * tests online, and doing so would have reopened the unauthenticated-write
 * hole that blocked launch across all three regions — hours after it was
 * closed and verified with a live 401.
 *
 * The bypass was GLOBAL, which is the part that made it dangerous rather than
 * merely untidy: the chat-id scoping added in #405 keeps the capture BUFFER
 * away from real traffic, but this check never looked at the chat id, so an
 * anonymous POST naming a real tenant's chat would have been accepted and
 * written to their books.
 *
 * A code comment ("production has it off") is not an enforcement mechanism.
 * This is.
 */
// apps/web-next/src/__tests__/api/v1/agentbook/telegram -> repo root
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '..', '..');
const WEBHOOK = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';

/** Source with comments stripped — a guard must match code, not prose about code. */
function readCode(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the Telegram secret check cannot be disabled by a non-secret env var', () => {
  const code = readCode(WEBHOOK);

  it('the auth check does not treat E2E_CAPTURE alone as authorization', () => {
    // The exact shape of the shipped bug.
    expect(code).not.toMatch(/secret\s*!==\s*expectedSecret\s*&&\s*!\s*E2E_CAPTURE\s*\)/);
  });

  it('the bypass requires a presented token', () => {
    expect(code).toMatch(/e2eAuthorized/);
    expect(code).toMatch(/x-e2e-token/);
    expect(code).toMatch(/E2E_RESET_TOKEN/);
  });

  it('the bypass still returns 401 when the token is absent', () => {
    // `!!e2eToken` matters: without it, an unset E2E_RESET_TOKEN on the server
    // would make `undefined === null`-style comparisons the only thing standing
    // between an anonymous caller and a write. Fail closed.
    expect(code).toMatch(/!!\s*e2eToken/);
  });

  it('capture being enabled is necessary but not sufficient', () => {
    // E2E_CAPTURE must still gate it — the token alone should not open the
    // route on a deployment where capture was never turned on.
    expect(code).toMatch(/E2E_CAPTURE\s*&&\s*!!\s*e2eToken/);
  });
});

describe('the capture buffer stays scoped to the synthetic chat', () => {
  // Independent of the auth fix, and still required: #405. If this regressed,
  // enabling capture would swallow every real user's reply.
  const code = readCode(WEBHOOK);

  it('capture engages only when the chat id matches E2E_TELEGRAM_CHAT_ID', () => {
    expect(code).toMatch(/String\(chatId\)\s*===\s*E2E_CAPTURE_CHAT_ID/);
  });

  it('an unset chat id disables capture entirely', () => {
    expect(code).toMatch(/E2E_CAPTURE_CHAT_ID\s*!==\s*''/);
  });
});
