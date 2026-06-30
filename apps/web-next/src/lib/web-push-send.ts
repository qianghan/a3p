/**
 * Guarded Web Push sender. No-ops unless VAPID keys are configured, so the
 * proactive-alerts cron stays safe even before push is set up in prod.
 * Returns 'sent' | 'skipped' | 'gone' (subscription expired → caller should clear).
 */

import 'server-only';
import { buildPushPayload } from '@/lib/push-payload';

let configured = false;
let webpushMod: typeof import('web-push') | null = null;

async function getWebPush(): Promise<typeof import('web-push') | null> {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  if (!webpushMod) {
    webpushMod = await import('web-push');
    webpushMod.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@brainliber.com', pub, priv);
    configured = true;
  }
  return configured ? webpushMod : null;
}

export async function sendPush(
  subscription: unknown,
  alert: { title: string; body: string; url?: string },
): Promise<'sent' | 'skipped' | 'gone'> {
  const wp = await getWebPush();
  if (!wp || !subscription || typeof subscription !== 'object') return 'skipped';
  try {
    await wp.sendNotification(subscription as import('web-push').PushSubscription, buildPushPayload(alert));
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return 'gone';
    console.warn('[web-push] send failed:', err);
    return 'skipped';
  }
}
