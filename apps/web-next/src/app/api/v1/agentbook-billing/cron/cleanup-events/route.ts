import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { requireCronSecret } from '@/lib/cron-auth';

// Auth: the shared fail-closed helper. This route used to authorise on
// `x-vercel-cron: 1` ALONE — an ordinary inbound header any caller can send —
// with the secret as a mere alternative. Since vercel.json's cron config
// carries no `?secret=`, that header was the only live auth path. The helper
// accepts the `Authorization: Bearer` Vercel attaches to a cron invocation.


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


async function handle(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;
  const cutoff = new Date(Date.now() - 90 * 86400_000);
  const result = await prisma.billEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return NextResponse.json({ ok: true, deleted: result.count });
}

export const POST = handle;
export const GET = handle;
