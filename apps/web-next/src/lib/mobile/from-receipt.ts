/**
 * POST /expenses/from-receipt core: upload → OCR → ONE expense per
 * (tenant, idempotencyKey), however many times the offline queue replays it.
 *
 * Dedupe, in order:
 *   1. AbExpense.idempotencyKey (permanent; plain index, see
 *      mobile-expense-schema.test.ts for why it is not UNIQUE);
 *   2. an AbIdempotencyKey claim (`mobile_receipt:<tenant>:<key>`), whose
 *      primary key makes concurrent first attempts race-safe. The claim is
 *      released on any failure so the client can retry. A claim left behind
 *      by a killed function (no response recorded, older than STALE_CLAIM_MS)
 *      is taken over once, so a replay is never stranded on 409.
 *
 * Status rule: CONFIRMED only when amount, date and vendor are known AND
 * (the user typed the amount OR OCR confidence ≥ 0.8) AND (personal OR a
 * category resolved). Otherwise pending_review with no journal. A business
 * row is CREATED pending_review, booked with backfillExpenseJournalEntry, and
 * promoted to confirmed only once that returns an entry — so no failure or
 * crash at any point can leave a confirmed business expense off the books.
 * (A confirmable personal row has nothing to book and is created confirmed.)
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { claimKey, recordResponse } from '@/lib/agentbook-idempotency';
import { checkOcrQuota, ocrReceiptBytes, type ReceiptOcrBytesResult } from '@/lib/agentbook-receipt-ocr';
import { backfillExpenseJournalEntry } from '@/lib/agentbook-expense-ledger';
import { isIsoCalendarDate } from '@/lib/iso-calendar-date';
import { toMobileDoc } from './doc-mapper';
import type { FromReceiptResult, MobileDoc } from './types';

/** Just under Vercel's 4.5 MB request-body limit; larger photos are compressed client-side. */
export const RECEIPT_MAX_BYTES = 4_400_000;
export const RECEIPT_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const;
export type ReceiptMime = (typeof RECEIPT_ALLOWED_MIME)[number];
export const AUTO_CONFIRM_MIN_OCR_CONFIDENCE = 0.8;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const RECEIPT_SOURCE = 'mobile_capture';
/** AbExpense amount columns are 32-bit Int; anything above this is not a real receipt. */
export const MAX_AMOUNT_CENTS = 2_000_000_000;
/** A claim with no response this old was left by a killed function (maxDuration 60 s), not one in flight. */
export const STALE_CLAIM_MS = 5 * 60_000;

export { isIsoCalendarDate };


export function claimKeyFor(tenantId: string, idempotencyKey: string): string {
  return `mobile_receipt:${tenantId}:${idempotencyKey}`;
}

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));

/** Identify the file by its magic bytes; the client-declared type is never trusted. */
export function sniffReceiptMime(b: Uint8Array): ReceiptMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  return null;
}

export interface ReceiptOverrides {
  amountCents?: number;
  vendor?: string;
  date?: string;
  categoryId?: string;
  isPersonal?: boolean;
}

/** OCR output is model text: only a positive integer within the Int column is an amount. */
function ocrCents(n: unknown, allowZero: boolean): number | null {
  if (typeof n !== 'number' || !Number.isInteger(n) || n > MAX_AMOUNT_CENTS) return null;
  return n > 0 || (allowZero && n === 0) ? n : null;
}

const ocrText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

interface OcrRead {
  amountCents: number | null;
  taxCents: number;
  tipCents: number;
  vendor: string | null;
  date: string | null;
  items: string | null;
  currency: string | null;
  confidence: number;
}

function readOcr(ocr: ReceiptOcrBytesResult | null): OcrRead | null {
  if (!ocr) return null;
  const confidence = typeof ocr.confidence === 'number' && ocr.confidence >= 0 && ocr.confidence <= 1 ? ocr.confidence : 0;
  return {
    amountCents: ocrCents(ocr.amount_cents, false),
    taxCents: ocrCents(ocr.tax_cents, true) ?? 0,
    tipCents: ocrCents(ocr.tip_cents, true) ?? 0,
    vendor: ocrText(ocr.vendor),
    date: ocr.dateFound && typeof ocr.date === 'string' && isIsoCalendarDate(ocr.date) ? ocr.date : null,
    items: ocrText(ocr.items),
    currency: ocrText(ocr.currency),
    confidence,
  };
}

