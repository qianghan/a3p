import { db } from './db/client.js';
import { getPastFilingPack } from '@agentbook/jurisdictions/past-filing-loader';
import type { StandardTaxExtract } from '@agentbook/jurisdictions/interfaces';

// ─── Gemini PDF parsing ──────────────────────────────────────────────────────

async function callGeminiWithPdf(
  apiKey: string,
  model: string,
  systemPrompt: string,
  pdfBase64: string,
  maxTokens = 8192,
): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
          { text: 'Extract the tax data from this document as JSON.' },
        ] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.1,
          // Disable thinking for structured extraction: Gemini 2.5 "thinking"
          // models otherwise burn the output-token budget on internal reasoning
          // and truncate the JSON (finishReason MAX_TOKENS). Ignored by models
          // that don't support thinkingConfig.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const parts = data.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    // Concatenate all text parts (a model may split output across parts).
    return parts.map((p: any) => p?.text || '').join('') || null;
  } catch { return null; }
}

function cleanJson(raw: string): string {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Defensive: if there is prose around the JSON, slice to the outermost braces.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function uploadPastFiling(
  tenantId: string,
  pdfBuffer: Buffer,
  taxYear: number,
  jurisdiction: string,
  region?: string,
  formType?: string,
  notes?: string,
): Promise<{ id: string; status: string }> {
  if (!pdfBuffer.slice(0, 5).toString().startsWith('%PDF-')) {
    throw Object.assign(new Error('File must be a PDF'), { status: 400 });
  }

  const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  const timestamp = Date.now();
  const ft = formType || 'unknown';
  const blobKey = `tax-filings/${tenantId}/${taxYear}/${ft}-${timestamp}.pdf`;

  let blobUrl = `local://${blobKey}`;
  if (BLOB_TOKEN) {
    const { put } = await import('@vercel/blob');
    // The provisioned Vercel Blob store is a PUBLIC store, so we cannot request
    // `access: 'private'` (the API rejects it). We keep tax documents protected
    // by: (1) `addRandomSuffix` so the URL is unguessable, (2) never returning
    // blobUrl/blobKey in any API response, and (3) proxying every download
    // through the authenticated `/:id/download` endpoint. Provision a dedicated
    // private Blob store + token to upgrade to true private ACLs later.
    const blob = await put(blobKey, pdfBuffer, {
      access: 'public',
      addRandomSuffix: true,
      token: BLOB_TOKEN,
      contentType: 'application/pdf',
    });
    blobUrl = blob.url;
  }

  const record = await db.abPastTaxFiling.create({
    data: { tenantId, taxYear, jurisdiction, region, formType: ft, blobUrl, blobKey, notes },
  });

  return { id: record.id, status: record.status };
}

// ─── Parse (called async after upload) ──────────────────────────────────────

export async function parsePastFiling(
  tenantId: string,
  filingId: string,
  pdfBuffer: Buffer,
): Promise<void> {
  await db.abPastTaxFiling.update({ where: { id: filingId }, data: { status: 'parsing', errorMsg: null } });

  try {
    const llmConfig = await db.abLLMProviderConfig.findFirst({ where: { enabled: true, isDefault: true } });
    if (!llmConfig || llmConfig.provider !== 'gemini' || !llmConfig.apiKey) {
      await db.abPastTaxFiling.update({ where: { id: filingId }, data: { status: 'error', errorMsg: 'No Gemini config' } });
      return;
    }

    const filing = await db.abPastTaxFiling.findFirst({ where: { id: filingId, tenantId } });
    if (!filing) return;

    const model = (llmConfig as any).modelVision || (llmConfig as any).modelStandard || 'gemini-1.5-pro';
    const pdfBase64 = pdfBuffer.toString('base64');

    // Step 1: identify form type if unknown
    let jurisdiction = filing.jurisdiction;
    let formType = filing.formType;
    let taxYear = filing.taxYear;

    if (formType === 'unknown') {
      const idPrompt = `You are a tax document classifier. Identify this document.
Return JSON only: { "formType": "T1"|"T4"|"T4A"|"NOA"|"T2125"|"1040"|"W-2"|"1099-NEC"|"other", "taxYear": <number>, "jurisdiction": "ca"|"us", "region": "<province or state code>" }`;
      const idRaw = await callGeminiWithPdf(llmConfig.apiKey, model, idPrompt, pdfBase64, 1024);
      if (idRaw) {
        try {
          const id = JSON.parse(cleanJson(idRaw));
          formType = id.formType || formType;
          jurisdiction = id.jurisdiction || jurisdiction;
          taxYear = id.taxYear || taxYear;
          await db.abPastTaxFiling.update({ where: { id: filingId }, data: { formType, jurisdiction, taxYear } });
        } catch { /* keep existing values */ }
      }
    }

    // Step 2: deep extraction via jurisdiction pack
    let pack;
    try { pack = getPastFilingPack(jurisdiction); } catch {
      await db.abPastTaxFiling.update({ where: { id: filingId }, data: { status: 'error', errorMsg: `No pack for jurisdiction: ${jurisdiction}` } });
      return;
    }

    const extractPrompt = pack.extractionPrompt(formType, taxYear);
    const extractRaw = await callGeminiWithPdf(llmConfig.apiKey, model, extractPrompt, pdfBase64, 2048);

    if (!extractRaw) {
      await db.abPastTaxFiling.update({ where: { id: filingId }, data: { status: 'error', errorMsg: 'Gemini returned no response' } });
      return;
    }

    let extract: StandardTaxExtract;
    try {
      extract = pack.parseExtraction(JSON.parse(cleanJson(extractRaw)), formType, taxYear);
    } catch (e) {
      await db.abPastTaxFiling.update({ where: { id: filingId }, data: { status: 'error', errorMsg: `Parse failed: ${String(e).slice(0, 200)}` } });
      return;
    }

    await db.abPastTaxFiling.update({
      where: { id: filingId },
      data: {
        extractedData: extract as any,
        confidence: extract.confidence,
        formType: extract.formType,
        jurisdiction: extract.jurisdiction,
        region: extract.region,
        taxYear: extract.taxYear,
        status: 'confirmed',
      },
    });
  } catch (err) {
    await db.abPastTaxFiling.update({ where: { id: filingId }, data: { status: 'error', errorMsg: String(err).slice(0, 500) } });
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listPastFilings(tenantId: string) {
  return db.abPastTaxFiling.findMany({
    where: { tenantId },
    orderBy: [{ taxYear: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getPastFiling(tenantId: string, id: string) {
  const rec = await db.abPastTaxFiling.findFirst({ where: { id, tenantId } });
  if (!rec) throw Object.assign(new Error('Not found'), { status: 404 });
  return rec;
}

export async function confirmPastFiling(tenantId: string, id: string) {
  const rec = await db.abPastTaxFiling.findFirst({ where: { id, tenantId } });
  if (!rec) throw Object.assign(new Error('Not found'), { status: 404 });
  return db.abPastTaxFiling.update({ where: { id }, data: { status: 'confirmed' } });
}

export async function updatePastFiling(
  tenantId: string,
  id: string,
  patch: { notes?: string; extractedData?: any },
) {
  const rec = await db.abPastTaxFiling.findFirst({ where: { id, tenantId } });
  if (!rec) throw Object.assign(new Error('Not found'), { status: 404 });
  return db.abPastTaxFiling.update({ where: { id }, data: patch });
}

export async function deletePastFiling(tenantId: string, id: string) {
  const rec = await db.abPastTaxFiling.findFirst({ where: { id, tenantId } });
  if (!rec) throw Object.assign(new Error('Not found'), { status: 404 });
  // Delete blob
  const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  if (BLOB_TOKEN && rec.blobKey && !rec.blobUrl.startsWith('local://')) {
    try {
      const { del } = await import('@vercel/blob');
      await del(rec.blobUrl, { token: BLOB_TOKEN });
    } catch { /* blob already gone */ }
  }
  await db.abPastTaxFiling.delete({ where: { id } });
}

// ─── Advisor context ─────────────────────────────────────────────────────────

export async function buildAdvisorContext(tenantId: string, yearsBack = 3): Promise<string> {
  const filings = await db.abPastTaxFiling.findMany({
    where: { tenantId, status: 'confirmed' },
    orderBy: { taxYear: 'desc' },
    take: yearsBack * 4, // up to 4 forms per year
  });
  if (filings.length === 0) return '';

  const byYear = new Map<number, typeof filings>();
  for (const f of filings) {
    if (!byYear.has(f.taxYear)) byYear.set(f.taxYear, []);
    byYear.get(f.taxYear)!.push(f);
  }

  const lines: string[] = ['## Tax History (reference only — do not share raw numbers unless asked)\n'];
  for (const [year, yearFilings] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
    for (const filing of yearFilings) {
      try {
        const pack = getPastFilingPack(filing.jurisdiction);
        const extract = filing.extractedData as any as StandardTaxExtract;
        lines.push(pack.summarize(extract));
      } catch {
        lines.push(`${year} (${filing.jurisdiction.toUpperCase()}): filing uploaded (pack not loaded)`);
      }
    }
  }
  return lines.join('\n');
}

// ─── Pre-fill ────────────────────────────────────────────────────────────────

export async function getPrefillSuggestions(tenantId: string, targetYear: number) {
  const sourceYear = targetYear - 1;
  const filings = await db.abPastTaxFiling.findMany({
    where: { tenantId, taxYear: sourceYear, status: 'confirmed' },
  });

  if (filings.length === 0) return [];

  const suggestions: import('@agentbook/jurisdictions/interfaces').PreFillSuggestion[] = [];
  for (const filing of filings) {
    try {
      const pack = getPastFilingPack(filing.jurisdiction);
      const extract = filing.extractedData as any;
      const packSuggestions = pack.preFillMap(extract);
      suggestions.push(...packSuggestions);
    } catch { /* skip filings whose pack isn't loaded */ }
  }

  // Deduplicate by fieldId — first suggestion wins
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    if (seen.has(s.fieldId)) return false;
    seen.add(s.fieldId);
    return true;
  });
}
