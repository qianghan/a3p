import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Since #561 the Telegram nightly capture chat (555555555) resolves to the
 * dedicated e2e tenant (see telegram-e2e-tenant.test.ts) instead of a real
 * persona tenant. That tenant has no BillSubscription row, so
 * canUseFeature(tenantId, 'telegram_bot') — the gate in
 * apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts — put it
 * on the Free tier, and the webhook answered EVERY synthetic message with
 * "the Telegram bot is a Pro feature", failing all of phase6/phase6b on that
 * string rather than on product behaviour.
 *
 * Source-reading rather than behavioural, matching telegram-e2e-tenant.test.ts:
 * this asserts BOTH halves stay true —
 *   1. scripts/seed-e2e-user.ts (which `POST /api/v1/e2e-test/reset-e2e-user`
 *      calls every nightly run) grants the e2e tenant a manual Pro
 *      subscription, so the fix doesn't get silently reverted, and
 *   2. the webhook still contains the real canUseFeature billing gate, so
 *      nobody "fixes" the red nightly by deleting the gate instead of
 *      seeding the entitlement — that gate is real product behaviour for
 *      every non-e2e tenant.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SEED_SCRIPT = readFileSync(join(ROOT, 'scripts/seed-e2e-user.ts'), 'utf8');
const WEBHOOK_ROUTE = readFileSync(
  join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'),
  'utf8',
);

describe('e2e tenant Pro subscription for the Telegram billing gate', () => {
  it('seed-e2e-user.ts upserts a BillSubscription for the e2e tenant on the pro plan', () => {
    expect(SEED_SCRIPT).toMatch(/billSubscription\.upsert/);
    expect(SEED_SCRIPT).toMatch(/accountId:\s*E2E_USER_ID|accountId,?\s*$/m);
    expect(SEED_SCRIPT).toMatch(/code:\s*'pro'/);

    // The upsert call itself must be reachable from resetE2eUser (the
    // exported function the reset route calls), not just present somewhere
    // in the file.
    const resetFn = SEED_SCRIPT.slice(
      SEED_SCRIPT.indexOf('export async function resetE2eUser('),
      SEED_SCRIPT.indexOf('\nexport interface RegionalTenant'),
    );
    expect(resetFn).toMatch(/ensureE2eProSubscription\(E2E_USER_ID\)/);
  });

  it('does not remove the real Telegram billing gate from the webhook', () => {
    expect(WEBHOOK_ROUTE).toMatch(/canUseFeature\(tenantId,\s*'telegram_bot'\)/);
  });
});
