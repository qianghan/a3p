/**
 * Email sending via Resend
 * Used for verification and password reset emails.
 */

import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM =
  process.env.EMAIL_FROM || 'AgentBook <onboarding@resend.dev>';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

let _resendClient: Resend | null | undefined;
function getResendClient(): Resend | null {
  if (_resendClient !== undefined) return _resendClient;
  _resendClient = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
  return _resendClient;
}

/**
 * Validate email configuration at startup.
 * Logs warnings for missing or sandbox-only config in production.
 */
export function validateEmailConfig(): { configured: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const isProduction = process.env.NODE_ENV === 'production';

  if (!RESEND_API_KEY) {
    const msg = '[EMAIL] RESEND_API_KEY is not set — email sending is disabled';
    warnings.push(msg);
    if (isProduction) console.error(msg);
  }

  if (EMAIL_FROM.includes('@resend.dev')) {
    const msg =
      '[EMAIL] EMAIL_FROM uses sandbox domain (resend.dev). ' +
      'In production, set EMAIL_FROM to an address on a verified custom domain.';
    warnings.push(msg);
    if (isProduction) console.warn(msg);
  }

  return { configured: !!RESEND_API_KEY && !EMAIL_FROM.includes('@resend.dev'), warnings };
}

// Run validation on module load (logs once per cold start)
if (typeof process !== 'undefined') {
  validateEmailConfig();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shared branded email scaffold — teal AgentBook header, single CTA, footer.
 * Keeps every transactional email visually consistent and on-brand. All
 * dynamic HTML passed in (`intro`, `extraHtml`) must already be escaped/trusted.
 *
 * QA-P5-007: link text uses #0c6e57 (the darker end of the header gradient),
 * not the brand's primary #149578 — #149578 is only 3.75:1 against white,
 * failing WCAG AA for normal-size text. #0c6e57 clears ~6.4:1.
 */
function buildBrandedEmail(params: {
  title: string;
  preheader: string;
  heading: string;
  intro: string;
  ctaText: string;
  ctaUrl: string;
  extraHtml?: string;
  footnote: string;
}): string {
  const { title, preheader, heading, intro, ctaText, ctaUrl, extraHtml = '', footnote } = params;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f4f6f8;line-height:1.6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:14px;box-shadow:0 4px 16px rgba(10,35,27,0.08);overflow:hidden;">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#0c6e57 0%,#149578 55%,#1faf87 100%);padding:34px 40px;text-align:center;">
          <span style="font-size:22px;font-weight:700;letter-spacing:-0.4px;color:#ffffff;">agent<span style="color:#8ff0cf;">book</span></span>
          <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.85);">AI bookkeeping, automated</p>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:40px;">
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0a231b;">${heading}</h1>
          <div style="margin:0 0 22px;font-size:15px;color:#4b5563;">${intro}</div>
          ${extraHtml}
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px auto 0;"><tr>
            <td style="border-radius:9px;background:linear-gradient(135deg,#149578 0%,#1faf87 100%);box-shadow:0 2px 6px rgba(20,149,120,0.35);">
              <a href="${ctaUrl}" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${ctaText}</a>
            </td>
          </tr></table>
          <p style="margin:26px 0 0;font-size:13px;color:#6b7280;">${footnote}</p>
          <p style="margin:14px 0 0;font-size:12px;color:#9ca3af;">If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${ctaUrl}" style="color:#0c6e57;word-break:break-all;">${ctaUrl}</a></p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:22px 40px;background:#f9fafb;border-top:1px solid #eef0f2;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;color:#6b7280;"><a href="${APP_URL}" style="color:#0c6e57;text-decoration:none;font-weight:600;">AgentBook</a> &middot; AI bookkeeping for freelancers &amp; small business</p>
          <p style="margin:0;font-size:11px;color:#b0b7c0;"><a href="${APP_URL}/docs" style="color:#9ca3af;text-decoration:none;">Help center</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * AgentBook welcome + email-verification template
 */
function buildVerificationEmailHtml(params: {
  verifyUrl: string;
  displayName?: string;
}): string {
  const { verifyUrl, displayName } = params;
  const safeName = displayName ? escapeHtml(displayName) : '';
  const greeting = safeName ? `Hi ${safeName},` : 'Hi there,';

  return buildBrandedEmail({
    title: 'Welcome to AgentBook — verify your email',
    preheader: 'Confirm your email to activate your AgentBook account.',
    heading: 'Welcome to AgentBook 👋',
    intro: `<p style="margin:0 0 14px;">${greeting}</p>
      <p style="margin:0;">Thanks for signing up. AgentBook is your AI bookkeeper — snap a receipt, connect your bank, and just ask for the numbers. Confirm your email to activate your account:</p>`,
    extraHtml: `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px;"><tr><td style="font-size:14px;color:#4b5563;">
        <div style="margin:3px 0;">📸&nbsp;&nbsp;Snap a photo of any receipt — we categorize it</div>
        <div style="margin:3px 0;">🏦&nbsp;&nbsp;Connect your bank for automatic expense tracking</div>
        <div style="margin:3px 0;">💬&nbsp;&nbsp;Ask "how much did I spend on travel?" in plain English</div>
      </td></tr></table>`,
    ctaText: 'Verify email address',
    ctaUrl: verifyUrl,
    footnote: "This link expires in 24 hours. If you didn't create an AgentBook account, you can safely ignore this email.",
  });
}

/**
 * AgentBook password-reset template
 */
function buildPasswordResetEmailHtml(params: { resetUrl: string }): string {
  const { resetUrl } = params;

  return buildBrandedEmail({
    title: 'Reset your AgentBook password',
    preheader: 'Choose a new password for your AgentBook account.',
    heading: 'Reset your password',
    intro: `<p style="margin:0 0 14px;">Hi there,</p>
      <p style="margin:0;">We received a request to reset the password for your AgentBook account. Click below to choose a new one:</p>`,
    ctaText: 'Choose a new password',
    ctaUrl: resetUrl,
    footnote: "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password won't change.",
  });
}

/**
 * Send verification email (registration)
 */
export async function sendVerificationEmail(
  to: string,
  verifyUrl: string,
  displayName?: string
): Promise<{ success: boolean; error?: string }> {
  const client = getResendClient();

  if (!client) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[EMAIL] RESEND_API_KEY is not configured — verification email not sent');
    } else {
      console.log('[EMAIL] (no RESEND_API_KEY) Verification URL:', verifyUrl);
    }
    return { success: false, error: 'Email service not configured' };
  }

  const html = buildVerificationEmailHtml({ verifyUrl, displayName });

  try {
    await client.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Verify your email — welcome to AgentBook',
      html,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[EMAIL] Failed to send verification:', message);
    return { success: false, error: message };
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string
): Promise<{ success: boolean; error?: string }> {
  const client = getResendClient();

  if (!client) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[EMAIL] RESEND_API_KEY is not configured — password reset email not sent');
    } else {
      console.log('[EMAIL] (no RESEND_API_KEY) Reset URL:', resetUrl);
    }
    return { success: false, error: 'Email service not configured' };
  }

  const html = buildPasswordResetEmailHtml({ resetUrl });

  try {
    await client.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Reset your AgentBook password',
      html,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[EMAIL] Failed to send password reset:', message);
    return { success: false, error: message };
  }
}

