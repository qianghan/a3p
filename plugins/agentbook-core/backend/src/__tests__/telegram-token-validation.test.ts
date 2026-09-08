import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `/telegram/setup` accepted any string containing a colon, then interpolated
 * it into two api.telegram.org URLs and stored it for later reuse. CodeQL
 * flagged both fetches as `js/request-forgery` (critical).
 *
 * The host is a literal, so the destination cannot be moved off Telegram — but
 * the PATH was caller-controlled, and a token carrying a slash, query, fragment
 * or newline reshapes the request and is then persisted and reused. Pinning
 * the token's real shape removes the class.
 *
 * The pattern is read out of the source rather than imported, because
 * importing server.ts boots an Express app and a Prisma client.
 */
const SRC = readFileSync(
  join(__dirname, '..', 'server.ts'), 'utf8',
);

const TOKEN_RE = (() => {
  const m = SRC.match(/const TELEGRAM_BOT_TOKEN_RE = (\/.+\/);/);
  if (!m) throw new Error('TELEGRAM_BOT_TOKEN_RE not found in server.ts');
  // eslint-disable-next-line no-eval
  return eval(m[1]) as RegExp;
})();

describe('telegram bot token shape', () => {
  it('accepts a realistic token', () => {
    expect(TOKEN_RE.test('8369700716:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A')).toBe(true);
  });

  it.each([
    ['1:x', 'too short'],
    ['abc:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A', 'non-numeric bot id'],
    ['8369700716AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A', 'no colon'],
    ['8369700716:AAHu/../../getUpdates', 'path traversal in the secret'],
    ['8369700716:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A/sendMessage', 'appended path'],
    ['8369700716:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A?x=1', 'appended query'],
    ['8369700716:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A#f', 'appended fragment'],
    ['8369700716:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A ', 'trailing space'],
    ['8369700716:AAHuBcZ6kJUlzlDyHNm10K7bKyXligfT06A\nX', 'embedded newline'],
    [':', 'the old check’s minimum — a bare colon passed `includes(":")`'],
  ])('rejects %s (%s)', (token) => {
    expect(TOKEN_RE.test(token)).toBe(false);
  });

  it('is anchored at both ends', () => {
    // Unanchored, every "appended path" case above would pass.
    expect(TOKEN_RE.source.startsWith('^')).toBe(true);
    expect(TOKEN_RE.source.endsWith('$')).toBe(true);
  });

  it('the setup route actually uses it', () => {
    expect(SRC).toMatch(/TELEGRAM_BOT_TOKEN_RE\.test\(botToken\)/);
    // The old check must be gone, not merely supplemented.
    expect(SRC).not.toMatch(/botToken\.includes\(':'\)/);
  });
});
