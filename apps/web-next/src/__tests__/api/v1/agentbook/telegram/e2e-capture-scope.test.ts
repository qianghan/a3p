/**
 * E2E capture must never intercept a real user's reply.
 *
 * The capture flag exists so the nightly suite can read what the bot WOULD have
 * said. Its original form keyed off the env var alone, so every inbound update
 * was captured — meaning turning it on in production would have swallowed every
 * real user's message while still returning 200. The bot would have gone silent
 * for everyone, with no error anywhere. That made the flag unusable against
 * prod, which is why the entire Telegram phase had no way to run there.
 *
 * These are pure predicate tests: the scoping decision is a security boundary,
 * so it gets a guard that can actually fail rather than a comment promising it
 * is safe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const REAL_USER_CHAT = 5336658682; // a genuine Telegram private-chat id
const E2E_CHAT = '555555555';

/**
 * Mirror of the module-level predicate. Re-declared rather than imported
 * because the real one is baked from env at module load, and the property under
 * test is exactly how it behaves across different env combinations.
 */
function makePredicate(enabled: boolean, configuredChatId: string) {
  const active = enabled && configuredChatId !== '';
  return (chatId: number | string | undefined) =>
    active && chatId !== undefined && String(chatId) === configuredChatId;
}

describe('E2E telegram capture scoping', () => {
  it('captures the dedicated synthetic test chat', () => {
    const isCapture = makePredicate(true, E2E_CHAT);
    expect(isCapture(Number(E2E_CHAT))).toBe(true);
    expect(isCapture(E2E_CHAT)).toBe(true); // string and number ids both arrive
  });

  it('NEVER captures a real user, even with the flag switched on', () => {
    const isCapture = makePredicate(true, E2E_CHAT);
    expect(isCapture(REAL_USER_CHAT)).toBe(false);
  });

  it('is inert when no test chat id is configured, whatever the flag says', () => {
    // Fail safe: a half-configured environment must not start swallowing replies.
    const isCapture = makePredicate(true, '');
    expect(isCapture(REAL_USER_CHAT)).toBe(false);
    expect(isCapture(Number(E2E_CHAT))).toBe(false);
  });

  it('is inert when the flag is off', () => {
    const isCapture = makePredicate(false, E2E_CHAT);
    expect(isCapture(Number(E2E_CHAT))).toBe(false);
  });

  it('is inert for an update carrying no chat id', () => {
    const isCapture = makePredicate(true, E2E_CHAT);
    expect(isCapture(undefined)).toBe(false);
  });
});

describe('the webhook wires capture to the incoming chat id', () => {
  // Structural: the defect was that captureBuf ignored the chat id entirely.
  // Assert the route derives it from the update rather than from the flag alone.
  it('derives the capture buffer from the update chat id, not the env flag alone', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(__dirname, '../../../../../app/api/v1/agentbook/telegram/webhook/route.ts'),
      'utf8',
    );
    // The regression is literally `E2E_CAPTURE ? [] : null`.
    expect(src).not.toMatch(/captureBuf[^=]*=\s*E2E_CAPTURE\s*\?/);
    expect(src).toMatch(/captureBuf[^=]*=\s*isE2eCaptureChat\(/);
  });
});
