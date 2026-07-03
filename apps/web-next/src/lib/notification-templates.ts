/**
 * Pre-written starting points for the admin notification composer
 * (apps/web-next/src/app/(dashboard)/admin/notifications/page.tsx). One or
 * two per composable category — admin picks a card, it fills the compose
 * form, they edit the bracketed placeholders before sending. Not meant to be
 * sent verbatim; the bracket copy is there specifically to be replaced.
 *
 * Only covers the categories the composer actually lets an admin choose
 * (feature, reward, admin_broadcast) — tax_deadline/invoice_due/
 * expense_review/referral_thanks are system-triggered and intentionally not
 * composable here (see COMPLIANCE_LOCKED_CATEGORIES in notifications.ts).
 */

export type TemplateSeverity = 'info' | 'success' | 'warning' | 'urgent';

export interface NotificationTemplate {
  id: string;
  name: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  severity: TemplateSeverity;
}

export const NOTIFICATION_TEMPLATES: Record<'feature' | 'reward' | 'admin_broadcast', NotificationTemplate[]> = {
  feature: [
    {
      id: 'feature-launch',
      name: 'New feature launch',
      title: 'New: [feature name] is live',
      body: "We just shipped [feature name] — [one-line benefit, e.g. \"turns a photo of any receipt into a categorized expense in seconds\"]. It's available now, no setup required.",
      ctaLabel: 'Try it now',
      ctaUrl: '/agentbook',
      severity: 'info',
    },
    {
      id: 'feature-improvement',
      name: 'Quality / reliability improvement',
      title: 'We made [area] faster and more accurate',
      body: "Based on your feedback, we improved [area — e.g. receipt scanning accuracy, tax estimate calculations]. You don't need to do anything — it's already live on your account.",
      ctaLabel: 'See what changed',
      ctaUrl: '/agentbook',
      severity: 'success',
    },
  ],
  reward: [
    {
      id: 'reward-discount',
      name: 'Limited-time discount',
      title: 'A thank-you from the AgentBook team — [X]% off',
      body: "As one of our valued users, enjoy [X]% off your next [N] month(s) — already applied to your account, no code needed.",
      ctaLabel: 'View my plan',
      ctaUrl: '/settings?tab=agentbook&subtab=billing',
      severity: 'success',
    },
    {
      id: 'reward-credit',
      name: 'Account credit / loyalty reward',
      title: "You've earned a reward",
      body: "We've credited [reward — e.g. \"1 free month\"] to your account as a thank-you for [reason — e.g. being an early user, your feedback]. It'll apply automatically on your next bill.",
      ctaLabel: 'View my account',
      ctaUrl: '/settings?tab=agentbook&subtab=billing',
      severity: 'success',
    },
  ],
  admin_broadcast: [
    {
      id: 'broadcast-maintenance',
      name: 'Scheduled maintenance heads-up',
      title: 'Scheduled maintenance: [date], [start]–[end] [timezone]',
      body: 'AgentBook may be briefly unavailable during this window while we perform scheduled maintenance. Your data is safe — no action needed on your end.',
      severity: 'warning',
    },
    {
      id: 'broadcast-general',
      name: 'General announcement',
      title: '[Headline]',
      body: '[Message body — use this for updates that don’t fit "feature" or "reward," like policy changes, support hours, or company news.]',
      ctaLabel: 'Learn more',
      severity: 'info',
    },
  ],
};

export function getTemplatesFor(category: string): NotificationTemplate[] {
  if (category === 'feature' || category === 'reward' || category === 'admin_broadcast') {
    return NOTIFICATION_TEMPLATES[category];
  }
  return [];
}
