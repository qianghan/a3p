import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const MAX_BYTES = 2 * 1024 * 1024; // 2MB

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: 'multipart/form-data required' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file field required' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: 'file must be PNG, JPEG, SVG, or WebP' },
      { status: 400 },
    );
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'file exceeds 2MB limit' }, { status: 413 });
  }

  const ext = file.type.split('/')[1].replace('svg+xml', 'svg');
  const filename = `logos/${tenantId}-${Date.now()}.${ext}`;

  const blob = await put(filename, Buffer.from(bytes), {
    access: 'public',
    contentType: file.type,
  });

  return NextResponse.json({ url: blob.url });
}
