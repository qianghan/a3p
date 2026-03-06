import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';

export async function POST(request: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
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
    try {
      await adapter.getGpuOptions();
      return NextResponse.json({ success: true, data: { connected: true, provider: providerId } });
    } catch (err: any) {
      return NextResponse.json({
        success: false,
        error: `Connection failed: ${err.message}`,
        data: { connected: false, provider: providerId },
      }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
