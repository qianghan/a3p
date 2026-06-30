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
 * AgentBook verification email template
 */
function buildVerificationEmailHtml(params: {
  verifyUrl: string;
  displayName?: string;
}): string {
  const { verifyUrl, displayName } = params;
  const safeName = displayName ? escapeHtml(displayName) : '';
  const greeting = safeName ? `Hi ${safeName}` : 'Hi there';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your email - AgentBook</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f6f8; line-height: 1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #0a0f1a 0%, #1a2744 100%); padding: 32px 40px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff; letter-spacing: -0.5px;">AgentBook</h1>
              <p style="margin: 8px 0 0; font-size: 14px; color: rgba(255,255,255,0.8);">AI bookkeeping, automated</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 16px; font-size: 16px; color: #1f2937;">${greeting},</p>
              <p style="margin: 0 0 24px; font-size: 16px; color: #4b5563;">
                Welcome to AgentBook — AI-powered bookkeeping for freelancers and small businesses.
                Your books are about to get a lot easier.
              </p>
              <p style="margin: 0 0 24px; font-size: 16px; color: #4b5563;">
                Please verify your email address by clicking the button below:
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 8px; background: linear-gradient(135deg, #149578 0%, #1faf87 100%);">
                    <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">Verify Email Address</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0; font-size: 14px; color: #6b7280;">
                This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
              </p>
              <p style="margin: 16px 0 0; font-size: 13px; color: #9ca3af;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="${verifyUrl}" style="color: #149578; word-break: break-all;">${verifyUrl}</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                <a href="${APP_URL}" style="color: #149578; text-decoration: none;">AgentBook</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Password reset email template
 */
function buildPasswordResetEmailHtml(params: { resetUrl: string }): string {
  const { resetUrl } = params;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password - AgentBook</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f6f8; line-height: 1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #0a0f1a 0%, #1a2744 100%); padding: 32px 40px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">AgentBook</h1>
              <p style="margin: 8px 0 0; font-size: 14px; color: rgba(255,255,255,0.8);">AI bookkeeping, automated</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 16px; font-size: 16px; color: #1f2937;">Hi there,</p>
              <p style="margin: 0 0 24px; font-size: 16px; color: #4b5563;">
                We received a request to reset your AgentBook account password. 
                Click the button below to choose a new password:
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 8px; background: linear-gradient(135deg, #149578 0%, #1faf87 100%);">
                    <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">Reset Password</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0; font-size: 14px; color: #6b7280;">
                This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
              </p>
              <p style="margin: 16px 0 0; font-size: 13px; color: #9ca3af;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="${resetUrl}" style="color: #149578; word-break: break-all;">${resetUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 40px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                <a href="${APP_URL}" style="color: #149578; text-decoration: none;">AgentBook</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
          <a href="${inviteUrl}" style="color:#149578;word-break:break-all;">${inviteUrl}</a></p>
      </td></tr>
      <tr><td style="padding:24px 40px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
        <p style="margin:0;font-size:12px;color:#9ca3af;"><a href="${APP_URL}" style="color:#149578;text-decoration:none;">AgentBook</a></p>
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
