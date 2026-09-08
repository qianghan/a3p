/**
 * What must never leave this process in an error report.
 *
 * AgentBook holds bank connections, invoice amounts, tax positions and
 * government identifiers. An error tracker is a third-party system with its
 * own retention, its own access list and its own breach surface, so the
 * default has to be that it receives the shape of a failure and not its
 * contents. Sentry's own `sendDefaultPii: false` covers cookies, headers and
 * IP; it does not cover a query string, a URL path segment, or a context bag
 * that happens to carry a value.
 *
 * This module is shared by the server, edge and browser SDK configs so there
 * is exactly one answer to the question, and it imports no Sentry types so it
 * can be tested directly and cannot break on an SDK version bump.
 */

/**
 * Keys whose VALUE is removed outright, in two tiers.
 *
 * Deliberately broad: the cost of redacting something harmless is a slightly
 * less useful error report, and the cost of missing something is a customer's
 * bank token sitting in a third-party system.
 *
 * But breadth has a failure mode in the other direction, and a plain
 * substring match hits it hard. The short identity abbreviations are
 * substrings of ordinary English: `sin` is inside `businessName` and
 * `businessType` — a field this codebase branches on constantly — `card` is
 * inside `discardedAt` and `cardinality`, `auth` is inside `author`, `ein` is
 * inside `einvoice`. Redacting those does not protect anyone; it just makes
 * the report useless in exactly the cases someone is reading it.
 *
 * So: long unambiguous terms match anywhere in the key, and short ambiguous
 * ones match only as a whole word.
 */
const SENSITIVE_SUBSTRINGS = [
  'token', 'secret', 'password', 'passwd', 'apikey', 'credential', 'cookie',
  'session', 'signature', 'private', 'accountnumber', 'routing', 'iban',
  'sortcode', 'cvv', 'taxid', 'taxfilenumber', 'socialinsurance',
  'socialsecurity', 'birth', 'address', 'phone', 'email', 'authorization',
  'authtoken', 'bearer',
];

/** Matched only as a complete word — see the note above. */
const SENSITIVE_WORDS = [
  // `ssn` is here rather than above because it is a substring of ordinary
  // words once separators are stripped: `businessName` flattens to
  // `busine-ssn-ame`. Every abbreviation short enough to collide lives here.
  'sin', 'ssn', 'abn', 'tfn', 'ein', 'dob', 'card', 'auth', 'bsb', 'cvc',
  'pan', 'iban',
];

export const REDACTED = '[redacted]';

/**
 * Split a key into words across every convention this codebase and HTTP use:
 * `X-Api-Key`, `access_token`, `plaid.accessToken`, `taxFileNumber`.
 */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  // Normalise separators so `api_key`, `api-key` and `apiKey` are one thing.
  const flat = key.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (SENSITIVE_SUBSTRINGS.some((p) => flat.includes(p))) return true;
  return words(key).some((w) => SENSITIVE_WORDS.includes(w));
}

export function scrubUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const path = url.slice(0, qIndex);
  const rest = url.slice(qIndex + 1);
  const hashIndex = rest.indexOf('#');
  const query = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  if (!query) return path;
  const keys = query.split('&').map((pair) => pair.split('=')[0]).filter(Boolean);
  return keys.length ? `${path}?${keys.map((k) => `${k}=${REDACTED}`).join('&')}` : path;
}

/**
 * Redact sensitive values in a context bag, recursing into plain objects.
 *
 * Depth- and width-limited because an error's context can carry a Prisma
 * result or a request object with cycles, and a stack overflow inside the
 * error reporter would take down the request it was trying to describe.
 */
export function scrubContext(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubContext(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : scrubContext(v, depth + 1);
  }
  return out;
}

/**
 * Sentry `beforeSend` — the last gate before an event leaves the process.
 *
 * Typed loosely on purpose: see the module note about not importing the SDK.
 */
export function beforeSend(event: Record<string, any>): Record<string, any> | null {
  if (event.request) {
    if (typeof event.request.url === 'string') event.request.url = scrubUrl(event.request.url);
    // A request body is never diagnostic enough to justify sending it from a
    // product that receives receipts, bank transactions and tax filings.
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      for (const k of Object.keys(event.request.headers)) {
        if (isSensitiveKey(k)) event.request.headers[k] = REDACTED;
      }
    }
    if (event.request.query_string) event.request.query_string = REDACTED;
  }
  if (event.extra) event.extra = scrubContext(event.extra) as Record<string, any>;
  if (event.contexts) event.contexts = scrubContext(event.contexts) as Record<string, any>;
  if (event.tags) {
    for (const k of Object.keys(event.tags)) {
      if (isSensitiveKey(k)) event.tags[k] = REDACTED;
    }
  }
  // `user` would carry an id, email and IP. The tenantId tag that reportError
  // already sets groups errors by customer without identifying a person.
  delete event.user;
  return event;
}
