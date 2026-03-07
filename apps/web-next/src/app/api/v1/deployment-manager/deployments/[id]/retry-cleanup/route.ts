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
    const { orchestrator } = getServices();
    const record = await orchestrator.destroy(id, user.id);
    const allClean = record.status === 'DESTROYED';
    return NextResponse.json({
      success: true,
      data: record,
      destroyResult: {
        allClean,
        steps: [{ step: 'retry-cleanup', success: allClean, detail: allClean ? 'Cleanup complete' : record.statusMessage }],
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 });
  }
}
