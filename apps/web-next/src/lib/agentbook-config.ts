/**
 * Centralized URL configuration for the AgentBook web app.
 *
 * All route handlers and server utilities should derive URLs through
 * these helpers instead of hardcoding domain strings.  This eliminates
 * the class of bugs where a stale fallback domain (e.g. the old
 * "a3book.brainliber.com") causes server-to-server fetch failures when
 * no env var is configured.
 *
 * Priority order for the app base URL:
 *   1. AGENTBOOK_HOST    — explicit override (set on Vercel per-project)
 *   2. request.nextUrl.origin — derives from the live incoming request
 *                              (most accurate; use when a NextRequest is
 *                              available, i.e. in route handlers)
 *   3. VERCEL_URL        — auto-set by Vercel per deployment; unique per
 *                          preview deploy, so correct for internal calls
 *   4. NEXTAUTH_URL      — canonical production domain; set in env vars
 *   5. Hard fallback     — agentbook.brainliber.com (production default)
 *
 * For user-facing links sent to external channels (Telegram messages,
 * emails) always use getCanonicalAppUrl() which prefers NEXTAUTH_URL
 * so users see the branded domain, not a preview-deploy hash.
 */

import type { NextRequest } from 'next/server';

/** The production canonical domain — used for user-visible links. */
export const AGENTBOOK_CANONICAL_URL =
  process.env.NEXTAUTH_URL ?? 'https://agentbook.brainliber.com';

/**
 * Returns the best base URL for internal server-to-server calls.
 * Pass the incoming `request` whenever you have it (route handlers).
 * Omit it for background tasks (cron, Telegram webhook helpers) where
 * no request object is in scope.
 */
export function getAppBaseUrl(request?: NextRequest): string {
  if (process.env.AGENTBOOK_HOST) return process.env.AGENTBOOK_HOST;
  if (request) return request.nextUrl.origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return AGENTBOOK_CANONICAL_URL;
}

/**
 * Build the cross-plugin baseUrls map the agent brain expects.
 * Each plugin prefix maps to the host that serves its routes.
 *
 * In production (Vercel) all plugins live on the same host so every
 * prefix resolves to `appBase`.  In local dev the env vars point to
 * the individual backend servers on different ports.
 */
export function getPluginBaseUrls(appBase: string): Record<string, string> {
  return {
    '/api/v1/agentbook-core':    process.env.AGENTBOOK_CORE_URL    ?? appBase,
    '/api/v1/agentbook-expense': process.env.AGENTBOOK_EXPENSE_URL ?? appBase,
    '/api/v1/agentbook-invoice': process.env.AGENTBOOK_INVOICE_URL ?? appBase,
    '/api/v1/agentbook-tax':     process.env.AGENTBOOK_TAX_URL     ?? appBase,
  };
}
