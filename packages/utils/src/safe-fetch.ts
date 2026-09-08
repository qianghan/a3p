/**
 * Server-side fetches of a URL that came from a request.
 *
 * A route that fetches a caller-supplied URL is an SSRF primitive: the
 * attacker picks the destination and the server has the network position.
 * When the response body is then republished — receipts are stored on a
 * *public* Vercel Blob — it is also an exfiltration primitive, because an
 * internal response comes back out at a URL anyone can read.
 *
 * WHY THIS LIVES IN A SHARED PACKAGE
 * It began in apps/web-next, which fixed the Next route and left the Express
 * plugin backends fetching caller-supplied URLs unguarded — CodeQL flagged
 * both as critical `js/request-forgery`. A plugin backend cannot import from
 * the Next app, so the choice was to duplicate the guard or to share it.
 * Duplicating a security control is how the two copies end up disagreeing,
 * and this repo has already been bitten by exactly that (a filing exporter
 * kept its own copy of form line numbers and drifted into emitting $0.00).
 *
 * The guard is an allow-list rather than a private-range deny-list. The
 * legitimate sources are a short, known set of storage hosts, so listing them
 * is both stricter and simpler than trying to enumerate everything internal.
 * `isPrivateHost` is composed on top as a second check, so a future
 * allow-list entry that resolves somewhere internal is still refused.
 *
 * Deliberately free of Prisma, `jszip` and `server-only` imports so a route
 * handler can pull in the guard without those in its bundle.
 */

import { isPrivateHost } from './security.js';

/**
 * Where receipts legitimately live. `put()` returns a
 * `<store>.public.blob.vercel-storage.com` URL; the bare `blob.` host and the
 * app's own domains cover the older rows.
 */
const RECEIPT_HOSTS: RegExp[] = [
  /^blob\.vercel-storage\.com$/i,
  /\.vercel-storage\.com$/i,
  /^a3book\.brainliber\.com$/i,
  /^agentbook\.brainliber\.com$/i,
];

/**
 * Local blob shims, for `npm run dev` and the local Telegram loop. Never
 * accepted in production — read at call time, not module load, so a test can
 * flip it.
 */
const DEV_ONLY_HOSTS: RegExp[] = [/^localhost$/i, /^127\.0\.0\.1$/i];

function devHostsAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * True iff `urlStr` is an https URL on a host receipts are stored on.
 *
 * https only: an `http://` fetch of a receipt would put the URL — and for
 * Telegram-derived URLs, the bot token inside it — on the wire in clear.
 * `http://localhost` stays acceptable outside production for the dev shims.
 */
export function isAllowedReceiptUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }

  const isDevHost = DEV_ONLY_HOSTS.some((rx) => rx.test(u.hostname));

  if (u.protocol === 'http:') {
    if (!isDevHost || !devHostsAllowed()) return false;
    return true;
  }
  if (u.protocol !== 'https:') return false;

  if (isDevHost) return devHostsAllowed();
  if (isPrivateHost(u.hostname)) return false;
  return RECEIPT_HOSTS.some((rx) => rx.test(u.hostname));
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  /** Reject a response whose declared or actual size exceeds this. */
  maxBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;
/** Telegram's getFile ceiling, and comfortably above any real receipt. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Fetch a receipt URL that came from a request, or return null.
 *
 * `redirect: 'error'` matters as much as the allow-list: `fetch` follows up
 * to 20 redirects by default, so without it an allow-listed host could bounce
 * the request to anywhere and the host check would have decided nothing. No
 * legitimate receipt source redirects, so refusing is better than
 * re-validating each hop, which would just add more surface to get wrong.
 *
 * Returns the buffered bytes rather than the stream, because a size cap
 * cannot be enforced on a body that is piped straight through, and
 * `content-length` on its own is a claim the origin makes.
 */
export async function fetchReceipt(
  urlStr: string,
  opts: SafeFetchOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!isAllowedReceiptUrl(urlStr)) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(urlStr, { signal: ctl.signal, redirect: 'error' });
    if (!res.ok) return null;

    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) return null;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;

    return {
      bytes: buf,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
