// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
const audit = vi.fn(async () => {});
vi.mock('@/lib/agentbook-audit', () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));
const put = vi.fn();
vi.mock('@vercel/blob', () => ({ put: (...a: unknown[]) => put(...a) }));
const checkOcrQuota = vi.fn();
const ocrReceiptBytes = vi.fn();
vi.mock('@/lib/agentbook-receipt-ocr', () => ({
  checkOcrQuota: (...a: unknown[]) => checkOcrQuota(...a),
  ocrReceiptBytes: (...a: unknown[]) => ocrReceiptBytes(...a),
}));
const backfill = vi.fn();
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  backfillExpenseJournalEntry: (...a: unknown[]) => backfill(...a),
}));

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { RECEIPT_MAX_BYTES, sniffReceiptMime } from '@/lib/mobile/from-receipt';
import type { FromReceiptResult } from '@/lib/mobile/types';
import { POST } from '@/app/api/v1/agentbook-expense/expenses/from-receipt/route';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const OCR_GOOD = {
  amount_cents: 4599, vendor: 'Shell', date: '2026-06-19', dateFound: true,
  currency: 'CAD', items: null, tax_cents: 0, tip_cents: 0, confidence: 0.95,
};

function receiptForm(fields: Record<string, string>, bytes: Uint8Array = JPEG, name = 'r.jpg'): FormData {
  const f = new FormData();
  f.set('file', new File([bytes], name, { type: 'image/jpeg' }));
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const send = async (form: FormData, tenant = 't1') => {
  const res = await POST(tenantReq('/api/v1/agentbook-expense/expenses/from-receipt', tenant, { method: 'POST', form }));
  return { status: res.status, body: await json<{ success: boolean; code?: string; error?: string; data: FromReceiptResult }>(res) };
};
const byKey = (key: string) => memDb.table('abExpense').findMany({ where: { idempotencyKey: key } });
const mobileRows = () => memDb.table('abExpense').findMany({ where: { source: 'mobile_capture' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed(), { unique: { abIdempotencyKey: [['key']] } });
  audit.mockClear();
  put.mockReset().mockImplementation(async (path: string) => ({ url: `https://blob.test/${path}` }));
  checkOcrQuota.mockReset().mockResolvedValue({ allowed: true });
  ocrReceiptBytes.mockReset().mockResolvedValue(OCR_GOOD);
  backfill.mockReset().mockResolvedValue('je-new');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /expenses/from-receipt — creating the expense', () => {
  it('a confident read with a known vendor category is confirmed and booked', async () => {
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-confident-1' }));
    expect(status).toBe(201);
    expect(body.data.duplicate).toBe(false);
    expect(body.data.ocr).toEqual({ amountCents: 4599, vendor: 'Shell', date: '2026-06-19' });
    expect(body.data.doc).toMatchObject({
      amountCents: 4599, vendorName: 'Shell', categoryId: 'acc-fuel', categoryName: 'Fuel',
      status: 'confirmed', receiptStatus: 'attached', date: '2026-06-19', isPersonal: false, archivedAt: null,
    });
    expect(body.data.doc.receiptUrl).toMatch(/^https:\/\/blob\.test\/receipts\/t1\//);
    expect(backfill).toHaveBeenCalledWith('t1', body.data.doc.id);
    const [row] = await byKey('key-confident-1');
    expect(row).toMatchObject({ tenantId: 't1', source: 'mobile_capture', currency: 'CAD', vendorId: 'v-shell', confidence: 0.95 });
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^receipts\/t1\//),
      expect.any(Buffer),
      expect.objectContaining({ access: 'public', addRandomSuffix: true, contentType: 'image/jpeg' }),
    );
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('low OCR confidence lands in review, unbooked', async () => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, confidence: 0.4 });
    const { body } = await send(receiptForm({ idempotencyKey: 'key-lowconf-1' }));
    expect(body.data.doc.status).toBe('pending_review');
    expect(backfill).not.toHaveBeenCalled();
  });

  it('an unreadable receipt is kept as a zero-amount draft — nothing invented', async () => {
    ocrReceiptBytes.mockResolvedValue(null);
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-unread-1' }));
    expect(status).toBe(201);
    expect(body.data.doc).toMatchObject({ amountCents: 0, vendorName: null, categoryId: null, status: 'pending_review' });
    expect(body.data.ocr).toEqual({ amountCents: null, vendor: null, date: null });
  });

  it('over quota: no OCR call, and human-entered fields confirm it', async () => {
    checkOcrQuota.mockResolvedValue({ allowed: false, limit: 20 });
    const { body } = await send(receiptForm({
      idempotencyKey: 'key-quota-1', amountCents: '1200', date: '2026-06-18', vendor: 'New Place', categoryId: 'acc-meals',
    }));
    expect(ocrReceiptBytes).not.toHaveBeenCalled();
    expect(body.data.doc).toMatchObject({ amountCents: 1200, vendorName: 'New Place', categoryId: 'acc-meals', status: 'confirmed', date: '2026-06-18' });
    expect(backfill).toHaveBeenCalledTimes(1);
  });

  it('an impossible OCR date counts as no date: not confirmed, not reported', async () => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, date: '2026-13-45', dateFound: true });
    const { body } = await send(receiptForm({ idempotencyKey: 'key-baddate-01' }));
    expect(body.data.ocr.date).toBeNull();
    expect(body.data.doc.status).toBe('pending_review');
    expect(backfill).not.toHaveBeenCalled();
  });

  it('a non-Latin vendor name is kept and linked, never dropped', async () => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, vendor: '星巴克' });
    const { body } = await send(receiptForm({ idempotencyKey: 'key-cjk-0001', categoryId: 'acc-meals' }));
    expect(body.data.doc).toMatchObject({ vendorName: '星巴克', status: 'confirmed' });
    const [row] = await byKey('key-cjk-0001');
    const [vendor] = await memDb.table('abVendor').findMany({ where: { tenantId: 't1', name: '星巴克' } });
    expect(vendor).toMatchObject({ normalizedName: '星巴克' });
    expect(row.vendorId).toBe(vendor.id);
  });

  it('a vendor with no letter or digit cannot be linked, so the row is not confirmed', async () => {
    const { body } = await send(receiptForm({ idempotencyKey: 'key-punct-001', vendor: '---', categoryId: 'acc-meals' }));
    expect(body.data.doc).toMatchObject({ vendorName: null, status: 'pending_review' });
    expect(backfill).not.toHaveBeenCalled();
  });

  it('a confirmed business expense the ledger could not book is sent to review instead', async () => {
    backfill.mockResolvedValue(null);
    const { body } = await send(receiptForm({ idempotencyKey: 'key-nobook-1' }));
    expect(body.data.doc.status).toBe('pending_review');
    expect((await byKey('key-nobook-1'))[0].status).toBe('pending_review');
  });
});