/**
 * Send a generic transactional email. Used by the EmailAdapter
 * (`agentbook-chat-adapter.ts`) so the agent can deliver messages to a
 * tenant by email when Telegram isn't connected. The text is wrapped in a
 * minimal HTML scaffold so it renders consistently across mail clients.
 *
 * Returns `{ success, messageId?, error? }`. Never throws.
 */
export async function sendAgentMessageEmail(
  to: string,
  subject: string,
  text: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const client = getResendClient();
  if (!client) {
    return { success: false, error: 'Email service not configured' };
  }

  const safeText = escapeHtml(text);
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;max-width:600px;margin:0 auto;padding:24px;">
  <h2 style="font-size:18px;margin:0 0 16px;color:#111;">${escapeHtml(subject)}</h2>
  <div style="white-space:pre-wrap;font-size:14px;">${safeText}</div>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
  <p style="font-size:12px;color:#6b7280;margin:0;">Sent by AgentBook. To stop these messages, update your delivery preferences in Settings.</p>
</body></html>`;

  try {
    const result = await client.emails.send({ from: EMAIL_FROM, to, subject, html });
    return { success: true, messageId: (result as unknown as { data?: { id?: string } })?.data?.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Invite an accountant to a tenant's books. Best-effort: returns
 * `{ success, messageId?, error? }` and never throws, so the caller can still
 * create the invite (and surface the manual link) if delivery fails — e.g.
 * until a sending domain is verified in Resend.
 */
export async function sendCpaInviteEmail(
  to: string,
  inviteUrl: string,
  inviterName?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const client = getResendClient();
  if (!client) {
    if (process.env.NODE_ENV !== 'production') console.log('[EMAIL] (no RESEND_API_KEY) CPA invite URL:', inviteUrl);
    return { success: false, error: 'Email service not configured' };
  }

  const from = inviterName ? `${escapeHtml(inviterName)} (via AgentBook)` : 'AgentBook';
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>You're invited to review the books on AgentBook</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f4f6f8;line-height:1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;padding:40px 20px;"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);overflow:hidden;">
      <tr><td style="background:linear-gradient(135deg,#0c6e57 0%,#149578 100%);padding:32px 40px;text-align:center;">
        <h1 style="margin:0;font-size:24px;font-weight:600;color:#ffffff;letter-spacing:-0.5px;">AgentBook</h1>
        <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">AI bookkeeping, automated</p>
      </td></tr>
      <tr><td style="padding:40px;">
        <p style="margin:0 0 16px;font-size:16px;color:#1f2937;">Hi there,</p>
        <p style="margin:0 0 24px;font-size:16px;color:#4b5563;">
          ${from} has invited you to review their books on AgentBook. Use the secure link below to open the accountant portal — no account needed.
        </p>
        <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto;"><tr>
          <td style="border-radius:8px;background:linear-gradient(135deg,#149578 0%,#1faf87 100%);">
            <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">Open the accountant portal</a>
          </td>
        </tr></table>
        <p style="margin:24px 0 0;font-size:14px;color:#6b7280;">This invitation link will expire. If you weren't expecting it, you can ignore this email.</p>
        <p style="margin:16px 0 0;font-size:13px;color:#9ca3af;">If the button doesn't work, copy and paste this link:<br>
          <a href="${inviteUrl}" style="color:#0c6e57;word-break:break-all;">${inviteUrl}</a></p>
      </td></tr>
      <tr><td style="padding:24px 40px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
        <p style="margin:0;font-size:12px;color:#9ca3af;"><a href="${APP_URL}" style="color:#0c6e57;text-decoration:none;">AgentBook</a></p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  try {
    const result = await client.emails.send({
      from: EMAIL_FROM,
      to,
      subject: inviterName ? `${inviterName} invited you to review their books on AgentBook` : "You're invited to review the books on AgentBook",
      html,
    });
    return { success: true, messageId: (result as unknown as { data?: { id?: string } })?.data?.id };
  } catch (err) {
    console.error('[EMAIL] Failed to send CPA invite:', err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Notification-center email — admin broadcasts and system-triggered
 * notifications (referral thank-you, tax deadline, etc.) all render through
 * this one function so the email always matches the in-app card. Uses the
 * same branded scaffold as verification/password-reset, not a separate
 * template. Title/body are user- or admin-composed text, so both are
 * escaped before going into the trusted `buildBrandedEmail` slots.
 */
export async function sendNotificationEmail(
  to: string,
  params: { title: string; body: string; ctaLabel?: string; ctaUrl?: string },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const client = getResendClient();
  if (!client) {
    if (process.env.NODE_ENV !== 'production') console.log('[EMAIL] (no RESEND_API_KEY) Notification:', params.title);
    return { success: false, error: 'Email service not configured' };
  }

  const html = buildBrandedEmail({
    title: params.title,
    preheader: params.body.slice(0, 140),
    heading: escapeHtml(params.title),
    intro: escapeHtml(params.body),
    ctaText: params.ctaLabel || 'Open AgentBook',
    ctaUrl: params.ctaUrl || APP_URL,
    footnote: 'You can manage which notifications you receive in Settings → Notifications.',
  });

  try {
    const result = await client.emails.send({ from: EMAIL_FROM, to, subject: params.title, html });
    return { success: true, messageId: (result as unknown as { data?: { id?: string } })?.data?.id };
  } catch (err) {
    console.error('[EMAIL] Failed to send notification email:', err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
