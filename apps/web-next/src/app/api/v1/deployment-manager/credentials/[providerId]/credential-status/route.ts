import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { getServices } from '@/lib/deployment-manager';

export async function GET(
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

    const adapter = registry.get(providerId);
    const connector = await prisma.serviceConnector.findFirst({
      where: { slug: { contains: providerId } },
    });

    if (!connector) {
      const secretName = adapter.authMethod === 'token' ? 'bearer-token' : 'api-key';
      return NextResponse.json({
        success: true,
        data: {
          configured: false,
          secrets: [{ name: secretName, configured: false }],
        },
      });
    }

    const authCfg = connector.authConfig as Record<string, unknown> | null;
    const hasAuth = authCfg && Object.keys(authCfg).length > 0 && authCfg.type !== 'none';
    const secretName = adapter.authMethod === 'token' ? 'bearer-token' : 'api-key';

    return NextResponse.json({
      success: true,
      data: {
        configured: !!hasAuth,
        secrets: [{
          name: secretName,
          configured: !!hasAuth,
          maskedValue: hasAuth ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : undefined,
        }],
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
