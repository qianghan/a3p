// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

import { isAllowedReceiptUrl, fetchReceipt } from '@/lib/agentbook-safe-fetch';

describe('isAllowedReceiptUrl', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = saved;
  });

  it('allows the storage hosts receipts actually live on', () => {
    for (const u of [
      'https://blob.vercel-storage.com/receipts/t1/1.jpg',
      'https://abc123.public.blob.vercel-storage.com/receipts/t1/1.jpg',
      'https://a3book.brainliber.com/r.png',
      'https://agentbook.brainliber.com/r.png',
    ]) {
      expect(isAllowedReceiptUrl(u), u).toBe(true);
    }
  });

  it('refuses the SSRF targets that motivated the guard', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',       // cloud metadata
      'https://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'https://192.168.1.1/admin',
      'http://172.16.0.1/',
      'https://[::1]/',
      'http://example.com/r.jpg',                        // not on the list
      'https://evil.com/r.jpg',
      'https://blob.vercel-storage.com.evil.com/r.jpg',  // suffix confusion
      'https://notblob.vercel-storage.com.evil.io/r',
    ]) {
      expect(isAllowedReceiptUrl(u), u).toBe(false);
    }
  });

  it('refuses non-http schemes and unparseable input', () => {
    for (const u of [
      'file:///etc/passwd',
      'ftp://localhost/foo',
      'gopher://localhost/x',
      'data:text/plain;base64,QQ==',
      'not a url',
      '',
    ]) {
      expect(isAllowedReceiptUrl(u), u).toBe(false);
    }
  });

  it('accepts the localhost dev shims outside production only', () => {
    process.env.NODE_ENV = 'development';
    expect(isAllowedReceiptUrl('http://localhost:3000/r.jpg')).toBe(true);
    expect(isAllowedReceiptUrl('http://127.0.0.1:3000/r.jpg')).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(isAllowedReceiptUrl('http://localhost:3000/r.jpg')).toBe(false);
    expect(isAllowedReceiptUrl('http://127.0.0.1:3000/r.jpg')).toBe(false);
    expect(isAllowedReceiptUrl('https://localhost/r.jpg')).toBe(false);
  });

  it('refuses plain http on a real storage host, which would put the URL on the wire in clear', () => {
    process.env.NODE_ENV = 'production';
    expect(isAllowedReceiptUrl('http://blob.vercel-storage.com/r.jpg')).toBe(false);
    expect(isAllowedReceiptUrl('https://blob.vercel-storage.com/r.jpg')).toBe(true);
  });
});

describe('fetchReceipt', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const OK = 'https://blob.vercel-storage.com/receipts/t1/1.jpg';

  it('does not issue a request at all for a disallowed host', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await fetchReceipt('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to follow redirects — an allowed host must not be able to bounce us', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    vi.stubGlobal('fetch', spy);
    await fetchReceipt(OK);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('rejects a body over the cap, whether declared or actual', async () => {
    // Declared too big — refused without reading the body.
    const arrayBuffer = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) }),
        arrayBuffer,
      }),
    );
    expect(await fetchReceipt(OK)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();

    // Lies about its length — caught after buffering, because content-length
    // is a claim the origin makes.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '10' }),
        arrayBuffer: async () => new ArrayBuffer(30 * 1024 * 1024),
      }),
    );
    expect(await fetchReceipt(OK)).toBeNull();
  });

  it('returns the bytes and content type on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );
    const out = await fetchReceipt(OK);
    expect(out?.contentType).toBe('image/png');
    expect(out?.bytes.byteLength).toBe(3);
  });

  it('returns null rather than throwing when the fetch errors or is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await fetchReceipt(OK)).toBeNull();
  });
});
