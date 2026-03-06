import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { providerId } = await params;

    const connector = await prisma.serviceConnector.findFirst({
      where: { slug: { contains: providerId } },
    });

    if (!connector) {
      return NextResponse.json({ success: true, data: { configured: false, providerId } });
    }

    const authCfg = connector.authConfig as Record<string, unknown> | null;
    const hasAuth = authCfg && Object.keys(authCfg).length > 0 && authCfg.type !== 'none';
    return NextResponse.json({
      success: true,
      data: {
        configured: !!hasAuth,
        providerId,
        connectorSlug: connector.slug,
        maskedValue: hasAuth ? '••••••••' : undefined,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { providerId } = await params;
    const body = await request.json();
    const { apiKey } = body;

    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'apiKey is required' }, { status: 400 });
    }

    const connector = await prisma.serviceConnector.findFirst({
      where: { slug: { contains: providerId } },
    });

    if (!connector) {
      return NextResponse.json({ success: false, error: `No connector found for provider: ${providerId}` }, { status: 404 });
    }

    await prisma.serviceConnector.update({
      where: { id: connector.id },
      data: {
        authConfig: { type: 'api-key', value: apiKey },
      },
    });

    return NextResponse.json({ success: true, data: { configured: true, providerId } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
