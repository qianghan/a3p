import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { getServices } from '@/lib/deployment-manager';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { providerId } = await params;
    const { registry } = getServices();

    if (!registry.has(providerId)) {
      return NextResponse.json({ success: false, error: `Provider not found: ${providerId}` }, { status: 404 });
    }

    const body = await request.json();
    const secretValues: Record<string, string> = body.secrets;

    if (!secretValues || typeof secretValues !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Body must contain { secrets: { name: value } }' },
        { status: 400 },
      );
    }

    const apiKey = Object.values(secretValues)[0];
    if (!apiKey || !apiKey.trim()) {
      return NextResponse.json(
        { success: false, error: 'Secret value cannot be empty' },
        { status: 400 },
      );
    }

    const connector = await prisma.serviceConnector.findFirst({
      where: { slug: { contains: providerId } },
    });

    if (!connector) {
      return NextResponse.json(
        { success: false, error: `No connector found for provider: ${providerId}. Ensure the service-gateway connector is configured.` },
        { status: 404 },
      );
    }

    await prisma.serviceConnector.update({
      where: { id: connector.id },
      data: {
        authConfig: { type: 'api-key', value: apiKey },
      },
    });

    const adapter = registry.get(providerId);
    return NextResponse.json({
      success: true,
      data: {
        message: `Credentials saved for ${adapter.displayName}`,
        savedSecrets: Object.keys(secretValues),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
