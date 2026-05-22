import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.INVOICE_PUBLIC_LINK_SECRET;

// Fail-closed: require the secret in any deployed environment (production,
// preview, staging). Only allow the dev fallback when running locally or in
// the test runner. Vercel sets VERCEL_ENV to 'production' | 'preview' |
// 'development'; we treat 'development' as local + only when NODE_ENV is not
// 'production'. This prevents the dev fallback from being silently used in
// internet-accessible preview / staging deployments.
const IS_TEST = process.env.NODE_ENV === 'test';
const IS_LOCAL_DEV =
  process.env.NODE_ENV !== 'production' &&
  (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'development');

if (!SECRET && !IS_TEST && !IS_LOCAL_DEV) {
  throw new Error(
    'INVOICE_PUBLIC_LINK_SECRET must be set in production, preview, and staging environments',
  );
}

const FALLBACK_SECRET = 'dev-only-rotate-in-prod';

function getSecret(): string {
  return SECRET || FALLBACK_SECRET;
}

/**
 * Sign a public-invoice link. Default expiry: 90 days.
 * Returns a compact token (exp.sig hex) suitable for `?t=` query param.
 */
export function signInvoiceLink(
  invoiceId: string,
  tenantId: string,
  expSeconds: number = 60 * 60 * 24 * 90
): string {
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const payload = `${invoiceId}.${tenantId}.${exp}`;
  const sig = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${exp}.${sig}`;
}

/**
 * Verify a public-invoice link token. Returns true iff signature valid AND not expired.
 */
export function verifyInvoiceLink(
  invoiceId: string,
  tenantId: string,
  token: string | undefined | null
): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return false;

  const payload = `${invoiceId}.${tenantId}.${exp}`;
  const expected = createHmac('sha256', getSecret()).update(payload).digest('hex');

  // Length-mismatched buffers throw — guard.
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Build the full public URL for an invoice, given the deployed base URL.
 * Example: buildPublicInvoiceUrl('https://app.example.com', invoiceId, tenantId)
 *   -> 'https://app.example.com/pay/<id>?t=<token>'
 *
 * Note: the customer-facing route is `/pay/{invoiceId}` (Next.js page), which
 * server-side fetches the backend `/api/v1/agentbook-invoice/invoices/{id}/public`
 * endpoint, forwarding the `t` query param. The token guards the backend route.
 */
export function buildPublicInvoiceUrl(
  baseUrl: string,
  invoiceId: string,
  tenantId: string
): string {
  const token = signInvoiceLink(invoiceId, tenantId);
  const trimmed = baseUrl.replace(/\/$/, '');
  return `${trimmed}/pay/${invoiceId}?t=${token}`;
}
