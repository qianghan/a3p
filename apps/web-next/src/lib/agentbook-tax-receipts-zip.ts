/**
 * Receipts ZIP builder for the year-end tax package (PR 5).
 *
 * Iterates confirmed expenses in the calendar year, fetches each
 * `receiptUrl` (Vercel Blob URLs from the receipt scan flow), and
 * bundles them into a single ZIP. Skipping rules:
 *
 *   • Files larger than 5 MB — keeps the ZIP lean for Telegram delivery.
 *   • 404s, network errors, missing `receiptUrl` — silently skipped.
 *   • The skip count is logged so the route handler can surface it.
 *
 * If every receipt is skipped or there are zero receipts to fetch, this
 * returns `null` and the orchestrator skips uploading the ZIP entirely.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import JSZip from 'jszip';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const FETCH_TIMEOUT_MS = 8_000;

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

  const zip = new JSZip();
  let included = 0;
  let skipped = 0;

  for (const e of expenses) {
    if (!e.receiptUrl) {
      skipped += 1;
      continue;
    }
    const res = await fetchWithTimeout(e.receiptUrl, FETCH_TIMEOUT_MS);
    if (!res || !res.ok) {
      skipped += 1;
      continue;
    }
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && parseInt(lenHeader, 10) > MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch {
      skipped += 1;
      continue;
    }
    if (buf.byteLength > MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    const ext = extFromContentType(res.headers.get('content-type'), e.receiptUrl);
    const dateStr = e.date.toISOString().slice(0, 10);
    const vendor = safeName(e.vendor?.name || 'receipt');
    const name = `receipts/${dateStr}_${vendor}_${e.id.slice(0, 8)}${ext}`;
    zip.file(name, Buffer.from(buf));
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
