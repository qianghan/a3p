import { describe, it, expect, vi, afterEach } from 'vitest';
import { isAllowedReceiptUrl, parseAllowedReceiptUrl, fetchReceipt } from '../safe-fetch.js';
import { isPrivateHost } from '../security.js';

/**
 * These live in the shared package now because the Express plugin backends
 * could not import the copy in apps/web-next, so they fetched caller-supplied
 * URLs with no guard at all — two critical `js/request-forgery` alerts. The
 * tests move with the code so the guard is covered wherever it is used.
 */

const ORIGINAL_ENV = process.env.NODE_ENV;
afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe('isPrivateHost', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', 'localhost',
    '169.254.169.254',  // cloud instance metadata — the classic SSRF target
    '::1', '0.0.0.0',
  ])('%s is private', (h) => expect(isPrivateHost(h)).toBe(true));

  it.each(['blob.vercel-storage.com', 'example.com', '8.8.8.8'])(
    '%s is public', (h) => expect(isPrivateHost(h)).toBe(false),
  );
});

describe('isAllowedReceiptUrl', () => {
  it('accepts the hosts receipts actually live on', () => {
    expect(isAllowedReceiptUrl('https://abc.public.blob.vercel-storage.com/r/1.jpg')).toBe(true);
    expect(isAllowedReceiptUrl('https://agentbook.brainliber.com/r/1.jpg')).toBe(true);
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://localhost:6379/', 'a local service'],
    ['https://attacker.example.com/x.jpg', 'an unlisted host'],
    ['file:///etc/passwd', 'a non-http scheme'],
    ['gopher://x/', 'another non-http scheme'],
    ['not a url', 'unparseable input'],
  ])('refuses %s (%s)', (url) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(isAllowedReceiptUrl(url)).toBe(false);
  });

  it('refuses plain http even on an allowed host', () => {
    // For a Telegram-derived URL the bot token is in the path, so http would
    // put a credential on the wire in clear.
    expect(isAllowedReceiptUrl('http://agentbook.brainliber.com/r/1.jpg')).toBe(false);
  });

  it('allows the localhost dev shim outside production only', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    expect(isAllowedReceiptUrl('http://localhost:3000/blob/1.jpg')).toBe(true);
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(isAllowedReceiptUrl('http://localhost:3000/blob/1.jpg')).toBe(false);
  });
});

describe('parseAllowedReceiptUrl', () => {
  it('returns the parsed URL for an allowed source and null otherwise', () => {
    expect(parseAllowedReceiptUrl('https://blob.vercel-storage.com/r/1.jpg')).toBeInstanceOf(URL);
    expect(parseAllowedReceiptUrl('http://169.254.169.254/latest/meta-data/')).toBeNull();
  });

  it('agrees with the boolean form', () => {
    for (const u of [
      'https://blob.vercel-storage.com/r/1.jpg',
      'http://169.254.169.254/',
      'file:///etc/passwd',
      'nonsense',
    ]) {
      expect(parseAllowedReceiptUrl(u) !== null).toBe(isAllowedReceiptUrl(u));
    }
  });
});

describe('fetchReceipt', () => {
  it('never calls fetch for a refused URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchReceipt('http://169.254.169.254/latest/meta-data/')).toBeNull();
    // The check must happen BEFORE the request — a guard that inspects the
    // response has already made the request the attacker wanted.
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to follow redirects', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
    );
    await fetchReceipt('https://blob.vercel-storage.com/r/1.jpg');
    // Without this, an allowed host could bounce the request anywhere and the
    // host check would have decided nothing.
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('rejects a body larger than the cap even when content-length lies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(1024), {
        headers: { 'content-type': 'image/jpeg', 'content-length': '10' },
      }),
    );
    expect(await fetchReceipt('https://blob.vercel-storage.com/r/1.jpg', { maxBytes: 100 })).toBeNull();
  });

  it('returns bytes and content type on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([7, 7, 7]), { headers: { 'content-type': 'image/png' } }),
    );
    const out = await fetchReceipt('https://blob.vercel-storage.com/r/1.png');
    expect(out?.contentType).toBe('image/png');
    expect(out?.bytes.byteLength).toBe(3);
  });
});

describe('the guard cannot be separated from the request', () => {
  it('fetches the parsed URL object, never the raw input string', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }),
    );
    await fetchReceipt('https://blob.vercel-storage.com/r/1.jpg?a=1');
    // A string argument would mean the validated value was discarded and the
    // unchecked input re-used — the shape that lets a later edit drift the
    // guard and the request apart.
    expect(spy.mock.calls[0][0]).toBeInstanceOf(URL);
  });
});
