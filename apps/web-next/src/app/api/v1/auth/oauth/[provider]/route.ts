/**
 * GET /api/v1/auth/oauth/:provider
 * Get OAuth authorization URL
 */

import {NextRequest, NextResponse } from 'next/server';
import { getOAuthUrl, generateCSRFToken } from '@/lib/api/auth';
import { success, errors } from '@/lib/api/response';

interface RouteParams {
  params: Promise<{ provider: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { provider } = await params;

    if (provider !== 'google' && provider !== 'github' && provider !== 'microsoft') {
      return errors.badRequest('Invalid OAuth provider');
    }

    // Generate state parameter for CSRF protection
    const state = generateCSRFToken();

    const url = getOAuthUrl(provider, state);

    if (!url) {
      return errors.badRequest(`OAuth provider ${provider} is not configured`);
    }

    // Whether the ORIGINAL authorization request came from an installed/
    // standalone PWA (see auth-context.tsx loginWithOAuth). Recorded in a
    // cookie so the callback route (Task 3) can tell how to complete the
    // redirect without the round-trip losing that context.
    const standalone = request.nextUrl.searchParams.get('standalone') === '1';

    // Store state in cookie for verification on callback
    const response = success({ url });

    response.cookies.set('oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    });

    if (standalone) {
      response.cookies.set('oauth_standalone', '1', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 10,
        path: '/',
      });
    } else {
      // Explicitly clear any leftover cookie from an abandoned standalone
      // attempt — on cookie-jar-sharing platforms (Android/desktop), a
      // stale '1' here would otherwise misroute this unrelated, ordinary
      // sign-in to the /signed-in interstitial instead of straight to
      // /agentbook.
      response.cookies.set('oauth_standalone', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 0,
        path: '/',
      });
    }

    return response;
  } catch (err) {
    console.error('OAuth URL error:', err);
    return errors.internal('Failed to generate OAuth URL');
  }
}
