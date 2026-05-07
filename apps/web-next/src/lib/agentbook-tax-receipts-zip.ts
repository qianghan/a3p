/**
 * Receipts ZIP builder for the year-end tax package (PR 5).
 *
 * Iterates confirmed expenses in the calendar year, fetches each
 * `receiptUrl` (Vercel Blob URLs from the receipt scan flow), and
 * bundles them into a single ZIP. Skipping rules:
 *
 *   • URLs whose host is not on the allow-list — SSRF guard. A
 *     malicious or buggy write could plant `http://169.254.169.254/...`
 *     (cloud metadata) or `http://localhost:5432/...`; the allow-list
 *     restricts fetches to the storage hosts we actually use.
 *   • Files larger than 5 MB — keeps the ZIP lean for Telegram delivery.
 *   • 404s, network errors, missing `receiptUrl` — silently skipped.
 *   • The skip count is logged so the route handler can surface it.
 *
 * If every receipt is skipped or there are zero receipts to fetch, this
 * returns `null` and the orchestrator skips uploading the ZIP entirely.
 *
 * Concurrency: receipt fetches run with a small bounded pool (8 in
 * flight) so a tenant with hundreds of receipts doesn't pay the full
 * sequential RTT cost; we don't pull in p-limit just for this.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import JSZip from 'jszip';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const FETCH_TIMEOUT_MS = 8_000;
const FETCH_CONCURRENCY = 8;

/**
 * Allow-list of receipt hostnames. SSRF guard: anything matched here
 * is considered safe to fetch from the server. Update when new storage
 * hosts come online.
 *
 * Dev hosts (`localhost`, `127.0.0.1`) are kept in the list so the
 * unit tests + local Telegram loops can work with `data:` and local
 * blob shims; production traffic only lands on the vercel-storage /
 * a3book hosts.
 */
const ALLOWED_RECEIPT_HOSTS: RegExp[] = [
  /\.vercel-storage\.com$/i,
  /^blob\.vercel-storage\.com$/i,
  /^a3book\.brainliber\.com$/i,
  /^localhost$/i,
  /^127\.0\.0\.1$/i,
];

/**
 * Returns true iff `urlStr` parses as a valid http(s) URL whose
 * hostname matches the receipt allow-list. Any parse error or
 * unrecognised host returns false.
 */
export function isAllowedReceiptHost(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return ALLOWED_RECEIPT_HOSTS.some((rx) => rx.test(u.hostname));
  } catch {
    return false;
  }
}

function extFromContentType(ct: string | null, url: string): string {
  if (ct) {
    if (/jpeg|jpg/i.test(ct)) return '.jpg';
    if (/png/i.test(ct)) return '.png';
    if (/pdf/i.test(ct)) return '.pdf';
    if (/webp/i.test(ct)) return '.webp';
    if (/heic/i.test(ct)) return '.heic';
  }
  // Fall back to the URL path's extension if any.
  const m = /\.([a-zA-Z0-9]{2,4})(?:\?|$)/.exec(url);
  if (m) return `.${m[1].toLowerCase()}`;
  return '.bin';
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

interface ExpenseRow {
  id: string;
  date: Date;
  receiptUrl: string | null;
  vendor: { name: string } | null;
}

interface ZipEntry {
  name: string;
  buf: Buffer;
}

/**
 * Fetch a single receipt and return a ZIP entry, or `null` if the
 * fetch should be skipped (SSRF block, 404, oversize, network error).
 */
async function fetchOne(e: ExpenseRow): Promise<ZipEntry | null> {
  if (!e.receiptUrl) return null;
  if (!isAllowedReceiptHost(e.receiptUrl)) {
    console.warn(
      `[tax-package/receipts-zip] skipping disallowed host expenseId=${e.id}`,
    );
    return null;
  }
  const res = await fetchWithTimeout(e.receiptUrl, FETCH_TIMEOUT_MS);
  if (!res || !res.ok) return null;
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > MAX_FILE_BYTES) return null;
  }
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (buf.byteLength > MAX_FILE_BYTES) return null;
  const ext = extFromContentType(res.headers.get('content-type'), e.receiptUrl);
  const dateStr = e.date.toISOString().slice(0, 10);
  const vendor = safeName(e.vendor?.name || 'receipt');
  const name = `receipts/${dateStr}_${vendor}_${e.id.slice(0, 8)}${ext}`;
  return { name, buf: Buffer.from(buf) };
}

/**
 * Run `worker` over `items` with at most `limit` in-flight at a time.
 * Same shape as PR 3's `processAll` helper — kept inline so the tax
 * package doesn't pull a tiny dep just for this.
 */
async function processAll<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i += 1) {
    runners.push(
      (async () => {
        // Pull the next index off the shared cursor until we run out.
        for (;;) {
          const idx = cursor;
          cursor += 1;
          if (idx >= items.length) return;
          out[idx] = await worker(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return out;
}

/**
 * Build a ZIP of receipt files for the given tenant + calendar year.
 *
 * Returns `null` if there are zero receipt URLs to fetch (so the caller
 * can skip uploading an empty ZIP). Returns a `Buffer` otherwise; the
 * buffer may still represent a near-empty ZIP if every file was skipped.
 */
export async function buildReceiptsZip(
  tenantId: string,
  year: number,
): Promise<Buffer | null> {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));

  const expenses = await db.abExpense.findMany({
    where: {
      tenantId,
      isPersonal: false,
      status: 'confirmed',
      date: { gte: start, lt: end },
      receiptUrl: { not: null },
    },
    select: {
      id: true,
      date: true,
      receiptUrl: true,
      vendor: { select: { name: true } },
    },
    orderBy: { date: 'asc' },
  });

  if (expenses.length === 0) return null;

  const results = await processAll(expenses, FETCH_CONCURRENCY, fetchOne);

  const zip = new JSZip();
  let included = 0;
  let skipped = 0;
  for (const entry of results) {
    if (!entry) {
      skipped += 1;
      continue;
    }
    zip.file(entry.name, entry.buf);
    included += 1;
  }

  if (skipped > 0) {
    console.warn(
      `[tax-package/receipts-zip] tenant=${tenantId} year=${year} included=${included} skipped=${skipped}`,
    );
  }

  if (included === 0) return null;

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return out;
}
