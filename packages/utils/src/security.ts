/**
 * Shared security utilities for NAAP platform services and plugins.
 *
 * Consolidates common security patterns (path traversal prevention,
 * log injection sanitization, rate limiting, URL validation) so every
 * service uses the same proven guards.
 */

import path from 'path';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Path Traversal Prevention
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path within a base directory, rejecting any
 * traversal that escapes it.  Throws on violation.
 *
 * @example
 * const safe = safeResolvePath('/data/uploads', userInput);
 * await fs.readFile(safe);
 */
export function safeResolvePath(base: string, userPath: string): string {
  const resolvedBase = path.resolve(base);
  const resolvedPath = path.resolve(base, userPath);
  if (
    resolvedPath !== resolvedBase &&
    !resolvedPath.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error(`Path traversal blocked: ${userPath}`);
  }
  return resolvedPath;
}

/**
 * Sanitize a single path component (file/directory name).
 * Rejects anything containing path separators or parent-directory references.
 */
export function sanitizePathComponent(component: string): string {
  const sanitized = component.replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!sanitized || sanitized !== component) {
    throw new Error(`Invalid path component: ${component}`);
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Log Injection Prevention
// ---------------------------------------------------------------------------

/**
 * Strip control characters from a value before interpolating it into
 * log messages or template strings, preventing log injection / format
 * string attacks.
 */
export function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\n\r\t\x00-\x1f\x7f-\x9f]/g, '');
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

const rateLimitStores = new Map<string, Map<string, { count: number; resetTime: number }>>();

/**
 * Create an Express rate-limiting middleware backed by an in-memory store.
 *
 * @param windowMs - Time window in milliseconds
 * @param maxRequests - Maximum requests per IP within the window
 * @param storeName - Optional store name for isolation between limiters
 *
 * @example
 * const apiLimiter = createRateLimiter(15 * 60_000, 100);
 * router.post('/publish', apiLimiter, handler);
 */
export function createRateLimiter(
  windowMs: number,
  maxRequests: number,
  storeName = 'default',
) {
  if (!rateLimitStores.has(storeName)) {
    rateLimitStores.set(storeName, new Map());
  }
  const store = rateLimitStores.get(storeName)!;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();

    // Prune expired entries when the store grows large to prevent memory leaks
    if (store.size > 10_000) {
      for (const [ip, value] of store) {
        if (now > value.resetTime) store.delete(ip);
      }
    }

    const entry = store.get(key);

    if (!entry || now > entry.resetTime) {
      store.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }
    if (entry.count >= maxRequests) {
      return res
        .status(429)
        .json({ error: 'Too many requests, please try again later' });
    }
    entry.count++;
    return next();
  };
}

// ---------------------------------------------------------------------------
// URL Validation
// ---------------------------------------------------------------------------

/**
 * Validate a URL string, returning the parsed URL only when the protocol
 * is http: or https:.  Returns `null` for invalid or dangerous URLs
 * (e.g. `javascript:`, `data:`, `file:`).
 */
export function parseSafeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether a hostname is in an allowlist, supporting exact match
 * and subdomain match.  Safe against prefix-spoofing attacks
 * (e.g. "evil-example.com" won't match "example.com").
 */
export function isAllowedHost(
  hostname: string,
  allowedHosts: string[],
): boolean {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  return allowedHosts.some((h) => {
    const nh = h.trim().replace(/\.$/, '').toLowerCase();
    return normalized === nh || normalized.endsWith(`.${nh}`);
  });
}

// ── SSRF: one notion of "private" for every guard in the repo ──
//
// Lived in the service-gateway's own types file, which meant the Express
// plugin backends could not reach it and fetched caller-supplied URLs with no
// check at all. Moved here so every caller agrees. The gateway itself has
// since been deleted along with the rest of the inherited NaaP code; this
// outlived it because the receipt fetcher, the dashboard connectivity test
// and the plugin backends all still need it.
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,          // cloud instance metadata — the classic SSRF target
  /^f[cd]00:/i,
  /^fe80:/i,
  /^::1$/,
  /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/i,
  /^::ffff:0:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i,
  /^0{0,4}(::0{0,4}){0,4}:?0{0,3}1$/i,
  /^localhost$/i,
];

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some((pattern) => pattern.test(hostname));
}
