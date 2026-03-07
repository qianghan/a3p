import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getAuthToken } from '@/lib/api/response';
import { getServices } from '@/lib/deployment-manager';
import type { ArtifactDefinition } from '@/lib/deployment-manager/services/ArtifactRegistry';

const ARTIFACT_ICONS: Record<string, string> = {
  'ai-runner': '\u{1F916}',
  'livepeer-inference': '\u{1F517}',
  scope: '\u{1F52D}',
};

function toTemplate(a: ArtifactDefinition) {
  return {
    id: a.type,
    name: a.displayName,
    description: a.description,
    icon: ARTIFACT_ICONS[a.type] || '\u{1F4E6}',
    dockerImage: a.dockerImage,
    healthEndpoint: a.healthEndpoint,
    healthPort: a.defaultPort,
    defaultGpuModel: null,
    defaultGpuVramGb: null,
    category: 'curated' as const,
  };
}

export async function GET(request: NextRequest) {
  try {
    const token = getAuthToken(request);
    if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const user = await validateSession(token);
    if (!user) return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });

    const { artifactRegistry } = getServices();
    const artifacts = artifactRegistry.getArtifacts();
    const templates = artifacts.map(toTemplate);
    return NextResponse.json({ success: true, data: templates });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
