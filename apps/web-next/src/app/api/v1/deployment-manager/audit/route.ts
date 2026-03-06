import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';

export async function GET(request: NextRequest) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const sp = request.nextUrl.searchParams;
    const { audit } = getServices();
    const result = await audit.query({
      deploymentId: sp.get('deploymentId') || undefined,
      userId: sp.get('userId') || undefined,
      action: sp.get('action') || undefined,
      limit: sp.get('limit') ? parseInt(sp.get('limit')!, 10) : 50,
      offset: sp.get('offset') ? parseInt(sp.get('offset')!, 10) : 0,
    });
    return NextResponse.json({ success: true, data: result.data, total: result.total });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
