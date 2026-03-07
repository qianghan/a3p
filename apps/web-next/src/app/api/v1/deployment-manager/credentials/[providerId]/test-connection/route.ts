import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';
import { getSecret } from '@/lib/deployment-manager/secrets';
import { setCurrentUserId } from '@/lib/deployment-manager/provider-fetch';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { providerId } = await params;
    const { registry } = getServices();

    if (!registry.has(providerId)) {
      return NextResponse.json({ success: false, error: `Unknown provider: ${providerId}` }, { status: 404 });
    }

    const adapter = registry.get(providerId);
    const secretName = adapter.apiConfig.secretNames[0];
    const secret = await getSecret(user.id, providerId, secretName);

    if (!secret) {
      return NextResponse.json({
        success: false,
        error: 'No credentials configured. Please save your API key first.',
        data: { connected: false, provider: providerId },
      }, { status: 400 });
    }

    setCurrentUserId(user.id);
    try {
      const testPath = adapter.apiConfig.healthCheckPath || '/';
      const start = Date.now();
      const res = await fetch(
        `${adapter.apiConfig.upstreamBaseUrl}${testPath}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(adapter.apiConfig.authHeaderTemplate
              ? { [adapter.apiConfig.authHeaderName || 'Authorization']: adapter.apiConfig.authHeaderTemplate.replace('{{secret}}', secret) }
              : {}),
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      const latencyMs = Date.now() - start;

      const isAuthError = res.status === 401 || res.status === 403;

      return NextResponse.json({
        success: true,
        data: {
          success: res.ok,
          statusCode: res.status,
          latencyMs,
          provider: adapter.displayName,
          error: isAuthError
            ? 'Authentication failed — check that your API key is correct.'
            : !res.ok ? `Provider returned ${res.status}` : undefined,
        },
      });
    } catch (err: any) {
      return NextResponse.json({
        success: true,
        data: {
          success: false,
          provider: adapter.displayName,
          error: err.name === 'TimeoutError' ? 'Connection timed out (15s)' : err.message,
        },
      });
    } finally {
      setCurrentUserId(null);
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
