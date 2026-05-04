/**
 * Receipts upload-blob — download a (possibly Telegram-temporary) URL
 * and persist to Vercel Blob if BLOB_READ_WRITE_TOKEN is configured;
 * otherwise return the source URL untouched. If expenseId is given,
 * the expense's receiptUrl is updated to the permanent URL.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface UploadBody {
  sourceUrl?: string;
  expenseId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as UploadBody;
    const { sourceUrl, expenseId } = body;

    if (!sourceUrl) {
      return NextResponse.json({ success: false, error: 'sourceUrl is required' }, { status: 400 });
    }

    let permanentUrl = sourceUrl;
    try {
      const fileRes = await fetch(sourceUrl);
      if (fileRes.ok) {
        const contentType = fileRes.headers.get('content-type') || 'image/jpeg';
        const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('png') ? 'png' : 'jpg';
        const filename = `receipts/${tenantId}/${Date.now()}.${ext}`;
        const token = process.env.BLOB_READ_WRITE_TOKEN;
        if (token) {
          const { put } = await import('@vercel/blob');
          const blob = await put(filename, fileRes.body as never, {
            access: 'public',
            token,
            contentType,
          });
          permanentUrl = blob.url;
        }
      }
    } catch (err) {
      console.warn('[agentbook-expense/receipts/upload-blob] persist failed, using source:', err);
    }

    if (expenseId) {
      await db.abExpense.update({
        where: { id: expenseId },
        data: { receiptUrl: permanentUrl },
      });
    }

    return NextResponse.json({
      success: true,
      data: { permanentUrl, sourceUrl, stored: permanentUrl !== sourceUrl },
    });
  } catch (err) {
    console.error('[agentbook-expense/receipts/upload-blob POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
