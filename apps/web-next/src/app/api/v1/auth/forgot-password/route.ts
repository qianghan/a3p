/**
 * POST /api/v1/auth/forgot-password
 * Request password reset email
 */

import {NextRequest, NextResponse } from 'next/server';
import { requestPasswordReset } from '@/lib/api/auth';
import { success, errors } from '@/lib/api/response';
import { enforceRateLimit } from '@/lib/api/rate-limit';

export async function POST(request: NextRequest): Promise<NextResponse | Response> {
  // Rate limit: 3 requests per 15 minutes per IP. Same limits as before, but via
  // the shared (database) store — the previous in-process Map was per-serverless
  // -instance, so this cap was not actually enforced in production.
  const limited = await enforceRateLimit(request, {
    keyPrefix: 'auth:forgot-password',
    maxRequests: 3,
    windowMs: 900_000,
  });
  if (limited) return limited;

  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return errors.badRequest('Email is required');
    }

    const result = await requestPasswordReset(email);

    return success({
      message: result.message,
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return success({
      message: 'If an account exists, a reset link has been sent.',
    });
  }
}
