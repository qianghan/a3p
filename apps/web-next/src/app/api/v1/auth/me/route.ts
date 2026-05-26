/**
 * GET /api/v1/auth/me
 * Get current user and CSRF token
 */

import {NextRequest, NextResponse } from 'next/server';
import { validateSessionWithExpiry } from '@/lib/api/auth';
import { success, errors, getAuthToken, isDatabaseError } from '@/lib/api/response';
import { createSessionCSRFToken } from '@/lib/api/csrf';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getAuthToken(request);

    if (!token) {
      return errors.unauthorized('No auth token provided');
    }

    const result = await validateSessionWithExpiry(token);

    if (!result) {
      return errors.unauthorized('Invalid or expired session');
    }

    // Generate CSRF token tied to this session
    const csrfToken = createSessionCSRFToken(token);

    return success({
      user: result.user,
      expiresAt: result.expiresAt.toISOString(),
      csrfToken,
    });
  } catch (err) {
    // Mirror /auth/login: surface DB-unavailable as 503 instead of 500. The
    // client (RequireAuth) treats 5xx as "show error UI", but a 503 is more
    // accurate for ops alerting + log-aggregation triage. 500 implies code
    // bug; 503 implies infrastructure outage.
    if (isDatabaseError(err)) {
      const dbErr = err as Error & { code?: string };
      console.error(`[AUTH] /me database error: ${dbErr.name}: ${dbErr.message}`);
      return errors.serviceUnavailable(
        'Authentication temporarily unavailable. Please try again in a moment.',
      );
    }
    console.error('Auth me error:', err);
    return errors.internal('Failed to get user info');
  }
}