describe('POST /expenses/from-receipt — booking order (never confirmed without a journal)', () => {
  it('the row is still pending_review while the ledger books it, and is promoted only after', async () => {
    let statusDuringBackfill: unknown;
    backfill.mockImplementation(async (_t: string, id: string) => {
      statusDuringBackfill = (await memDb.table('abExpense').findFirst({ where: { id } }))?.status;
      return 'je-new';
    });
    const { body } = await send(receiptForm({ idempotencyKey: 'key-order-001' }));
    expect(statusDuringBackfill).toBe('pending_review');
    expect(body.data.doc.status).toBe('confirmed');
    expect((await byKey('key-order-001'))[0].status).toBe('confirmed');
  });

  it('a ledger that throws leaves the row in review', async () => {
    backfill.mockRejectedValue(new Error('ledger down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-ledgerx-01' }));
    expect(status).toBe(201);
    expect(body.data.doc.status).toBe('pending_review');
    expect((await byKey('key-ledgerx-01'))[0].status).toBe('pending_review');
  });

  it('a failed promotion leaves the row in review and never reports a false confirmed', async () => {
    const table = memDb.table('abExpense');
    const update = vi.spyOn(table, 'update').mockRejectedValueOnce(new Error('db blip'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-promote-01' }));
    expect(update).toHaveBeenCalled();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(status).toBe(201);
    expect(body.data.doc.status).toBe('pending_review');
    expect((await byKey('key-promote-01'))[0].status).toBe('pending_review');
  });

  it('a confirmable personal expense is confirmed without touching the ledger', async () => {
    const { body } = await send(receiptForm({ idempotencyKey: 'key-personal-1', isPersonal: 'true' }));
    expect(body.data.doc).toMatchObject({ status: 'confirmed', isPersonal: true, categoryId: null });
    expect(backfill).not.toHaveBeenCalled();
  });
});

describe('POST /expenses/from-receipt — OCR output is untrusted', () => {
  it.each([
    ['fractional', 45.99],
    ['string', '4599'],
    ['over the Int column', 2_000_000_001],
    ['negative', -5],
    ['zero', 0],
  ])('a %s amount is treated as unknown, not stored', async (_label, amount) => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, amount_cents: amount });
    const { status, body } = await send(receiptForm({ idempotencyKey: `key-amt-${String(_label).replace(/\W/g, '')}` }));
    expect(status).toBe(201);
    expect(body.data.ocr.amountCents).toBeNull();
    expect(body.data.doc).toMatchObject({ amountCents: 0, status: 'pending_review' });
    expect(backfill).not.toHaveBeenCalled();
  });

  it.each([
    ['fractional', 45.5],
    ['string', '12'],
    ['over the Int column', 3_000_000_000],
    ['negative', -1],
  ])('a %s tax or tip is stored as 0', async (_label, bad) => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, tax_cents: bad, tip_cents: bad });
    const key = `key-taxtip-${String(_label).replace(/\W/g, '')}`;
    expect((await send(receiptForm({ idempotencyKey: key }))).status).toBe(201);
    expect((await byKey(key))[0]).toMatchObject({ taxAmountCents: 0, tipAmountCents: 0 });
  });

  it('valid tax and tip are kept', async () => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, tax_cents: 529, tip_cents: 100 });
    await send(receiptForm({ idempotencyKey: 'key-taxtip-ok1' }));
    expect((await byKey('key-taxtip-ok1'))[0]).toMatchObject({ taxAmountCents: 529, tipAmountCents: 100 });
  });

  it('non-string vendor/items and a string confidence cannot confirm or crash the row', async () => {
    ocrReceiptBytes.mockResolvedValue({ ...OCR_GOOD, vendor: 42, items: { a: 1 }, confidence: '0.99' });
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-shape-0001' }));
    expect(status).toBe(201);
    expect(body.data.doc).toMatchObject({ vendorName: null, status: 'pending_review', description: 'Receipt' });
  });

  it('an OCR call that times out degrades to a stored draft', async () => {
    ocrReceiptBytes.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-ocrtime-01' }));
    expect(status).toBe(201);
    expect(body.data.ocr).toEqual({ amountCents: null, vendor: null, date: null });
    expect(body.data.doc).toMatchObject({ amountCents: 0, status: 'pending_review', receiptStatus: 'attached' });
    expect(body.data.doc.receiptUrl).toMatch(/^https:\/\/blob\.test\/receipts\/t1\//);
  });
});

