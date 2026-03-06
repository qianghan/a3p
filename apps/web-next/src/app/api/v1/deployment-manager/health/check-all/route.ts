import { NextRequest, NextResponse } from 'next/server';
import { getServices } from '@/lib/deployment-manager';

export async function POST(request: NextRequest) {
  try {
    if (process.env.VERCEL) {
      const authHeader = request.headers.get('authorization');
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    const { healthMonitor } = getServices();
    await healthMonitor.checkAll();
    return NextResponse.json({ success: true, message: 'Health check completed' });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