export type FromReceiptOutcome =
  | { ok: true; status: 200 | 201; expenseId: string; result: FromReceiptResult }
  | { ok: false; status: 400 | 409 | 503; code: 'invalid_category' | 'in_progress' | 'storage_unavailable'; error: string };

function normalizeVendorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Same fallback as PATCH /expenses/[id]: a name with no ASCII letter or digit
 * ('星巴克', Cyrillic, Arabic) normalizes to '' above and would be dropped, so
 * it is keyed by its NFKC letters/digits instead.
 */
function vendorKey(name: string): string {
  return normalizeVendorName(name) || name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Deleted rows are loaded on purpose: a replay must find them so nothing is re-created. */
async function loadDoc(tenantId: string, expenseId: string): Promise<{ doc: MobileDoc; deleted: boolean } | null> {
  const row = await db.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!row) return null;
  const [vendor, category] = await Promise.all([
    row.vendorId ? db.abVendor.findFirst({ where: { id: row.vendorId, tenantId }, select: { name: true } }) : null,
    row.categoryId ? db.abAccount.findFirst({ where: { id: row.categoryId, tenantId }, select: { name: true } }) : null,
  ]);
  return {
    doc: toMobileDoc({ ...row, vendorName: vendor?.name ?? null, categoryName: category?.name ?? null }),
    deleted: row.deletedAt != null,
  };
}

async function findByKey(tenantId: string, idempotencyKey: string): Promise<{ id: string } | null> {
  return db.abExpense.findFirst({ where: { tenantId, idempotencyKey }, select: { id: true } });
}

async function duplicateOf(tenantId: string, expenseId: string): Promise<FromReceiptOutcome | null> {
  const loaded = await loadDoc(tenantId, expenseId);
  if (!loaded) return null;
  const { doc, deleted } = loaded;
  // The original OCR read is not stored; a replay reports what was booked.
  const result: FromReceiptResult = {
    doc,
    duplicate: true,
    ocr: { amountCents: doc.amountCents > 0 ? doc.amountCents : null, vendor: doc.vendorName, date: doc.date },
  };
  if (deleted) result.deleted = true;
  return { ok: true, status: 200, expenseId, result };
}

async function releaseClaim(key: string): Promise<void> {
  await db.abIdempotencyKey.delete({ where: { key } }).catch(() => {});
}

/**
 * The claim is taken but no expense exists. If the holder recorded no response
 * and is older than STALE_CLAIM_MS, its function was killed: delete it — only
 * if it is STILL that old, so two replays cannot both win — and claim ONCE more.
 * A recent claim is a request in flight; the caller answers 409.
 */
async function takeOverStaleClaim(claim: string, tenantId: string): Promise<boolean> {
  const held = await db.abIdempotencyKey.findFirst({ where: { key: claim, tenantId } });
  if (!held || held.response != null) return false;
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  if (!(held.createdAt < cutoff)) return false;
  const { count } = await db.abIdempotencyKey.deleteMany({ where: { key: claim, tenantId, createdAt: { lt: cutoff } } });
  if (count !== 1) return false;
  return claimKey(claim, tenantId);
}