describe('POST /expenses/from-receipt — idempotency', () => {
  it('replaying the same key returns the original expense and creates nothing new', async () => {
    const first = await send(receiptForm({ idempotencyKey: 'key-replay-1' }));
    const second = await send(receiptForm({ idempotencyKey: 'key-replay-1' }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.doc.id).toBe(first.body.data.doc.id);
    expect(await byKey('key-replay-1')).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(ocrReceiptBytes).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('two concurrent first attempts with one key create exactly one expense', async () => {
    const [a, b] = await Promise.all([
      send(receiptForm({ idempotencyKey: 'key-race-0001' })),
      send(receiptForm({ idempotencyKey: 'key-race-0001' })),
    ]);
    expect([a.status, b.status]).toContain(201);
    const loser = a.status === 201 ? b : a;
    expect([200, 409]).toContain(loser.status);
    expect(await byKey('key-race-0001')).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('keys are scoped per tenant', async () => {
    await send(receiptForm({ idempotencyKey: 'key-shared-1' }), 't1');
    const other = await send(receiptForm({ idempotencyKey: 'key-shared-1' }), 't2');
    expect(other.status).toBe(201);
    expect(other.body.data.doc.status).toBe('pending_review');
    expect((await byKey('key-shared-1')).map((r) => r.tenantId).sort()).toEqual(['t1', 't2']);
  });

  it('a request still in flight with the same key gets 409 and does no work', async () => {
    memDb.table('abIdempotencyKey').rows.push({ id: 'claim-1', key: 'mobile_receipt:t1:key-inflight-1', tenantId: 't1', response: null, createdAt: NOW });
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-inflight-1' }));
    expect(status).toBe(409);
    expect(body.code).toBe('in_progress');
    expect(put).not.toHaveBeenCalled();
    expect(await byKey('key-inflight-1')).toHaveLength(0);
  });

  it('a stale claim (no response, older than STALE_CLAIM_MS) is taken over: exactly one expense', async () => {
    const stale = new Date(NOW.getTime() - 10 * 60_000);
    memDb.table('abIdempotencyKey').rows.push({ id: 'claim-s', key: 'mobile_receipt:t1:key-stale-001', tenantId: 't1', response: null, createdAt: stale });
    const first = await send(receiptForm({ idempotencyKey: 'key-stale-001' }));
    expect(first.status).toBe(201);
    const again = await send(receiptForm({ idempotencyKey: 'key-stale-001' }));
    expect(again.status).toBe(200);
    expect(await byKey('key-stale-001')).toHaveLength(1);
    const claims = await memDb.table('abIdempotencyKey').findMany({ where: { key: 'mobile_receipt:t1:key-stale-001' } });
    expect(claims).toHaveLength(1);
    expect(claims[0].response).toEqual({ expenseId: first.body.data.doc.id });
  });

  it('two concurrent replays of a stale claim still create exactly one expense', async () => {
    memDb.table('abIdempotencyKey').rows.push({ id: 'claim-s2', key: 'mobile_receipt:t1:key-stale-002', tenantId: 't1', response: null, createdAt: new Date(NOW.getTime() - 10 * 60_000) });
    const results = await Promise.all([
      send(receiptForm({ idempotencyKey: 'key-stale-002' })),
      send(receiptForm({ idempotencyKey: 'key-stale-002' })),
    ]);
    expect(results.map((r) => r.status)).toContain(201);
    expect(await byKey('key-stale-002')).toHaveLength(1);
  });

  it('the takeover delete is conditional: a claim re-taken after the stale read is not deleted', async () => {
    const claims = memDb.table('abIdempotencyKey');
    const key = 'mobile_receipt:t1:key-stale-003';
    // The row is fresh (another replay just re-claimed it), but this request read it while still stale.
    claims.rows.push({ id: 'claim-fresh', key, tenantId: 't1', response: null, createdAt: NOW });
    vi.spyOn(claims, 'findFirst').mockResolvedValueOnce({ id: 'claim-old', key, tenantId: 't1', response: null, createdAt: new Date(NOW.getTime() - 10 * 60_000) });
    const { status } = await send(receiptForm({ idempotencyKey: 'key-stale-003' }));
    expect(status).toBe(409);
    expect(await claims.findFirst({ where: { key } })).toMatchObject({ id: 'claim-fresh' });
    expect(put).not.toHaveBeenCalled();
  });

  it('a recent claim (1 minute) is still in flight: 409, not taken over', async () => {
    memDb.table('abIdempotencyKey').rows.push({ id: 'claim-r', key: 'mobile_receipt:t1:key-recent-01', tenantId: 't1', response: null, createdAt: new Date(NOW.getTime() - 60_000) });
    const { status, body } = await send(receiptForm({ idempotencyKey: 'key-recent-01' }));
    expect(status).toBe(409);
    expect(body.code).toBe('in_progress');
    expect(put).not.toHaveBeenCalled();
  });

  it('a stale claim that already recorded a response is not taken over', async () => {
    memDb.table('abIdempotencyKey').rows.push({ id: 'claim-d', key: 'mobile_receipt:t1:key-done-0001', tenantId: 't1', response: { expenseId: 'gone' }, createdAt: new Date(NOW.getTime() - 10 * 60_000) });
    expect((await send(receiptForm({ idempotencyKey: 'key-done-0001' }))).status).toBe(409);
    expect(put).not.toHaveBeenCalled();
  });

  it('takeover is tenant-scoped: another tenant never touches a stale claim it does not own', async () => {
    const stale = new Date(NOW.getTime() - 10 * 60_000);
    memDb.table('abIdempotencyKey').rows.push({ id: 'claim-t', key: 'mobile_receipt:t1:key-stale-ten', tenantId: 't1', response: null, createdAt: stale });
    const other = await send(receiptForm({ idempotencyKey: 'key-stale-ten' }), 't2');
    expect(other.status).toBe(201);
    const t1Claim = await memDb.table('abIdempotencyKey').findFirst({ where: { key: 'mobile_receipt:t1:key-stale-ten' } });
    expect(t1Claim).toMatchObject({ id: 'claim-t', response: null });
    expect((await byKey('key-stale-ten')).map((r) => r.tenantId)).toEqual(['t2']);
  });

  it('replaying the key of a soft-deleted expense returns it flagged deleted and creates nothing', async () => {
    const first = await send(receiptForm({ idempotencyKey: 'key-deleted-01' }));
    expect(first.body.data.deleted).toBeUndefined();
    const row = memDb.table('abExpense').rows.find((r) => r.id === first.body.data.doc.id)!;
    row.deletedAt = new Date(NOW.getTime() - 1000);
    const replay = await send(receiptForm({ idempotencyKey: 'key-deleted-01' }));
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ duplicate: true, deleted: true });
    expect(replay.body.data.doc.id).toBe(first.body.data.doc.id);
    expect(await byKey('key-deleted-01')).toHaveLength(1);
    const live = await send(receiptForm({ idempotencyKey: 'key-replay-live' }));
    expect((await send(receiptForm({ idempotencyKey: 'key-replay-live' }))).body.data.deleted).toBeUndefined();
    expect(live.status).toBe(201);
  });

  it('a retried attempt counts the vendor once, not once per attempt', async () => {
    const table = memDb.table('abExpense');
    vi.spyOn(table, 'create').mockRejectedValueOnce(new Error('db blip'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await send(receiptForm({ idempotencyKey: 'key-vcount-01' }));
    expect(failed.status).toBe(500);
    expect((await send(receiptForm({ idempotencyKey: 'key-vcount-01' }))).status).toBe(201);
    const shell = await memDb.table('abVendor').findFirst({ where: { id: 'v-shell' } });
    expect(shell?.transactionCount).toBe(3); // seeded 2, one expense created
  });

  it('a foreign category is rejected before upload, and the key can be retried', async () => {
    const bad = await send(receiptForm({ idempotencyKey: 'key-badcat-1', categoryId: 'b-meals' }));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_category');
    expect(put).not.toHaveBeenCalled();
    const good = await send(receiptForm({ idempotencyKey: 'key-badcat-1', categoryId: 'acc-meals' }));
    expect(good.status).toBe(201);
  });

  it('a storage outage saves nothing, says so, and the key can be retried', async () => {
    put.mockRejectedValueOnce(new Error('blob down'));
    const down = await send(receiptForm({ idempotencyKey: 'key-blob-1' }));
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('storage_unavailable');
    expect(down.body.error).not.toMatch(/blob down/);
    expect(await byKey('key-blob-1')).toHaveLength(0);
    expect((await send(receiptForm({ idempotencyKey: 'key-blob-1' }))).status).toBe(201);
  });
});

describe('POST /expenses/from-receipt — input validation', () => {
  it('rejects wrong types, oversize files, bad keys and bad fields without uploading', async () => {
    const big = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    big.set(JPEG);
    const cases: Array<[FormData, number, string]> = [
      [receiptForm({ idempotencyKey: 'key-type-001' }, new TextEncoder().encode('hello world')), 415, 'unsupported_type'],
      [receiptForm({ idempotencyKey: 'key-size-001' }, big), 413, 'file_too_large'],
      [receiptForm({}), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'bad key!' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'abc' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-amount-01', amountCents: 'abc' }), 400, 'bad_request'],
      // Decimal integers only: Number() would read these as 1000, 16 and 12.
      [receiptForm({ idempotencyKey: 'key-amount-02', amountCents: '1e3' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-amount-03', amountCents: '0x10' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-amount-04', amountCents: '12.0' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-amount-05', amountCents: '0' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-date-0002', date: '2026-02-31' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-date-0001', date: '06/01/2026' }), 400, 'bad_request'],
      [receiptForm({ idempotencyKey: 'key-pers-0001', isPersonal: 'yes' }), 400, 'bad_request'],
    ];
    for (const [form, status, code] of cases) {
      const res = await send(form);
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
    const noFile = new FormData();
    noFile.set('idempotencyKey', 'key-nofile-01');
    expect((await send(noFile)).status).toBe(400);
    const jsonRes = await POST(tenantReq('/api/v1/agentbook-expense/expenses/from-receipt', 't1', { method: 'POST', body: { idempotencyKey: 'key-json-0001' } }));
    expect(jsonRes.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(await mobileRows()).toHaveLength(0);
  });

  it('401 without a session', async () => {
    expect((await send(receiptForm({ idempotencyKey: 'key-noauth-01' }), 'none')).status).toBe(401);
  });

  it('sniffs real file signatures, not the declared type', () => {
    const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
    expect(sniffReceiptMime(JPEG)).toBe('image/jpeg');
    expect(sniffReceiptMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffReceiptMime(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]))).toBe('image/webp');
    expect(sniffReceiptMime(new Uint8Array(ascii('%PDF-1.7')))).toBe('application/pdf');
    expect(sniffReceiptMime(new Uint8Array([0, 0, 0, 0x18, ...ascii('ftypheic')]))).toBe('image/heic');
    expect(sniffReceiptMime(new Uint8Array([0, 0, 0, 0x18, ...ascii('ftypmif1')]))).toBe('image/heif');
    expect(sniffReceiptMime(new Uint8Array(ascii('<svg></svg>')))).toBeNull();
  });
});
