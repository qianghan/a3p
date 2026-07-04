import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { hasAddOn, checkQuota, incrementUsage } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getJurisdictionPack } from '@agentbook/jurisdictions';
import { buildExtractionPrompt, parseExtractionJson } from '@/lib/agentbook-startup/document-extraction';
import '@/lib/agentbook-startup/discovery';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  if (!(await hasAddOn(tenantId, 'startup_tax_benefits'))) {
    return NextResponse.json({ error: 'Startup Tax Benefits add-on required' }, { status: 402 });
  }

  const quota = await checkQuota(tenantId, 'ocr_scans');
  if (!quota.allowed) {
    return NextResponse.json({ error: 'OCR scan quota exceeded for this billing period' }, { status: 429 });
  }

  const { id } = await params;
  const application = await prisma.startupBenefitApplication.findFirst({ where: { id, tenantId } });
  if (!application) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const form = await request.formData();
  const file = form.get('file');
  const docType = form.get('docType');
  // Duck-typed rather than `instanceof File` — the test environment's jsdom
  // File and undici's parsed multipart File are different classes across
  // realms even though both report constructor.name === 'File'.
  const isFileLike = (v: unknown): v is File =>
    !!v && typeof v === 'object' && 'arrayBuffer' in v && typeof (v as { arrayBuffer: unknown }).arrayBuffer === 'function';
  if (!isFileLike(file) || typeof docType !== 'string') {
    return NextResponse.json({ error: 'file and docType are required' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let blobUrl = '';
  try {
    const { put } = await import('@vercel/blob');
    const safeName = (file.name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`startup-benefit-docs/${tenantId}/${application.id}/${Date.now()}-${safeName}`, bytes, {
      access: 'public',
      addRandomSuffix: true,
    });
    blobUrl = blob.url;
  } catch (err) {
    console.warn('[agentbook-startup/documents] blob store unavailable:', err);
  }

  const program = await prisma.startupBenefitProgram.findUnique({ where: { id: application.programId } });
  const requirement = program
    ? getJurisdictionPack(program.jurisdiction)?.taxBenefits?.getRequiredDocuments(program.programCode).find((r) => r.docType === docType)
    : undefined;

  let extractedData: Record<string, unknown> = {};
  const apiKey = process.env.GEMINI_API_KEY;
  const ocrAttempted = Boolean(apiKey && requirement);
  if (ocrAttempted) {
    const prompt = buildExtractionPrompt(docType, requirement!);
    const model = process.env.GEMINI_MODEL_VISION || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: file.type || 'application/pdf', data: bytes.toString('base64') } }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
        }),
      });
      if (res.ok) {
        const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) extractedData = parseExtractionJson(docType, text);
      }
    } catch (err) {
      console.warn('[agentbook-startup/documents] OCR failed:', err);
    }
  }

  const document = await prisma.startupBenefitDocument.create({
    data: { applicationId: application.id, docType, blobUrl, extractedData, status: 'uploaded' },
  });

  // Only spend the ocr_scans quota unit when an OCR attempt actually ran —
  // an unmatched/mistyped docType or missing GEMINI_API_KEY skips the Gemini
  // call above and must not be charged.
  if (ocrAttempted) {
    void incrementUsage(tenantId, 'ocr_scans', 1).catch(() => {});
  }

  return NextResponse.json({ document });
}
