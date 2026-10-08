/**
 * POST /api/v1/agentbook-expense/expenses/from-receipt
 *
 * Mobile capture (online save AND offline-queue replay): multipart `file` +
 * required `idempotencyKey` + optional overrides (amountCents, vendor, date,
 * categoryId, isPersonal). Stores the receipt in Blob, OCRs it, and creates
 * exactly one expense per key. See lib/mobile/from-receipt.ts.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { publicErrorMessage } from '@/lib/api-error';
import {
  createExpenseFromReceipt,
  sniffReceiptMime,
  RECEIPT_MAX_BYTES,
  IDEMPOTENCY_KEY_RE,
  isIsoCalendarDate,
  MAX_AMOUNT_CENTS,
  RECEIPT_SOURCE,
  type ReceiptOverrides,
} from '@/lib/mobile/from-receipt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function fail(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ success: false, code, error }, { status });
}

function parseOverrides(form: FormData): ReceiptOverrides | string {
  const out: ReceiptOverrides = {};
  const amount = form.get('amountCents');
  if (typeof amount === 'string' && amount !== '') {
    // Decimal digits only: Number() alone would accept '1e3', '0x10' and '12.0'.
    const n = /^\d{1,10}$/.test(amount) ? Number(amount) : NaN;
    if (!Number.isInteger(n) || n <= 0 || n > MAX_AMOUNT_CENTS) return 'amountCents must be a positive integer';
    out.amountCents = n;
  }
  const vendor = form.get('vendor');
  if (typeof vendor === 'string' && vendor.trim() !== '') {
    if (vendor.length > 200) return 'vendor must be at most 200 characters';
    out.vendor = vendor.trim();
  }
  const date = form.get('date');
  if (typeof date === 'string' && date !== '') {
    if (!isIsoCalendarDate(date)) return 'date must be YYYY-MM-DD';
    out.date = date;
  }
  const categoryId = form.get('categoryId');
  if (typeof categoryId === 'string' && categoryId !== '') out.categoryId = categoryId;
  const isPersonal = form.get('isPersonal');
  if (isPersonal === 'true') out.isPersonal = true;
  else if (isPersonal === 'false') out.isPersonal = false;
  else if (isPersonal !== null && isPersonal !== '') return 'isPersonal must be true or false';
  return out;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, 'bad_request', 'send multipart/form-data with a file field');
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'bad_request', 'file is required');
    if (file.size > RECEIPT_MAX_BYTES) return fail(413, 'file_too_large', `file must be at most ${RECEIPT_MAX_BYTES} bytes`);

    const idempotencyKey = form.get('idempotencyKey');
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return fail(400, 'bad_request', 'idempotencyKey is required: 8-128 letters, digits, - or _');
    }

    const overrides = parseOverrides(form);
    if (typeof overrides === 'string') return fail(400, 'bad_request', overrides);

    const bytes = Buffer.from(await file.arrayBuffer());
    const mimeType = sniffReceiptMime(bytes);
    if (!mimeType) return fail(415, 'unsupported_type', 'file must be a JPEG, PNG, WebP, HEIC or PDF');

    const outcome = await createExpenseFromReceipt({
      tenantId,
      idempotencyKey,
      bytes,
      mimeType,
      fileName: file.name,
      overrides,
    });
    if (!outcome.ok) return fail(outcome.status, outcome.code, outcome.error);

    if (!outcome.result.duplicate) {
      await audit({
        tenantId,
        source: inferSource(request),
        actor: await inferActor(request),
        action: 'expense.create',
        entityType: 'AbExpense',
        entityId: outcome.expenseId,
        after: {
          amountCents: outcome.result.doc.amountCents,
          status: outcome.result.doc.status,
          hasReceipt: true,
          source: RECEIPT_SOURCE,
        },
      });
    }

    return NextResponse.json({ success: true, data: outcome.result }, { status: outcome.status });
  } catch (err) {
    console.error('[agentbook-expense/expenses/from-receipt] failed:', err);
    return NextResponse.json(
      { success: false, code: 'internal_error', error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
