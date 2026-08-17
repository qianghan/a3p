/**
 * Tax Filing — session management, auto-populate, completeness tracking.
 */
import { db } from './db/client.js';
import { autoPopulateForm, recomputeCalculatedFields, seedCanadianForms, seedUsForms, seedAuForms } from './tax-forms.js';

// === Helpers ===

/**
 * Topological sort of form templates by their `dependencies` array.
 * Forms with no dependencies come first (e.g. T2125, GST-HST),
 * followed by forms that depend on them (T1, Schedule1).
 */
export function sortByDependencies(templates: any[]): any[] {
  const byCode = new Map<string, any>(templates.map(t => [t.formCode, t]));
  const visited = new Set<string>();
  const result: any[] = [];

  function visit(code: string) {
    if (visited.has(code)) return;
    visited.add(code);
    const template = byCode.get(code);
    if (!template) return;
    const deps: string[] = Array.isArray(template.dependencies) ? template.dependencies : [];
    for (const dep of deps) {
      visit(dep);
    }
    result.push(template);
  }

  for (const template of templates) {
    visit(template.formCode);
  }

  return result;
}

// === Core Functions ===

/**
 * Find or create a filing session for the given tenant/year.
 */
export async function getOrCreateFiling(
  tenantId: string,
  taxYear: number,
  jurisdiction: string,
  region: string,
) {
  const existing = await db.abTaxFiling.findFirst({
    where: { tenantId, taxYear, filingType: 'personal_return' },
  });

  if (existing) return existing;

  return db.abTaxFiling.create({
    data: {
      tenantId,
      taxYear,
      jurisdiction,
      region,
      filingType: 'personal_return',
      status: 'draft',
      forms: {},
      missingFields: [],
      slips: [],
    },
  });
}

/**
 * Populate a filing with auto-resolved data from the ledger + slips.
 * Returns a summary of completeness and remaining missing fields.
 */
export async function populateFiling(tenantId: string, taxYear: number) {
  // Resolve jurisdiction / region from tenant config
  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const jurisdiction = config?.jurisdiction || 'ca';
  const region = config?.region || 'ON';

  const filing = await getOrCreateFiling(tenantId, taxYear, jurisdiction, region);

  // Load enabled form templates for this year
  let templates = await db.abTaxFormTemplate.findMany({
    where: { jurisdiction, version: String(taxYear), enabled: true },
  });

  // Seed if no templates found, then retry once
  if (templates.length === 0) {
    const seedByJurisdiction: Record<string, () => Promise<{ created: number; updated: number }>> = {
      ca: seedCanadianForms,
      us: seedUsForms,
      au: seedAuForms,
    };
    const seed = seedByJurisdiction[jurisdiction] ?? seedCanadianForms;
    await seed();
    templates = await db.abTaxFormTemplate.findMany({
      where: { jurisdiction, version: String(taxYear), enabled: true },
    });
  }

  // Load confirmed slips for this tenant / year
  const slips = await db.abTaxSlip.findMany({
    where: { tenantId, taxYear, status: 'confirmed' },
  });

  // Sort templates in dependency order
  const sorted = sortByDependencies(templates);

  // Two-pass auto-populate to resolve circular cross-form references (T1 ↔ Schedule1)
  const allFormFields: Record<string, Record<string, any>> = {};
  const formResults: Record<string, { fields: Record<string, any>; completeness: number; missing: any[] }> = {};

  for (let pass = 0; pass < 2; pass++) {
    for (const template of sorted) {
      const result = await autoPopulateForm(tenantId, taxYear, template, slips, allFormFields);
      formResults[template.formCode] = result;
      allFormFields[template.formCode] = result.fields;
    }
  }

  // Calculate overall completeness (average across all forms)
  const formCodes = Object.keys(formResults);
  const overallCompleteness =
    formCodes.length > 0
      ? formCodes.reduce((sum, code) => sum + formResults[code].completeness, 0) / formCodes.length
      : 0;

  // Collect and deduplicate missing fields
  const allMissing: any[] = [];
  const seenKeys = new Set<string>();
  for (const code of formCodes) {
    for (const m of formResults[code].missing) {
      const key = `${m.formCode}:${m.fieldId}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allMissing.push(m);
      }
    }
  }

  // Determine filing status
  const newStatus =
    overallCompleteness >= 1
      ? 'ready'
      : overallCompleteness >= 0.5
      ? 'in_progress'
      : 'draft';

  // Persist updated forms and missing fields
  await db.abTaxFiling.update({
    where: { id: filing.id },
    data: {
      forms: allFormFields as any,
      missingFields: allMissing as any,
      status: newStatus,
    },
  });

  // Build summary per form
  const formSummary = formCodes.map(code => {
    const r = formResults[code];
    const formStatus =
      r.completeness >= 1 ? 'complete' : r.completeness > 0 ? 'partial' : 'empty';
    return { formCode: code, completeness: r.completeness, status: formStatus };
  });

  return {
    filingId: filing.id,
    taxYear,
    jurisdiction,
    completeness: overallCompleteness,
    forms: formSummary,
    missingFields: allMissing,
    slipsCount: slips.length,
  };
}

/**
 * Update a single field value in a filing and recalculate missing fields.
 */
export async function updateFilingField(
  tenantId: string,
  taxYear: number,
  formCode: string,
  fieldId: string,
  value: any,
) {
  const filing = await db.abTaxFiling.findFirst({
    where: { tenantId, taxYear, filingType: 'personal_return' },
  });

  if (!filing) {
    throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);
  }

  // Update the field value inside the forms JSON blob
  if (['__proto__', 'constructor', 'prototype'].includes(formCode)) throw new Error('Invalid form code');
  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  if (!forms[formCode]) forms[formCode] = {};
  forms[formCode][fieldId] = value;

  // Re-run the formula pass for the edited form, so every figure derived from
  // this field moves with it. Without this the edit landed in the blob alone:
  // the review screen reads the jurisdiction's own pre-computed total-tax line
  // out of these same stored forms (see computeFilingTotals), so editing
  // taxable income used to leave a tax figure with no relationship to the
  // number just entered — and confirmAndSubmit() hashed and filed it that way.
  //
  // Scoped to the edited form only, and to fields downstream of the edit: a
  // full populateFiling() here would re-query the ledger and overwrite every
  // manual entry on the filing. Cross-form dependants (CA's T1.federal_tax_40400
  // comes from Schedule1) are therefore NOT refreshed by this pass.
  try {
    const template = await db.abTaxFormTemplate.findFirst({
      where: { jurisdiction: filing.jurisdiction, formCode, version: String(taxYear), enabled: true },
    });
    if (template) {
      forms[formCode] = recomputeCalculatedFields(template, forms[formCode], forms, taxYear, fieldId);
    }
  } catch (err) {
    // An edit must still save if the recompute can't run — the value the user
    // typed is the thing they asked for. Logged, not swallowed silently.
    console.error('[updateFilingField] recompute of calculated fields failed:', err);
  }

  // Remove from missingFields if present
  const missingFields: any[] = Array.isArray(filing.missingFields)
    ? (filing.missingFields as any[])
    : [];
  const remaining = missingFields.filter(
    (m: any) => !(m.formCode === formCode && m.fieldId === fieldId),
  );

  await db.abTaxFiling.update({
    where: { id: filing.id },
    data: { forms: forms as any, missingFields: remaining as any },
  });

  return {
    updated: true,
    formCode,
    fieldId,
    remainingMissing: remaining,
  };
}
