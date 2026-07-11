import type { PastFilingPack, PastFilingFormDescriptor, StandardTaxExtract, PreFillSuggestion } from '../interfaces.js';

export class AuPastFilingPack implements PastFilingPack {
  jurisdiction = 'au';

  supportedFormTypes(): PastFilingFormDescriptor[] {
    return [
      { formType: 'income-statement', displayName: 'Income Statement', description: 'myGov income statement (replaces the old PAYG payment summary / "group certificate")', typicalPages: 1 },
      { formType: 'notice-of-assessment', displayName: 'Notice of Assessment', description: 'ATO myTax assessment of your tax return', typicalPages: 2 },
      { formType: 'payg-instalment', displayName: 'PAYG Instalment Notice', description: 'Quarterly PAYG instalment notice', typicalPages: 1 },
    ];
  }

  identificationPrompt(): string {
    return `You are an Australian ATO tax document classifier. Look at the first page of this document.
Identify: formType (income-statement|notice-of-assessment|payg-instalment|other), taxYear (the year the income was earned — for AU this is a July-June fiscal year, use the earlier calendar year, e.g. "2024-25" -> 2024), jurisdiction ("au"), region (state/territory code like NSW, VIC, QLD if shown, else null).
Return JSON only: { "formType": "income-statement", "taxYear": 2024, "jurisdiction": "au", "region": "NSW" }`;
  }

  extractionPrompt(formType: string, taxYear: number): string {
    const base = `You are an Australian ATO tax document parser. Extract data from this ${formType} (${taxYear}-${String(taxYear + 1).slice(2)} tax year). All monetary values in CENTS (multiply dollars by 100). Return JSON only — no markdown fences.\n\n`;

    if (formType === 'income-statement') {
      return base + `Extract this myGov Income Statement (replaces the old PAYG payment summary / "group certificate"):
{ "formType": "income-statement", "taxYear": ${taxYear}, "jurisdiction": "au",
  "employer": "<employer name or null>",
  "formFields": {
    "grossPayments": <total gross payments cents>,
    "taxWithheld": <total tax withheld cents>,
    "reportableFringeBenefits": <cents or null>,
    "reportableSuperContributions": <cents or null>,
    "superGuaranteeContributions": <employer super guarantee contributions cents or null>
  },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === 'notice-of-assessment') {
      return base + `Extract this ATO Notice of Assessment (myTax NOA):
{ "formType": "notice-of-assessment", "taxYear": ${taxYear}, "jurisdiction": "au", "region": "<state/territory or null>",
  "assessmentDate": "<YYYY-MM-DD or null>",
  "noaLines": {
    "taxableIncome": <cents>,
    "taxOnTaxableIncome": <cents>,
    "medicareLevy": <cents or null>,
    "medicareLevySurcharge": <cents or null>,
    "hecsHelpRepayment": <cents or null>,
    "taxOffsets": <cents or null>,
    "refundOrBalance": <cents — positive=refund, negative=owing>
  },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === 'payg-instalment') {
      return base + `Extract this PAYG Instalment Notice:
{ "formType": "payg-instalment", "taxYear": ${taxYear}, "jurisdiction": "au",
  "formFields": {
    "instalmentIncome": <cents or null>,
    "instalmentRate": <percentage as decimal, e.g. 0.15 or null>,
    "amountDue": <cents>,
    "quarter": "<1|2|3|4 or null>"
  },
  "confidence": <0.0-1.0>
}`;
    }

    return base + `Extract all visible fields as key-value pairs in formFields (monetary values in cents).
{ "formType": "${formType}", "taxYear": ${taxYear}, "jurisdiction": "au", "formFields": {}, "confidence": <0.0-1.0> }`;
  }

  parseExtraction(raw: any, formType: string, taxYear: number): StandardTaxExtract {
    let r: any;
    try {
      r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error(`AuPastFilingPack.parseExtraction: malformed JSON for ${formType}: ${String(raw).slice(0, 200)}`);
    }

    const base: StandardTaxExtract = {
      formType: r.formType || formType,
      taxYear: r.taxYear || taxYear,
      jurisdiction: 'au',
      region: r.region || undefined,
      formFields: r.formFields || {},
      attachedForms: r.attachedForms || {},
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    };

    if (formType === 'income-statement' && r.formFields) {
      base.totalIncomeCents = r.formFields.grossPayments ?? undefined;
      base.netIncomeCents = r.formFields.grossPayments ?? undefined;
      base.savingsRoomCents = r.formFields.superGuaranteeContributions ?? undefined;
    }

    if (formType === 'notice-of-assessment' && r.noaLines) {
      base.taxableIncomeCents = r.noaLines.taxableIncome;
      base.totalIncomeCents = r.noaLines.taxableIncome;
      base.taxPayableCents = r.noaLines.taxOnTaxableIncome;
      base.refundOrBalanceCents = r.noaLines.refundOrBalance;
      base.formFields = { ...r.noaLines, assessmentDate: r.assessmentDate };
    }

    return base;
  }

  preFillMap(_extract: StandardTaxExtract): PreFillSuggestion[] {
    // AU pre-fill mapping — placeholder for future (income-statement -> BAS/estimate prefill)
    return [];
  }

  summarize(extract: StandardTaxExtract): string {
    const year = extract.taxYear;
    const jurisdiction = `AU / ${extract.region || 'AU'}`;
    const fmt = (c?: number) => c != null ? `$${(c / 100).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : 'n/a';
    const rOrB = extract.refundOrBalanceCents != null
      ? (extract.refundOrBalanceCents >= 0 ? `Refund: ${fmt(extract.refundOrBalanceCents)}` : `Balance owing: ${fmt(-extract.refundOrBalanceCents)}`)
      : '';
    const super_ = extract.savingsRoomCents != null ? ` | Super guarantee: ${fmt(extract.savingsRoomCents)}` : '';

    let line = `${year}-${String(year + 1).slice(2)} (${jurisdiction}) [${extract.formType}]:\n`;
    line += `  Income: ${fmt(extract.totalIncomeCents)} | Taxable income: ${fmt(extract.taxableIncomeCents)} | Tax: ${fmt(extract.taxPayableCents)}${super_}\n`;
    if (rOrB) line += `  ${rOrB}\n`;
    line += `  Source: confirmed ${extract.formType} upload (confidence ${Math.round(extract.confidence * 100)}%)`;
    return line;
  }
}
