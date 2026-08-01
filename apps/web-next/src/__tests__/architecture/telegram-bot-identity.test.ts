import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Telegram wiring invariants — the outage of 31 July 2026.
 *
 * The bot went silent for a day. Nothing errored, nothing logged, and
 * `getWebhookInfo` looked healthy — because it had been asked about the wrong
 * bot. Two independent faults, both silent by construction:
 *
 *  1. @Agentbookdev_bot's webhook had been registered WITHOUT a secret_token.
 *     The moment TELEGRAM_WEBHOOK_SECRET was set on the deployment, every one
 *     of its updates began returning 401. Telegram recorded it faithfully
 *     ("Wrong response from the webhook: 401 Unauthorized") and retried
 *     forever. The status route already surfaced that exact string; nothing
 *     consumed it.
 *
 *  2. A DIFFERENT bot's webhook was pointed at this deployment. Its updates
 *     arrived, were resolved to a real tenant, answered correctly — and the
 *     reply was sent as whatever bot TELEGRAM_BOT_TOKEN holds, landing in a
 *     chat window nobody was looking at.
 *
 * And a third, latent: the self-serve setup route minted a per-tenant
 * webhookSecret with crypto.randomUUID(), registered it with Telegram, and
 * stored it — while the webhook only ever compared against the env var and
 * nothing read the stored value back. Every bot connected through the product
 * UI would have 401'd forever.
 *
 * The common shape is two values that must agree with nothing checking, which
 * is the same failure as the e2e password (#403) and the CRON_SECRET drift.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Comments stripped — a guard must match code, not prose about code. */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const SETUP = 'apps/web-next/src/app/api/v1/agentbook-core/telegram/setup/route.ts';
const STATUS = 'apps/web-next/src/app/api/v1/agentbook-core/telegram/status/route.ts';
const WEBHOOK = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';

describe('one webhook secret, the one the webhook validates', () => {
  it('setup does not mint its own secret', () => {
    // crypto.randomUUID() here produced a secret Telegram would present and
    // the server had never heard of — a permanent, silent 401.
    const code = readCode(SETUP);
    expect(code, 'setup must not generate a webhook secret').not.toMatch(
      /webhookSecret\s*=\s*crypto\.randomUUID/,
    );
  });

  it('setup registers the secret the webhook compares against', () => {
    const code = readCode(SETUP);
    expect(code).toMatch(/webhookSecret\s*=\s*process\.env\.TELEGRAM_WEBHOOK_SECRET/);
  });

  it('setup refuses rather than registering a bot that could never be heard', () => {
    // Silently connecting a bot that will 401 forever is worse than an error:
    // the UI says "connected!" and the user waits.
    const code = readCode(SETUP);
    expect(code).toMatch(/if\s*\(\s*!webhookSecret\s*\)/);
  });

  it('the webhook validates against the env secret', () => {
    expect(readCode(WEBHOOK)).toMatch(/process\.env\.TELEGRAM_WEBHOOK_SECRET/);
  });
});

describe('the outbound bot identity is observable', () => {
  const code = readCode(STATUS);

  it('status reports which bot THIS SERVER replies as', () => {
    // The half nobody could see. "Which bot is configured" and "which bot do
    // we reply as" are different questions, and only the first was answerable.
    expect(code).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(code).toMatch(/getMe/);
    // \b-anchored. `/repliesAs/` alone passes against `xrepliesAsx`, so
    // renaming the field away still satisfied it — the same unanchored
    // substring mistake as the month matcher and the CA$/A$ assertion, in a
    // guard written to catch that class. Caught only by mutation testing.
    expect(code).toMatch(/\brepliesAs\b\s*:/);
  });

  it('status flags an inbound/outbound bot mismatch', () => {
    expect(code).toMatch(/outbound\.username\s*!==\s*botConfig\.botUsername/);
  });

  it('status turns a 401 into an instruction, not just a string', () => {
    // Telegram had been reporting the cause verbatim for a day.
    expect(code).toMatch(/401\|unauthor/i);
    expect(code).toMatch(/secret_token/);
  });

  it('a repair action exists so recovery does not need a bot token on a shell', () => {
    // Hand-running curl with a live token is how the registration drifted, and
    // how the token ends up in a shell history.
    expect(code).toMatch(/export async function POST/);
    expect(code).toMatch(/setWebhook/);
  });

  it('repair refuses to register without a secret', () => {
    expect(code).toMatch(/if\s*\(\s*!secret\s*\)/);
  });
});

describe('the agent never shows a user raw JSON', () => {
  it('the terminal formatter fallback does not stringify the payload', () => {
    // Production answered "what should I focus on?" with the two characters
    // `[]` — an empty array fell through every branch into
    // JSON.stringify(data).slice(0, 300).
    const code = readCode('plugins/agentbook-core/backend/src/server.ts');
    expect(code, 'no raw JSON.stringify(data) as a user-facing message').not.toMatch(
      /message\s*=\s*JSON\.stringify\(data\)/,
    );
  });
});
