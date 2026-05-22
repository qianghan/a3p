/**
 * Tests for the Telegram-webhook idempotency helper (PR 21).
 *
 * Telegram retries webhook deliveries when the receiver times out or
 * returns 5xx. Without dedup, a retry can double-book an expense or
 * re-send an invoice. The helper claims a key (`tg_update:<update_id>`
 * or `tg_callback:<callback_query_id>`) at the very top of the POST
 * handler — first call wins, replays short-circuit.
 *
 * These tests pin the contract:
 *   1. claimKey — first call returns true (and writes a row).
 *   2. claimKey — second call collides on the unique PK (Prisma P2002)
 *      and returns false; the caller short-circuits.
 *   3. claimKey — non-P2002 errors propagate (don't silently swallow).
 *   4. recordResponse — writes the cached body for the existing row.
 *   5. getCachedResponse — returns the cached body on a replay.
 *   6. getCachedResponse — returns null for an unclaimed key.
 *
 * Pure unit-style: the Prisma client is mocked at the module boundary.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@naap/database', () => {
  return {
    prisma: {
      abIdempotencyKey: {
        create: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
        deleteMany: vi.fn(),
      },
      abHttpIdempotencyKey: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
      },
    },
  };
});

import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { prisma as db } from '@naap/database';
import {
  claimKey,
  recordResponse,
  getCachedResponse,
  pruneIdempotencyKeys,
  withHttpIdempotency,
} from './agentbook-idempotency';

const mockedDb = db as unknown as {
  abIdempotencyKey: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  abHttpIdempotencyKey: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

const TENANT_A = 'tenant-A';
const KEY = 'tg_update:42';

beforeEach(() => {
  mockedDb.abIdempotencyKey.create.mockReset();
  mockedDb.abIdempotencyKey.update.mockReset();
  mockedDb.abIdempotencyKey.findUnique.mockReset();
  mockedDb.abIdempotencyKey.deleteMany.mockReset();
  mockedDb.abHttpIdempotencyKey.findUnique.mockReset();
  mockedDb.abHttpIdempotencyKey.upsert.mockReset();
  mockedDb.abHttpIdempotencyKey.deleteMany.mockReset();
});

describe('claimKey', () => {
  it('returns true on the first claim and writes a row scoped to the tenant', async () => {
    mockedDb.abIdempotencyKey.create.mockResolvedValue({
      key: KEY,
      tenantId: TENANT_A,
      response: null,
      createdAt: new Date(),
    });

    const ok = await claimKey(KEY, TENANT_A);

    expect(ok).toBe(true);
    expect(mockedDb.abIdempotencyKey.create).toHaveBeenCalledTimes(1);
    const args = mockedDb.abIdempotencyKey.create.mock.calls[0][0];
    expect(args.data).toMatchObject({ key: KEY, tenantId: TENANT_A });
  });

  it('returns false when the key already exists (Prisma P2002 race)', async () => {
    // Simulate the second-arriver losing the unique-PK race.
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mockedDb.abIdempotencyKey.create.mockRejectedValue(p2002);

    const ok = await claimKey(KEY, TENANT_A);

    expect(ok).toBe(false);
    expect(mockedDb.abIdempotencyKey.create).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-P2002 errors so real DB problems are not silently swallowed', async () => {
    mockedDb.abIdempotencyKey.create.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'P1001' }),
    );

    await expect(claimKey(KEY, TENANT_A)).rejects.toThrow(/connection refused/);
  });
});

describe('recordResponse', () => {
  it('updates the existing row with the cached response payload', async () => {
    mockedDb.abIdempotencyKey.update.mockResolvedValue({});

    await recordResponse(KEY, { ok: true, foo: 'bar' });

    expect(mockedDb.abIdempotencyKey.update).toHaveBeenCalledTimes(1);
    const args = mockedDb.abIdempotencyKey.update.mock.calls[0][0];
    expect(args.where).toEqual({ key: KEY });
    expect(args.data).toEqual({ response: { ok: true, foo: 'bar' } });
  });

  it('swallows update errors — caching the response is best-effort', async () => {
    // The original side effects already ran; if we can't write the
    // cache, the worst case is the replay returns a generic idempotent
    // marker instead of the original body. Don't blow up the request.
    mockedDb.abIdempotencyKey.update.mockRejectedValue(new Error('db hiccup'));

    await expect(
      recordResponse(KEY, { ok: true }),
    ).resolves.toBeUndefined();
  });
});

describe('getCachedResponse', () => {
  it('returns the cached response payload for a previously-claimed key', async () => {
    mockedDb.abIdempotencyKey.findUnique.mockResolvedValue({
      key: KEY,
      tenantId: TENANT_A,
      response: { ok: true, idempotent: true, original: 'reply' },
      createdAt: new Date(),
    });

    const r = await getCachedResponse(KEY);

    expect(r).toEqual({ ok: true, idempotent: true, original: 'reply' });
    expect(mockedDb.abIdempotencyKey.findUnique).toHaveBeenCalledWith({
      where: { key: KEY },
    });
  });

  it('returns null for an unclaimed key', async () => {
    mockedDb.abIdempotencyKey.findUnique.mockResolvedValue(null);

    const r = await getCachedResponse('tg_update:does-not-exist');

    expect(r).toBeNull();
  });

  it('returns null when the row exists but no response was cached yet', async () => {
    mockedDb.abIdempotencyKey.findUnique.mockResolvedValue({
      key: KEY,
      tenantId: TENANT_A,
      response: null,
      createdAt: new Date(),
    });

    const r = await getCachedResponse(KEY);

    expect(r).toBeNull();
  });
});

describe('pruneIdempotencyKeys', () => {
  it('deletes rows older than the cutoff (default 1 day) and returns the count', async () => {
    mockedDb.abIdempotencyKey.deleteMany.mockResolvedValue({ count: 12 });
    mockedDb.abHttpIdempotencyKey.deleteMany.mockResolvedValue({ count: 0 });

    const before = Date.now();
    const r = await pruneIdempotencyKeys();
    const after = Date.now();

    expect(r).toEqual({ deleted: 12 });
    expect(mockedDb.abIdempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
    const args = mockedDb.abIdempotencyKey.deleteMany.mock.calls[0][0];
    const cutoff: Date = args.where.createdAt.lt;
    const expectedMin = before - 86_400_000 - 1000;
    const expectedMax = after - 86_400_000 + 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it('honours a custom retention window (in hours)', async () => {
    mockedDb.abIdempotencyKey.deleteMany.mockResolvedValue({ count: 5 });
    mockedDb.abHttpIdempotencyKey.deleteMany.mockResolvedValue({ count: 0 });

    const r = await pruneIdempotencyKeys({ olderThanHours: 6 });

    expect(r).toEqual({ deleted: 5 });
    const args = mockedDb.abIdempotencyKey.deleteMany.mock.calls[0][0];
    const cutoff: Date = args.where.createdAt.lt;
    const sixHoursAgo = Date.now() - 6 * 3_600_000;
    expect(Math.abs(cutoff.getTime() - sixHoursAgo)).toBeLessThan(2_000);
  });

  it('also prunes expired AbHttpIdempotencyKey rows (G-020, PR 15)', async () => {
    mockedDb.abIdempotencyKey.deleteMany.mockResolvedValue({ count: 3 });
    mockedDb.abHttpIdempotencyKey.deleteMany.mockResolvedValue({ count: 7 });

    const r = await pruneIdempotencyKeys();

    // Combined count: Telegram (3) + HTTP (7) = 10.
    expect(r).toEqual({ deleted: 10 });
    expect(mockedDb.abHttpIdempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
    const args = mockedDb.abHttpIdempotencyKey.deleteMany.mock.calls[0][0];
    expect(args.where.expiresAt.lt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------
// withHttpIdempotency (G-020, PR 15)
//
// Pins the wrapper's contract:
//   - no header → handler runs, no cache write
//   - first call with header → handler runs, cache written
//   - replay with same body → cached response replayed, handler NOT called
//   - replay with different body → 422
//   - expired entry → falls through to fresh execution
// ---------------------------------------------------------------------

function makeReq(body: object, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/test', {
    method: 'POST',
    headers: new Headers(headers),
    body: JSON.stringify(body),
  });
}

describe('withHttpIdempotency', () => {
  const ENDPOINT = 'POST /api/v1/test';

  it('no Idempotency-Key header → runs handler, no cache write', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 201, body: { id: 'new' } });
    const res = await withHttpIdempotency(makeReq({ amount: 100 }), {
      tenantId: 't1',
      endpoint: ENDPOINT,
      handler,
    });
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledOnce();
    expect(mockedDb.abHttpIdempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(mockedDb.abHttpIdempotencyKey.upsert).not.toHaveBeenCalled();
  });

  it('first call with key → runs handler, writes cache row', async () => {
    mockedDb.abHttpIdempotencyKey.findUnique.mockResolvedValue(null);
    mockedDb.abHttpIdempotencyKey.upsert.mockResolvedValue({});
    const handler = vi.fn().mockResolvedValue({ status: 201, body: { id: 'new' } });

    const res = await withHttpIdempotency(
      makeReq({ amount: 100 }, { 'idempotency-key': 'abc' }),
      { tenantId: 't1', endpoint: ENDPOINT, handler },
    );

    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledOnce();
    expect(mockedDb.abHttpIdempotencyKey.upsert).toHaveBeenCalledOnce();
    const upsertArgs = mockedDb.abHttpIdempotencyKey.upsert.mock.calls[0][0];
    expect(upsertArgs.create.tenantId).toBe('t1');
    expect(upsertArgs.create.key).toBe('abc');
    expect(upsertArgs.create.endpoint).toBe(ENDPOINT);
    expect(upsertArgs.create.status).toBe(201);
    // requestHash must be a sha256 hex digest
    expect(upsertArgs.create.requestHash).toMatch(/^[a-f0-9]{64}$/);
    // responseJson serializes the body
    expect(JSON.parse(upsertArgs.create.responseJson)).toEqual({ id: 'new' });
  });

  it('replay with same key + same body → returns cached response, handler NOT called', async () => {
    const bodyObj = { amount: 100 };
    const cachedHash = createHash('sha256')
      .update(JSON.stringify(bodyObj))
      .digest('hex');
    mockedDb.abHttpIdempotencyKey.findUnique.mockResolvedValue({
      id: 'x',
      tenantId: 't1',
      key: 'abc',
      endpoint: ENDPOINT,
      requestHash: cachedHash,
      responseJson: JSON.stringify({ id: 'cached' }),
      status: 201,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const handler = vi.fn().mockResolvedValue({ status: 201, body: { id: 'fresh' } });

    const res = await withHttpIdempotency(
      makeReq(bodyObj, { 'idempotency-key': 'abc' }),
      { tenantId: 't1', endpoint: ENDPOINT, handler },
    );

    expect(res.status).toBe(201);
    expect(handler).not.toHaveBeenCalled();
    expect(mockedDb.abHttpIdempotencyKey.upsert).not.toHaveBeenCalled();
    const responseBody = await res.json();
    expect(responseBody).toEqual({ id: 'cached' });
  });

  it('replay with same key but different body → 422 (caller misuse)', async () => {
    mockedDb.abHttpIdempotencyKey.findUnique.mockResolvedValue({
      id: 'x',
      tenantId: 't1',
      key: 'abc',
      endpoint: ENDPOINT,
      requestHash: 'wrong-hash-for-this-body',
      responseJson: JSON.stringify({}),
      status: 201,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const handler = vi.fn();

    const res = await withHttpIdempotency(
      makeReq({ amount: 100 }, { 'idempotency-key': 'abc' }),
      { tenantId: 't1', endpoint: ENDPOINT, handler },
    );

    expect(res.status).toBe(422);
    expect(handler).not.toHaveBeenCalled();
    expect(mockedDb.abHttpIdempotencyKey.upsert).not.toHaveBeenCalled();
  });

  it('expired cache entry → falls through to fresh execution + overwrites', async () => {
    mockedDb.abHttpIdempotencyKey.findUnique.mockResolvedValue({
      id: 'x',
      tenantId: 't1',
      key: 'abc',
      endpoint: ENDPOINT,
      requestHash: 'stale-hash',
      responseJson: JSON.stringify({ id: 'old' }),
      status: 201,
      createdAt: new Date(Date.now() - 86_400_000),
      // Expired 1 minute ago.
      expiresAt: new Date(Date.now() - 60_000),
    });
    mockedDb.abHttpIdempotencyKey.upsert.mockResolvedValue({});
    const handler = vi.fn().mockResolvedValue({ status: 201, body: { id: 'new' } });

    const res = await withHttpIdempotency(
      makeReq({ amount: 100 }, { 'idempotency-key': 'abc' }),
      { tenantId: 't1', endpoint: ENDPOINT, handler },
    );

    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledOnce();
    expect(mockedDb.abHttpIdempotencyKey.upsert).toHaveBeenCalledOnce();
    const responseBody = await res.json();
    expect(responseBody).toEqual({ id: 'new' });
  });
});
