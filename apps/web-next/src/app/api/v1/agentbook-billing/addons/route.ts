import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const addOns = await prisma.billAddOn.findMany({
    where: { isActive: true },
    include: { prices: { where: { isActive: true } } },
  });
  return NextResponse.json({ addOns });
}
