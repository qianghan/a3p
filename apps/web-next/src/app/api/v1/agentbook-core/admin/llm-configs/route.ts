/**
 * Admin LLM provider configs — list + create.
 *
 * Gated by requireAdmin (role 'admin'/'system:admin' OR ADMIN_EMAILS allowlist).
 * apiKey is always redacted on read (last 4 chars only).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin, redactApiKey } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  try {
    const configs = await db.abLLMProviderConfig.findMany({ orderBy: { createdAt: 'asc' } });
    const dbItems = configs.map((c) => ({ ...c, apiKey: redactApiKey(c.apiKey), source: 'db' as const }));

    // The app runs on Gemini via the GEMINI_API_KEY environment variable
    // (receipt scanning, the agent brain, document parsers, etc. all read it
    // directly), which has no AbLLMProviderConfig row. Surface it as a
    // read-only "environment" provider so the admin page reflects the LLM
    // that's actually live — otherwise the active provider is invisible here.
    const items: Array<Record<string, unknown>> = [];
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey) {
      const hasEnabledDbDefault = dbItems.some((c) => c.isDefault && c.enabled);
      const fast = process.env.GEMINI_MODEL_FAST || 'gemini-2.0-flash';
      items.push({
        id: 'env:gemini',
        name: 'Google Gemini (environment)',
        provider: 'gemini',
        apiKey: redactApiKey(envKey),
        enabled: true,
        // The env provider is the effective default unless a DB provider is set default.
        isDefault: !hasEnabledDbDefault,
        modelFast: fast,
        modelStandard: process.env.GEMINI_MODEL_STANDARD || fast,
        modelPremium: process.env.GEMINI_MODEL_PREMIUM || 'gemini-2.5-pro',
        modelVision: process.env.GEMINI_MODEL_VISION || 'gemini-2.5-flash',
        source: 'env',
      });
    }
    items.push(...dbItems);
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[agentbook-core/admin/llm-configs GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface CreateBody {
  name?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  modelFast?: string;
  modelStandard?: string;
  modelPremium?: string;
  modelVision?: string;
  isDefault?: boolean;
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  try {
    const body = (await request.json().catch(() => ({}))) as CreateBody;
    const { name, provider, apiKey, baseUrl, modelFast, modelStandard, modelPremium, modelVision, isDefault } = body;
    if (!name || !provider || !apiKey) {
      return NextResponse.json(
        { success: false, error: 'name, provider, apiKey are required' },
        { status: 400 },
      );
    }

    if (isDefault) {
      await db.abLLMProviderConfig.updateMany({ data: { isDefault: false } });
    }

    const config = await db.abLLMProviderConfig.create({
      data: {
        name,
        provider,
        apiKey,
        baseUrl,
        modelFast,
        modelStandard,
        modelPremium,
        modelVision,
        isDefault: isDefault || false,
      },
    });
    // Redact apiKey on the create confirmation echo too.
    return NextResponse.json(
      { success: true, data: { ...config, apiKey: redactApiKey(config.apiKey) } },
      { status: 201 },
    );
  } catch (err) {
    console.error('[agentbook-core/admin/llm-configs POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
