import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { id } = await params;
    const range = request.nextUrl.searchParams.get('range') || request.nextUrl.searchParams.get('period') || 'hour';
    const period = (range === 'day' ? 'day' : 'hour') as 'hour' | 'day';
    const { usageService } = getServices();
    const stats = await usageService.getStats(id, period);

    const totalCompleted = stats.buckets.reduce((s, b) => s + b.completed, 0);
    const totalFailed = stats.buckets.reduce((s, b) => s + b.failed, 0);
    const totalRetried = stats.buckets.reduce((s, b) => s + b.retried, 0);
    const totalRequests = totalCompleted + totalFailed + totalRetried;

    return NextResponse.json({
      success: true,
      data: {
        ...stats,
        totalRequests,
        totalCompleted,
        totalFailed,
        totalRetried,
        avgResponseTimeMs: 0,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
