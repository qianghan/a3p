import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { matchRemotePattern } = require('next/dist/shared/lib/match-remote-pattern') as {
  matchRemotePattern: (p: object, url: URL) => boolean;
};

type ImagesConfig = {
  remotePatterns?: object[];
  unoptimized?: boolean;
  loader?: string;
  loaderFile?: string;
  domains?: string[];
};

function loadConfig(): { images?: ImagesConfig } {
  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  return require(join(__dirname, '..', '..', '..', '..', 'next.config.js'));
}

const allowed = (url: string) => (loadConfig().images?.remotePatterns ?? []).some((p) => matchRemotePattern(p, new URL(url)));

describe('receipt thumbnails can use the Next image optimizer', () => {
  it('is not globally unoptimized and has no custom loader bypassing the optimizer', () => {
    const images = loadConfig().images;
    expect(images?.unoptimized).not.toBe(true);
    expect(images?.loader ?? 'default').toBe('default');
    expect(images?.loaderFile).toBeUndefined();
  });
  it.each([
    'https://abcd1234efgh5678.public.blob.vercel-storage.com/receipts/tenant-1/1759800000000-receipt-AbCdEf123.jpg',
    'https://abcd1234efgh5678.public.blob.vercel-storage.com/receipts/tenant-1/1759800000000-Xyz.png',
  ])('allows the Vercel Blob URL shape receipts are stored at: %s', (url) => {
    expect(allowed(url)).toBe(true);
  });
  it.each([
    'https://evil.example.com/receipt.jpg',
    'http://abcd.public.blob.vercel-storage.com/receipts/a.jpg',
    'https://vercel-storage.com.evil.example/receipts/a.jpg',
    'https://evil.example.com/vercel-storage.com/receipts/a.jpg',
    'https://notvercel-storage.com/receipts/a.jpg',
  ])('does not turn the optimizer into an open image proxy: %s', (url) => {
    expect(allowed(url)).toBe(false);
  });
});