export async function createExpenseFromReceipt(input: {
  tenantId: string;
  idempotencyKey: string;
  bytes: Buffer;
  mimeType: ReceiptMime;
  fileName: string;
  overrides: ReceiptOverrides;
}): Promise<FromReceiptOutcome> {
  const { tenantId, idempotencyKey, bytes, mimeType, fileName, overrides } = input;

  const existing = await findByKey(tenantId, idempotencyKey);
  if (existing) {
    const dup = await duplicateOf(tenantId, existing.id);
    if (dup) return dup;
  }

  const claim = claimKeyFor(tenantId, idempotencyKey);
  if (!(await claimKey(claim, tenantId))) {
    const winner = await findByKey(tenantId, idempotencyKey);
    if (winner) {
      const dup = await duplicateOf(tenantId, winner.id);
      if (dup) return dup;
    }
    if (!(await takeOverStaleClaim(claim, tenantId))) {
      return { ok: false, status: 409, code: 'in_progress', error: 'This receipt is still being processed; retry shortly' };
    }
  }

  try {
    // 1. Validate a user-chosen category BEFORE spending an upload or an OCR call.
    let categoryId: string | null = null;
    let categoryConfidence: number | null = null;
    if (overrides.categoryId) {
      const cat = await db.abAccount.findFirst({
        where: { id: overrides.categoryId, tenantId, accountType: 'expense', isActive: true },
        select: { id: true },
      });
      if (!cat) {
        await releaseClaim(claim);
        return { ok: false, status: 400, code: 'invalid_category', error: 'categoryId is not one of your expense categories' };
      }
      categoryId = cat.id;
      categoryConfidence = 1.0;
    }

    // 2. Store the receipt. Without it there is nothing to keep: refuse, so the
    //    offline queue holds the photo and retries, instead of booking a
    //    receipt-less row.
    let receiptUrl: string;
    try {
      const { put } = await import('@vercel/blob');
      const safeName = (fileName || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const blob = await put(`receipts/${tenantId}/${Date.now()}-${safeName}`, bytes, {
        access: 'public',
        addRandomSuffix: true,
        contentType: mimeType,
      });
      receiptUrl = blob.url;
    } catch (err) {
      console.warn('[expenses/from-receipt] blob store unavailable:', err);
      await releaseClaim(claim);
      return { ok: false, status: 503, code: 'storage_unavailable', error: 'Receipt storage is unavailable; nothing was saved. Retry shortly.' };
    }

    // 3. OCR (metered; over quota means no OCR, not no expense).
    const quota = await checkOcrQuota(tenantId);
    //    A timed-out or failed model call is the same as no OCR: a draft.
    const rawOcr = quota.allowed
      ? await ocrReceiptBytes(bytes, mimeType, receiptUrl).catch((err) => {
          console.warn('[expenses/from-receipt] OCR failed; saving a draft:', err);
          return null;
        })
      : null;
    const ocr = readOcr(rawOcr);
    const ocrAmount = ocr?.amountCents ?? null;
    const ocrDate = ocr?.date ?? null;
    const ocrVendor = ocr?.vendor ?? null;

    const amountCents = overrides.amountCents ?? ocrAmount;
    const dateStr = overrides.date ?? ocrDate;
    const vendorName = overrides.vendor?.trim() || ocrVendor;
    const isPersonal = overrides.isPersonal ?? false;

    // 4. Vendor + remembered category (vendor default → learned pattern), verified live.
    //    The transaction count is bumped with the expense create (step 5), not
    //    here, so a failed attempt that is retried counts once. As elsewhere, a
    //    vendor's first sighting creates it at 0 and later ones increment.
    let vendor: { id: string; defaultCategoryId: string | null; normalizedName: string } | null = null;
    let vendorExisted = false;
    if (vendorName) {
      const normalized = vendorKey(vendorName);
      if (normalized) {
        vendorExisted = !!(await db.abVendor.findFirst({ where: { tenantId, normalizedName: normalized }, select: { id: true } }));
        vendor = await db.abVendor.upsert({
          where: { tenantId_normalizedName: { tenantId, normalizedName: normalized } },
          update: { lastSeen: new Date() },
          create: { tenantId, name: vendorName, normalizedName: normalized },
          select: { id: true, defaultCategoryId: true, normalizedName: true },
        });
      }
    }
    if (!categoryId && vendor && !isPersonal) {
      let remembered: { categoryId: string; confidence: number } | null = null;
      if (vendor.defaultCategoryId) {
        remembered = { categoryId: vendor.defaultCategoryId, confidence: 0.95 };
      } else {
        const pattern = await db.abPattern.findUnique({
          where: { tenantId_vendorPattern: { tenantId, vendorPattern: vendor.normalizedName } },
        });
        if (pattern) remembered = { categoryId: pattern.categoryId, confidence: pattern.confidence };
      }
      if (remembered) {
        const live = await db.abAccount.findFirst({
          where: { id: remembered.categoryId, tenantId, accountType: 'expense', isActive: true },
          select: { id: true },
        });
        if (live) {
          categoryId = live.id;
          categoryConfidence = remembered.confidence;
        }
      }
    }

    // 5. Decide the status and create the row.
    const humanAmount = overrides.amountCents !== undefined;
    const ocrConfident = !!ocr && ocr.confidence >= AUTO_CONFIRM_MIN_OCR_CONFIDENCE;
    const confirmable =
      // `vendor`, not `vendorName`: a name that could not be linked (no letter
      // or digit) is not a known vendor.
      amountCents !== null && dateStr !== null && vendor !== null &&
      (humanAmount || ocrConfident) && (isPersonal || categoryId !== null);

    const tenantCfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId }, select: { currency: true } });
    const parsedDate = dateStr ? new Date(dateStr) : new Date();
    const date = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

    // A personal row has nothing to book, so it can be confirmed at birth. A
    // business row is born pending_review and promoted only after booking.
    const confirmedAtCreate = confirmable && isPersonal;
    const created = await db.$transaction(async (tx) => {
      const exp = await tx.abExpense.create({
        data: {
          tenantId,
          amountCents: amountCents ?? 0,
          taxAmountCents: ocr?.taxCents ?? 0,
          tipAmountCents: ocr?.tipCents ?? 0,
          vendorId: vendor?.id,
          categoryId,
          date,
          description: ocr?.items || vendorName || 'Receipt',
          receiptUrl,
          receiptStatus: 'attached',
          currency: tenantCfg?.currency || ocr?.currency || 'USD',
          confidence: categoryConfidence,
          isPersonal,
          status: confirmedAtCreate ? 'confirmed' : 'pending_review',
          source: RECEIPT_SOURCE,
          idempotencyKey,
          journalEntryId: null,
        },
      });
      if (vendor && vendorExisted) {
        await tx.abVendor.update({ where: { id: vendor.id }, data: { transactionCount: { increment: 1 } } });
      }
      await tx.abEvent.create({
        data: {
          tenantId,
          eventType: confirmedAtCreate ? 'expense.recorded' : 'expense.draft_recorded',
          actor: 'user',
          action: {
            expense_id: exp.id,
            amountCents: amountCents ?? 0,
            vendor: vendorName,
            categoryId,
            source: RECEIPT_SOURCE,
            ocrConfidence: ocr?.confidence ?? null,
            hasReceipt: true,
          },
        },
      });
      return exp;
    });

    // 6. Book a confirmable business expense, THEN promote it. Any failure here
    //    (ledger throws or books nothing, promotion write fails, process dies)
    //    leaves a pending_review row for the review flow, never a confirmed one
    //    off the books. backfillExpenseJournalEntry does not gate on status.
    if (confirmable && !isPersonal) {
      const journalEntryId = await backfillExpenseJournalEntry(tenantId, created.id).catch((err) => {
        console.warn('[expenses/from-receipt] journal posting failed:', err);
        return null;
      });
      if (journalEntryId) {
        await db
          .$transaction([
            db.abExpense.update({ where: { id: created.id }, data: { status: 'confirmed' } }),
            db.abEvent.create({
              data: {
                tenantId,
                eventType: 'expense.recorded',
                actor: 'user',
                action: { expense_id: created.id, journalEntryId, source: RECEIPT_SOURCE },
              },
            }),
          ])
          .catch((err) => {
            console.warn('[expenses/from-receipt] promotion to confirmed failed; left in review:', err);
          });
      }
    }

    await recordResponse(claim, { expenseId: created.id });
    const loaded = await loadDoc(tenantId, created.id);
    if (!loaded) throw new Error('created expense could not be read back');
    return {
      ok: true,
      status: 201,
      expenseId: created.id,
      result: { doc: loaded.doc, duplicate: false, ocr: { amountCents: ocrAmount, vendor: ocrVendor, date: ocrDate } },
    };
  } catch (err) {
    await releaseClaim(claim);
    throw err;
  }
}
