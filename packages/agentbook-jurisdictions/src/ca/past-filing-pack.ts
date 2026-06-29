import type { PastFilingPack, PastFilingFormDescriptor, StandardTaxExtract, PreFillSuggestion, EFileExport } from '../interfaces.js';

export class CaPastFilingPack implements PastFilingPack {
  jurisdiction = 'ca';

  supportedFormTypes(): PastFilingFormDescriptor[] {
    return [
      { formType: 'T1', displayName: 'T1 General', description: 'Canadian personal income tax return', typicalPages: 4 },
      { formType: 'NOA', displayName: 'Notice of Assessment', description: 'CRA assessment of your T1 return', typicalPages: 2 },
      { formType: 'T2125', displayName: 'T2125', description: 'Statement of Business or Professional Activities', typicalPages: 3 },
      { formType: 'T4', displayName: 'T4', description: 'Statement of Remuneration Paid', typicalPages: 1 },
      { formType: 'T4A', displayName: 'T4A', description: 'Statement of Pension, Retirement, Annuity and Other Income', typicalPages: 1 },
      { formType: 'T5', displayName: 'T5', description: 'Statement of Investment Income', typicalPages: 1 },
      { formType: 'RRSP', displayName: 'RRSP Receipt', description: 'RRSP contribution receipt', typicalPages: 1 },
    ];
  }

  identificationPrompt(): string {
    return `You are a Canadian tax document classifier. Look at the first page of this document.
Identify: formType (T1|T4|T4A|T5|NOA|T2125|RRSP|other), taxYear (4-digit), jurisdiction ("ca"), region (2-letter province code like ON, BC, AB, QC).
Return JSON only: { "formType": "T1", "taxYear": 2024, "jurisdiction": "ca", "region": "ON" }`;
  }

