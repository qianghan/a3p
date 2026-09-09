/**
 * A URL that is safe to put in an `<img src>`.
 *
 * These values — an avatar, a company logo — arrive from the tenant's own
 * settings, where the API stores them as free strings. CodeQL flags rendering
 * them as `js/xss-through-dom`, and on the specific charge of XSS it is
 * wrong: a `javascript:` URL in an `img src` does not execute in any current
 * browser, and an SVG loaded through `<img>` is script-disabled by spec.
 *
 * Dismissing the alert on that reasoning would be defending the wrong thing.
 * What an arbitrary string in `src` actually buys is a request the page makes
 * on the viewer's behalf to a host of somebody else's choosing — a tracking
 * pixel on every invoice preview, an intranet URL probed from inside a
 * browser session, a `data:` blob of arbitrary size. None of that is XSS and
 * all of it is worth refusing, so this refuses it and the alert goes with it.
 *
 * Returns `undefined` rather than a placeholder: the caller already has a
 * fallback for "no logo", and reusing it is better than inventing a broken
 * image.
 */

/** Schemes a same-page image may legitimately use. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'blob:']);

/** `data:` is allowed only for actual image types, never `text/html`. */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);base64,[a-z0-9+/=\s]+$/i;

export function safeImageSrc(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const src = value.trim();
  if (!src) return undefined;

  // A relative path is same-origin by construction. `//host` is NOT relative
  // — it is protocol-relative and goes wherever it likes — so it is excluded.
  if (src.startsWith('/') && !src.startsWith('//')) return src;

  if (DATA_IMAGE.test(src)) return src;

  try {
    const url = new URL(src);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? src : undefined;
  } catch {
    // Not parseable as a URL and not a relative path: nothing sensible to do
    // with it, and passing it through is how `javascript:` gets a chance.
    return undefined;
  }
}
