/**
 * Thin wrapper around `@vercel/blob` for the year-end tax package
 * uploads (PR 5). Centralised so future callers (invoice PDFs, receipts)
 * have one place to set policy.
 *
 * Dev fallback: when `BLOB_READ_WRITE_TOKEN` is missing we return a
 * `data:` URL with the buffer base64-encoded. Tests + local Telegram
 * loops still resolve to a clickable link — Telegram won't actually
 * preview a `data:` URL, but the unit/e2e tests only need a usable
 * string for assertions.
 */

import 'server-only';
import { put } from '@vercel/blob';

export interface UploadResult {
  url: string;
  size: number;
}

export interface UploadOpts {
  /** Default 'public' so download links work without an auth token. */
  access?: 'public';
  /** Override file name addressing (default uses the supplied filename). */
  addRandomSuffix?: boolean;
  /** Optional override of cacheControl, e.g. '0' to bust browser cache. */
  cacheControlMaxAge?: number;
}

export async function uploadBlob(
  filename: string,
  buffer: Buffer,
  contentType: string,
  opts: UploadOpts = {},
): Promise<UploadResult> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    // Hard-fail in production: silently switching to a `data:` URL on
    // a real deploy hides a misconfiguration that would otherwise
    // leak base64 bytes into Telegram messages and DB rows. We only
    // tolerate the fallback in dev / test where the noise is fine.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('BLOB_READ_WRITE_TOKEN unset in production');
    }
    // Dev / CI fallback. The data URL keeps the round-trip honest:
    // callers get back a string that can be served / clicked, and the
    // ZIP / PDF bytes round-trip intact through base64.
    const b64 = buffer.toString('base64');
    return {
      url: `data:${contentType};base64,${b64}`,
      size: buffer.length,
    };
  }

  // `put` accepts string | Blob | ArrayBuffer | Buffer. The Vercel SDK's
  // type definitions accept Buffer in Node runtime; if a future SDK
  // version tightens that, we can wrap with `new Blob([buffer])`.
  const result = await put(filename, buffer, {
    access: opts.access ?? 'public',
    contentType,
    addRandomSuffix: opts.addRandomSuffix ?? false,
    allowOverwrite: true,
    cacheControlMaxAge: opts.cacheControlMaxAge,
    token,
  });

  return {
    url: result.url,
    size: buffer.length,
  };
}
