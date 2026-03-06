import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { type } = await params;
    const { artifactRegistry } = getServices();
    const latest = await artifactRegistry.getLatestVersion(type);
    if (!latest) return NextResponse.json({ success: false, error: 'No releases found' }, { status: 404 });
    return NextResponse.json({ success: true, data: latest });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
