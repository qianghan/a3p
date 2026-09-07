/**
 * Receipts upload-blob — copy a receipt that already lives on one of our
 * storage hosts into permanent Vercel Blob storage, and point the expense's
 * `receiptUrl` at the copy.
 *
 * `sourceUrl` comes from the request body, so this route used to be an SSRF
 * primitive with an exfiltration path attached: it fetched whatever URL the
 * caller named and streamed the response into a blob created with
 * `access: 'public'`. An internal endpoint's response came back out at a URL
 * anyone could read. It is now restricted to the hosts receipts actually live
 * on — see `isAllowedReceiptUrl` — which no legitimate caller falls outside
 * of, because nothing in production posts a `sourceUrl` here at all: the web
 * capture flow uploads multipart to `receipts/scan`, and the Telegram webhook
 * rehosts inline via its own helper. The docstring that used to describe this
 * as taking "a (possibly Telegram-temporary) URL" was stale.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { fetchReceipt, isAllowedReceiptUrl } from '@/lib/agentbook-safe-fetch';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface UploadBody {
  sourceUrl?: string;
  expenseId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as UploadBody;
    const { sourceUrl, expenseId } = body;

    if (!sourceUrl) {
      return NextResponse.json({ success: false, error: 'sourceUrl is required' }, { status: 400 });
    }

    // Refuse before touching the database. Previously a rejected or failed
    // fetch still fell through and wrote the caller's own `sourceUrl` into
    // `receiptUrl`, which let a caller plant an arbitrary URL on an expense
    // even when nothing was ever downloaded.
    if (!isAllowedReceiptUrl(sourceUrl)) {
      return NextResponse.json(
        { success: false, error: 'sourceUrl host is not an allowed receipt storage host' },
        { status: 400 },
      );
    }

    const file = await fetchReceipt(sourceUrl);
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'could not retrieve the receipt from sourceUrl' },
        { status: 502 },
      );
    }

    let permanentUrl = sourceUrl;
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (token) {
      const ext = file.contentType.includes('pdf')
        ? 'pdf'
        : file.contentType.includes('png')
          ? 'png'
          : 'jpg';
      const { put } = await import('@vercel/blob');
      // `addRandomSuffix` because the blob is public and the name was
      // otherwise `receipts/<tenantId>/<Date.now()>.<ext>` — guessable, and
      // a collision within the same millisecond throws.
      // Buffer, not the raw Uint8Array: `put` takes a `PutBody`.
      const blob = await put(`receipts/${tenantId}/${Date.now()}.${ext}`, Buffer.from(file.bytes), {
        access: 'public',
        token,
        contentType: file.contentType,
        addRandomSuffix: true,
      });
      permanentUrl = blob.url;
    }

    if (expenseId) {
      // Scoped to the tenant: `update({ where: { id } })` would let a caller
      // set `receiptUrl` on another tenant's expense.
      const updated = await db.abExpense.updateMany({
        where: { id: expenseId, tenantId },
        data: { receiptUrl: permanentUrl },
      });
      if (updated.count === 0) {
        return NextResponse.json({ success: false, error: 'expense not found' }, { status: 404 });
      }
    }

    return NextResponse.json({
      success: true,
      data: { permanentUrl, sourceUrl, stored: permanentUrl !== sourceUrl },
    });
  } catch (err) {
    console.error('[agentbook-expense/receipts/upload-blob POST] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