  extractionPrompt(formType: string, taxYear: number): string {
    const base = `You are a Canadian CRA tax document parser. Extract data from this ${formType} (${taxYear} tax year). All monetary values in CENTS (multiply dollars by 100). Return JSON only — no markdown fences.\n\n`;

    if (formType === 'T1') {
      return base + `Extract these CRA line numbers (use null if blank):
{ "formType": "T1", "taxYear": ${taxYear}, "jurisdiction": "ca", "region": "<province>",
  "keyLines": {
    "10100": <employment income cents or null>,
    "13500": <net business income cents or null>,
    "15000": <total income cents>,
    "23200": <net income cents>,
    "26000": <taxable income cents>,
    "43500": <basic federal tax cents or null>,
    "48200": <total tax payable cents or null>,
    "48400": <refund cents or null>,
    "48500": <balance owing cents or null>,
    "rrspRoom": <RRSP deduction limit for next year cents or null>
  },
  "attachedForms": {
    "T2125": { "grossRevenue": <cents or null>, "netIncome": <cents or null>, "totalExpenses": <cents or null>, "homeOfficePct": <number 0-100 or null>, "businessName": "<string or null>" }
  },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === 'NOA') {
      return base + `Extract CRA Notice of Assessment fields:
{ "formType": "NOA", "taxYear": ${taxYear}, "jurisdiction": "ca", "region": "<province or null>",
  "assessmentDate": "<YYYY-MM-DD or null>",
  "noaLines": {
    "totalIncome": <cents>, "netIncome": <cents>, "taxableIncome": <cents>,
    "taxPayable": <cents>, "refundOrBalance": <cents — positive=refund, negative=owing>,
    "rrspDeductionLimit": <cents or null>, "instalmentsRequired": <true|false>
  },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === 'T4') {
      return base + `Extract T4 Statement of Remuneration:
{ "formType": "T4", "taxYear": ${taxYear}, "jurisdiction": "ca",
  "employer": "<employer name or null>",
  "formFields": { "box14": <employment income cents>, "box22": <income tax deducted cents>, "box16": <CPP contributions cents>, "box18": <EI premiums cents> },
  "confidence": <0.0-1.0>
}`;
    }

    if (formType === 'T2125') {
      return base + `Extract T2125 Statement of Business Activities:
{ "formType": "T2125", "taxYear": ${taxYear}, "jurisdiction": "ca",
  "formFields": {
    "businessName": "<string or null>", "industryCode": "<6-digit NAICS or null>",
    "gross_sales_8000": <gross revenue cents>, "total_expenses_9368": <total expenses cents>, "net_income_9369": <net income cents>,
    "home_office_pct": <percentage 0-100 or null>,
    "advertising_8520": <cents or null>, "meals_8523": <cents or null>, "office_8810": <cents or null>, "travel_8910": <cents or null>
  },
  "confidence": <0.0-1.0>
}`;
    }

    // Fallback for T4A, T5, RRSP
    return base + `Extract all visible fields as key-value pairs in formFields (monetary values in cents).
{ "formType": "${formType}", "taxYear": ${taxYear}, "jurisdiction": "ca", "formFields": {}, "confidence": <0.0-1.0> }`;
  }

  parseExtraction(raw: any, formType: string, taxYear: number): StandardTaxExtract {
    let r: any;
    try {
      r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error(`CaPastFilingPack.parseExtraction: malformed JSON for ${formType}: ${String(raw).slice(0, 200)}`);
    }

    const base: StandardTaxExtract = {
      formType: r.formType || formType,
      taxYear: r.taxYear || taxYear,
      jurisdiction: 'ca',
      region: r.region || undefined,
      formFields: r.formFields || {},
      attachedForms: r.attachedForms || {},
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    };

    if (formType === 'T1' && r.keyLines) {
      base.totalIncomeCents = r.keyLines['15000'] ?? undefined;
      base.netIncomeCents = r.keyLines['23200'] ?? undefined;
      base.taxableIncomeCents = r.keyLines['26000'] ?? undefined;
      base.taxPayableCents = r.keyLines['48200'] ?? undefined;
      const refund = r.keyLines['48400'];
      const owing = r.keyLines['48500'];
      if (refund != null) base.refundOrBalanceCents = refund;
      else if (owing != null) base.refundOrBalanceCents = -owing;
      base.savingsRoomCents = r.keyLines['rrspRoom'] ?? undefined;
      base.formFields = r.keyLines;
    }

    if (formType === 'NOA' && r.noaLines) {
      base.totalIncomeCents = r.noaLines.totalIncome;
      base.netIncomeCents = r.noaLines.netIncome;
      base.taxableIncomeCents = r.noaLines.taxableIncome;
      base.taxPayableCents = r.noaLines.taxPayable;
      base.refundOrBalanceCents = r.noaLines.refundOrBalance;
      base.savingsRoomCents = r.noaLines.rrspDeductionLimit ?? undefined;
      base.formFields = { ...r.noaLines, assessmentDate: r.assessmentDate };
    }

    return base;
  }

  preFillMap(extract: StandardTaxExtract): PreFillSuggestion[] {
    const suggestions: PreFillSuggestion[] = [];
    const t2125 = extract.attachedForms?.['T2125'] || {};

    if (t2125.homeOfficePct != null) {
      suggestions.push({ fieldId: 'home_office_pct', value: t2125.homeOfficePct, sourceField: 'T2125.homeOfficePct', confidence: extract.confidence });
    }
    if (t2125.businessName) {
      suggestions.push({ fieldId: 'business_name', value: t2125.businessName, sourceField: 'T2125.businessName', confidence: extract.confidence });
    }
    if ((extract.formFields as any)?.industryCode) {
      suggestions.push({ fieldId: 'industry_code', value: (extract.formFields as any).industryCode, sourceField: 'T2125.industryCode', confidence: extract.confidence });
    }
    return suggestions;
  }

  summarize(extract: StandardTaxExtract): string {
    const year = extract.taxYear;
    const jurisdiction = `CA / ${extract.region || 'CA'}`;
    const fmt = (c?: number) => c != null ? `$${(c / 100).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : 'n/a';
    const rOrB = extract.refundOrBalanceCents != null
      ? (extract.refundOrBalanceCents >= 0 ? `Refund: ${fmt(extract.refundOrBalanceCents)}` : `Balance owing: ${fmt(-extract.refundOrBalanceCents)}`)
      : '';
    const rrsp = extract.savingsRoomCents != null ? ` | RRSP room for ${year + 1}: ${fmt(extract.savingsRoomCents)}` : '';

    let line = `${year} (${jurisdiction}) [${extract.formType}]:\n`;
    line += `  Total income: ${fmt(extract.totalIncomeCents)} | Net: ${fmt(extract.netIncomeCents)} | Tax payable: ${fmt(extract.taxPayableCents)}\n`;
    if (rOrB) line += `  ${rOrB}${rrsp}\n`;
    else if (rrsp) line += ` ${rrsp.trim()}\n`;

    const t2125 = extract.attachedForms?.['T2125'];
    if (t2125) {
      line += `  Business (T2125): Revenue ${fmt(t2125.grossRevenue)} | Expenses ${fmt(t2125.totalExpenses)} | Net ${fmt(t2125.netIncome)}\n`;
    }
    line += `  Source: confirmed ${extract.formType} upload (confidence ${Math.round(extract.confidence * 100)}%)`;
    return line;
  }

  generateEFileExport(forms: Record<string, any>, taxYear: number, region = 'ON'): EFileExport {
    // Minimal NETFILE XML envelope — CRA schema published annually
    const t1 = forms['T1'] || {};
    const t2125 = forms['T2125'] || {};
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Return xmlns="urn:cra-arc.gc.ca:netfile:t1:${taxYear}">
  <TaxYear>${taxYear}</TaxYear>
  <Province>${region}</Province>
  <TotalIncome>${Math.round((t1['15000'] || 0) / 100)}.00</TotalIncome>
  <NetIncome>${Math.round((t1['23200'] || 0) / 100)}.00</NetIncome>
  <TaxableIncome>${Math.round((t1['26000'] || 0) / 100)}.00</TaxableIncome>
  <TaxPayable>${Math.round((t1['48200'] || 0) / 100)}.00</TaxPayable>
  <GrossRevenue>${Math.round((t2125['gross_sales_8000'] || 0) / 100)}.00</GrossRevenue>
  <NetBusinessIncome>${Math.round((t2125['net_income_9369'] || 0) / 100)}.00</NetBusinessIncome>
</Return>`;
    return {
      format: 'xml',
      content: xml,
      filename: `T1-${taxYear}-netfile.xml`,
      instructions: `Download this XML file and submit it at canada.ca/netfile, or import it into StudioTax or CloudTax (both free for simple returns).`,
    };
  }
}
