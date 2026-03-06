import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { id } = await params;
    const { orchestrator, usageService } = getServices();
    const deployment = await orchestrator.get(id);
    if (!deployment) return NextResponse.json({ success: false, error: 'Deployment not found' }, { status: 404 });
    if (!deployment.endpointUrl) return NextResponse.json({ success: false, error: 'No endpoint URL' }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const start = Date.now();
    try {
      const proxyRes = await fetch(deployment.endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const responseTimeMs = Date.now() - start;
      const responseBody = await proxyRes.text();
      const outcome = proxyRes.ok ? 'completed' : 'failed';
      await usageService.record(id, outcome, responseTimeMs);

      let parsedResponse;
      try { parsedResponse = JSON.parse(responseBody); } catch { parsedResponse = responseBody; }

      return NextResponse.json({
        success: proxyRes.ok,
        data: {
          statusCode: proxyRes.status,
          responseTimeMs,
          body: parsedResponse,
        },
      }, { status: proxyRes.ok ? 200 : 502 });
    } catch (err: any) {
      const responseTimeMs = Date.now() - start;
      await usageService.record(id, 'failed', responseTimeMs);
      return NextResponse.json({
        success: false,
        error: err.name === 'TimeoutError' ? 'Request timed out (60s)' : err.message,
        data: { responseTimeMs },
      }, { status: 504 });
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
