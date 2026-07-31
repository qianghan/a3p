/**
 * The Telegram webhook must fail CLOSED.
 *
 * The gate was `if (expectedSecret && secret !== expectedSecret) reject` — so an
 * unset TELEGRAM_WEBHOOK_SECRET skipped the check entirely rather than refusing.
 * It was unset in production, and an anonymous POST to the live endpoint
 * returned 200. With a chat id that maps to a real tenant, an anonymous caller
 * could drive that tenant's agent and write to their books.
 *
 * Structural assertions: instantiating the real route here would need grammy, a
 * bot token and a database, none of which say anything about the gate. What
 * matters is the shape of the condition, and that is exactly what regressed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = join(
  __dirname,
  '../../../../../app/api/v1/agentbook/telegram/webhook/route.ts',
);
const src = readFileSync(ROUTE, 'utf8');

describe('telegram webhook auth gate', () => {
  it('refuses every update when the secret is not configured', () => {
    // The absence of a secret must produce a rejection, not a bypass.
    expect(src).toMatch(/if \(!expectedSecret\)[\s\S]{0,400}?status: 503/);
  });

  it('does not reinstate the fail-open condition', () => {
    // The exact regression: gating the comparison on the secret EXISTING, so
    // that not having one means never checking.
    expect(src).not.toMatch(/if \(expectedSecret && secret !== expectedSecret/);
  });

  it('still rejects a wrong secret', () => {
    expect(src).toMatch(/secret !== expectedSecret[\s\S]{0,200}?status: 401/);
  });

  it('logs the misconfiguration loudly rather than failing silently', () => {
    // A 503 with no explanation is its own kind of dead end at 3am.
    expect(src).toMatch(/console\.error\([\s\S]{0,200}?TELEGRAM_WEBHOOK_SECRET is not set/);
  });
});
