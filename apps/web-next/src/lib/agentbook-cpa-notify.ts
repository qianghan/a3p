/**
 * PR 11 — Telegram nudge for CPA-filed accountant requests.
 *
 * Sent on AbAccountantRequest creation. The owner gets:
 *   📒 "Your CPA jane@cpa.test needs your eyes:
 *      'Need receipt for AWS October bill.'
 *      [👀 Resolve]"
 *
 * The Resolve callback (`cpa_resolve:<requestId>`) lives in the
 * Telegram webhook handler and prompts the owner for a free-form
 * resolution note (or kicks off a receipt-upload flow). Best-effort:
 * any failure here logs and returns false, so the underlying request
 * row is still created.
 */

import 'server-only';
import { sendToAllChannels } from './agentbook-chat-adapter';
import { reportError } from './logger';

export interface CpaRequestNudge {
  requestId: string;
  cpaEmail: string;
  message: string;
  entityType: string;
  entityId: string | null;
}

function formatEntityHint(entityType: string, entityId: string | null): string {
  if (!entityId || entityType === 'general') return '';
  const label =
    entityType === 'AbExpense' ? 'expense'
    : entityType === 'AbInvoice' ? 'invoice'
    : entityType === 'AbMileageEntry' ? 'mileage entry'
    : entityType.toLowerCase();
  return ` (about a specific ${label})`;
}

/**
 * Notify the tenant that their CPA needs a response. PR 40 (Tier 5 #17):
 * delivery routes through the ChatAdapter so every configured channel
 * (Telegram + Web + Email) gets the nudge, not just Telegram. The Resolve /
 * Skip buttons survive on Telegram via the adapter's `buttons` option; on
 * Web the buttons become quick-reply chips emitted into the AbEvent; on
 * Email the text-only message includes a deep link to the resolve page.
 */
export async function sendCpaRequestNudge(
  tenantId: string,
  payload: CpaRequestNudge,
): Promise<boolean> {
  try {
    const hint = formatEntityHint(payload.entityType, payload.entityId);
    const text =
      `📒 Your CPA *${payload.cpaEmail}* needs your eyes${hint}:\n` +
      `_"${payload.message.slice(0, 500)}"_\n` +
      `Tap Resolve to handle it.`;

    const results = await sendToAllChannels(tenantId, text, {
      buttons: [[
        { text: '👀 Resolve', callbackData: `cpa_resolve:${payload.requestId}` },
        { text: '⏭ Skip for now', callbackData: `cpa_skip:${payload.requestId}` },
      ]],
      idempotencyKey: `cpa-nudge:${payload.requestId}`,
    });
    return results.some((r) => r.delivered);
  } catch (err) {
    void reportError('cpa-notify failed', err, { tenantId, source: 'agentbook-cpa-notify' });
    return false;
  }
}
