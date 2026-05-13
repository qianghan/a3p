import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(r: NextRequest): boolean {
  return (
    r.headers.get('x-vercel-cron') === '1' ||
    (!!process.env.CRON_SECRET && r.nextUrl.searchParams.get('secret') === process.env.CRON_SECRET)
  );
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const cutoff = new Date(Date.now() - 90 * 86400_000);
  const result = await prisma.billEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return NextResponse.json({ ok: true, deleted: result.count });
}

export const POST = handle;
export const GET = handle;
