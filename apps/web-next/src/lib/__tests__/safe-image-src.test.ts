import { describe, it, expect } from 'vitest';
import { safeImageSrc } from '../safe-image-src';

/**
 * What may go in an `<img src>`.
 *
 * CodeQL files the four call sites as `js/xss-through-dom`, and on the
 * specific charge of XSS it is wrong: `javascript:` in an `img src` does not
 * execute in any current browser, and an SVG loaded through `<img>` is
 * script-disabled by spec. Dismissing on that reasoning would defend the
 * wrong thing — an arbitrary string in `src` still buys a request the page
 * makes on the viewer's behalf to a host of somebody else's choosing.
 */

describe('what it lets through', () => {
  it.each([
    'https://cdn.example.com/logo.png',
    'http://localhost:3000/logo.png',
    '/uploads/logo.png',
    'blob:https://agentbook.example/9f2c-…',
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  ])('accepts %s', (u) => {
    expect(safeImageSrc(u)).toBe(u);
  });

  it('accepts a blob: URL, which the old per-file helper silently dropped', () => {
    // That helper allowed http/https only, so an avatar the user had just
    // picked from disk was rejected and the preview stayed empty. The bug was
    // invisible because the fallback initial renders in its place.
    expect(safeImageSrc('blob:https://x/abc')).toBeTruthy();
  });
});

describe('what it refuses', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:application/javascript,alert(1)',
    'file:///etc/passwd',
  ])('refuses %s', (u) => {
    expect(safeImageSrc(u)).toBeUndefined();
  });

  it('refuses a protocol-relative URL', () => {
    // `//evil.example/x.png` LOOKS like a path and is not one — it inherits
    // the page protocol and goes wherever it likes.
    expect(safeImageSrc('//evil.example/x.png')).toBeUndefined();
    expect(safeImageSrc('/uploads/ok.png')).toBe('/uploads/ok.png');
  });

  it('refuses data: that only claims to be an image', () => {
    expect(safeImageSrc('data:image/png,<script>alert(1)</script>')).toBeUndefined();
  });

  it('returns undefined for nothing at all, so the caller falls back', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(safeImageSrc(v)).toBeUndefined();
    }
  });

  it('is not fooled by leading whitespace', () => {
    expect(safeImageSrc('  javascript:alert(1)')).toBeUndefined();
  });
});
