/**
 * Receipt-fetch SSRF guard.
 *
 * The implementation moved to @naap/utils so the Express plugin backends can
 * use the same one — they cannot import from this app, so they were fetching
 * caller-supplied URLs with no guard at all (CodeQL `js/request-forgery`,
 * critical, two sites). Duplicating a security control is how the copies end
 * up disagreeing.
 *
 * This file stays as the re-export so existing imports and tests are
 * unaffected by where the code lives.
 */
export {
  isAllowedReceiptUrl,
  fetchReceipt,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  type SafeFetchOptions,
} from '@naap/utils/safe-fetch';
