import type { PastFilingPack, PastFilingFormDescriptor, StandardTaxExtract, PreFillSuggestion, EFileExport } from '../interfaces.js';

export class UsPastFilingPack implements PastFilingPack {
  jurisdiction = 'us';

  supportedFormTypes(): PastFilingFormDescriptor[] {
    return [
      { formType: '1040', displayName: 'Form 1040', description: 'US Individual Income Tax Return', typicalPages: 2 },
      { formType: 'W-2', displayName: 'W-2', description: 'Wage and Tax Statement', typicalPages: 1 },
      { formType: '1099-NEC', displayName: '1099-NEC', description: 'Nonemployee Compensation', typicalPages: 1 },
      { formType: '1099-MISC', displayName: '1099-MISC', description: 'Miscellaneous Income', typicalPages: 1 },
      { formType: 'K-1', displayName: 'Schedule K-1', description: 'Partner\'s Share of Income', typicalPages: 1 },
    ];
  }

  identificationPrompt(): string {
    return `You are a US IRS tax document classifier. Look at the first page of this document.
Identify: formType (1040|W-2|1099-NEC|1099-MISC|K-1|other), taxYear (4-digit), jurisdiction ("us"), region (2-letter state code like CA, NY, TX).
Return JSON only: { "formType": "1040", "taxYear": 2024, "jurisdiction": "us", "region": "CA" }`;
  }

  extractionPrompt(formType: string, taxYear: number): string {
    const base = `You are an IRS tax document parser. Extract data from this ${formType} (${taxYear} tax year). All monetary values in CENTS (multiply dollars by 100). Return JSON only — no markdown fences.\n\n`;

    if (formType === '1040') {
      return base + `Extract these IRS Form 1040 lines (use null if blank or not present):
{ "formType": "1040", "taxYear": ${taxYear}, "jurisdiction": "us", "region": "<state code>",
  "keyLines": {
    "1a": <wages cents or null>,
    "2b": <taxable interest cents or null>,
    "3b": <qualified dividends cents or null>,
    "7": <capital gain or loss cents or null>,
    "8": <other income Schedule C cents or null>,
    "11": <adjusted gross income cents>,
    "12": <deduction cents>,
    "15": <taxable income cents>,
    "22": <total tax cents>,
    "25a": <W-2 withholding cents or null>,
    "35a": <refund cents or null>,
    "37": <amount owed cents or null>
  },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === 'W-2') {
      return base + `Extract W-2 Wage and Tax Statement:
{ "formType": "W-2", "taxYear": ${taxYear}, "jurisdiction": "us",
  "employer": "<employer name or null>",
  "formFields": {
    "box1": <wages tips other comp cents>,
    "box2": <federal income tax withheld cents>,
    "box3": <social security wages cents or null>,
    "box4": <social security tax withheld cents or null>,
    "box5": <medicare wages cents or null>,
    "box6": <medicare tax withheld cents or null>
  },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === '1099-NEC') {
      return base + `Extract 1099-NEC Nonemployee Compensation:
{ "formType": "1099-NEC", "taxYear": ${taxYear}, "jurisdiction": "us",
  "payer": "<payer name or null>",
  "formFields": { "box1": <nonemployee comp cents>, "box4": <federal tax withheld cents or null> },
  "confidence": <0.0-1.0>
}`;
    }

    return base + `Extract all visible fields as key-value pairs in formFields (monetary values in cents).
{ "formType": "${formType}", "taxYear": ${taxYear}, "jurisdiction": "us", "formFields": {}, "confidence": <0.0-1.0> }`;
  }

  parseExtraction(raw: any, formType: string, taxYear: number): StandardTaxExtract {
    let r: any;
    try {
      r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error(`UsPastFilingPack.parseExtraction: malformed JSON for ${formType}: ${String(raw).slice(0, 200)}`);
    }

    const base: StandardTaxExtract = {
      formType: r.formType || formType,
      taxYear: r.taxYear || taxYear,
      jurisdiction: 'us',
      region: r.region || undefined,
      formFields: r.formFields || {},
      attachedForms: {},
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    };

    if (formType === '1040' && r.keyLines) {
      base.totalIncomeCents = r.keyLines['11'] ?? undefined; // AGI as proxy for total
      base.netIncomeCents = r.keyLines['11'] ?? undefined;
      base.taxableIncomeCents = r.keyLines['15'] ?? undefined;
      base.taxPayableCents = r.keyLines['22'] ?? undefined;
      const refund = r.keyLines['35a'];
      const owed = r.keyLines['37'];
      if (refund != null) base.refundOrBalanceCents = refund;
      else if (owed != null) base.refundOrBalanceCents = -owed;
      base.formFields = r.keyLines;
    }

    return base;
  }

  preFillMap(_extract: StandardTaxExtract): PreFillSuggestion[] {
    // US pre-fill: no T1/T2125 field mapping for now — placeholder for future
    return [];
  }

  summarize(extract: StandardTaxExtract): string {
    const year = extract.taxYear;
    const jurisdiction = `US / ${extract.region || 'US'}`;
    const fmt = (c?: number) => c != null ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : 'n/a';
    const rOrB = extract.refundOrBalanceCents != null
      ? (extract.refundOrBalanceCents >= 0 ? `Refund: ${fmt(extract.refundOrBalanceCents)}` : `Amount owed: ${fmt(-extract.refundOrBalanceCents)}`)
      : '';

    let line = `${year} (${jurisdiction}) [${extract.formType}]:\n`;
    line += `  AGI: ${fmt(extract.totalIncomeCents)} | Taxable income: ${fmt(extract.taxableIncomeCents)} | Tax: ${fmt(extract.taxPayableCents)}\n`;
    if (rOrB) line += `  ${rOrB}\n`;
    line += `  Source: confirmed ${extract.formType} upload (confidence ${Math.round(extract.confidence * 100)}%)`;
    return line;
  }

  generateEFileExport(forms: Record<string, any>, taxYear: number, region = ''): EFileExport {
    const f1040 = forms['1040'] || {};
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Return xmlns="urn:us:treasury:irs:mef:${taxYear}">
  <TaxYear>${taxYear}</TaxYear>
  <State>${region}</State>
  <AdjustedGrossIncome>${Math.round((f1040['11'] || 0) / 100)}.00</AdjustedGrossIncome>
  <TaxableIncome>${Math.round((f1040['15'] || 0) / 100)}.00</TaxableIncome>
  <TotalTax>${Math.round((f1040['22'] || 0) / 100)}.00</TotalTax>
  <Withholding>${Math.round((f1040['25a'] || 0) / 100)}.00</Withholding>
</Return>`;
    return {
      format: 'xml',
      content: xml,
      filename: `1040-${taxYear}-mef.xml`,
      instructions: `Download this XML file and give it to your CPA for e-filing via IRS MeF, or use IRS Free File Fillable Forms at irs.gov/filing/free-file-fillable-forms.`,
    };
  }
}
