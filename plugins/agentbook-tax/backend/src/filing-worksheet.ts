/**
 * The filing worksheet — the artifact at the end of the core journey.
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO GO
 *
 * `UsPastFilingPack.generateEFileExport` and its CA twin produced files named
 * `1040-2025-mef.xml` and `T1-2025-netfile.xml`, under invented namespaces
 * (`urn:us:treasury:irs:mef:2025`), with instructions telling the user to
 * "give it to your CPA for e-filing via IRS MeF" and to "submit it at
 * canada.ca/netfile".
 *
 * Neither could work, for two independent reasons.
 *
 * First, the numbers were all zero. The exporters read `f1040['11']` and
 * `t1['15000']`; the form templates define `total_income_9` and
 * `total_income_15000`. There was no overlap in either jurisdiction, so a
 * filer with $84,500 of income downloaded a document declaring $0.00 — and
 * the instructions told them to send it to a tax authority.
 *
 * Second, AgentBook is not an authorised transmitter and cannot become one in
 * code: IRS MeF requires an EFIN and ATS testing, CRA NETFILE requires annual
 * certification, ATO PLS requires a registered software ID. A file that looks
 * like an agency submission and is not schema-valid is worse than no file,
 * because it invites someone to act on it.
 *
 * So the honest artifact is a WORKSHEET: every value AgentBook computed, next
 * to the real published line number it belongs on, in a form an accountant can
 * read or a person can key into the official portal. That is genuinely useful
 * and it is exactly what we can stand behind.
 *
 * WHY IT IS BUILT FROM TEMPLATES
 * The all-zeros bug existed because line numbers lived in one place (the pack)
 * and field IDs in another (the template), with nothing tying them together.
 * This module walks the templates — the same structures `renderFilingPDF`
 * already reads correctly — so a field ID it looks up is by construction a
 * field ID that exists. There is no second list to drift.
 */

/** One line of the worksheet, in template order. */
export interface WorksheetRow {
  formCode: string;
  formName: string;
  section: string;
  /** The official line number, e.g. '15000' (T1) or '8000' (T2125). May be
   *  empty for identity fields, which have no line of their own. */
  lineNumber: string;
  label: string;
  /** Cents for currency rows; the raw value otherwise. */
  value: number | string | null;
  type: string;
}

export interface WorksheetMeta {
  jurisdiction: string;
  taxYear: number;
  currency: string;
  /** Revenue agency for this jurisdiction, for the disclaimer. */
  agency: string;
  reviewed: boolean;
}

/**
 * Per-jurisdiction facts the worksheet has to state correctly.
 *
 * `renderFilingPDF` hardcoded "not an official CRA document" in its footer and
 * a bare `$` for every amount, so a US filer's worksheet named the wrong
 * agency and an Australian's showed US dollars — on the document they file
 * from.
 */
interface JurisdictionFacts {
  currency: string;
  agency: string;
  portal: string;
  /**
   * Locale used ONLY to format the numbers. Deliberately the jurisdiction's,
   * not the tenant's: a tax worksheet is regulated copy that stays English
   * (the same rule the i18n catalog enforces via ENGLISH_ONLY_KEYS), and the
   * amounts should read the way the agency's own forms do.
   */
  locale: string;
}

const JURISDICTION_FACTS: Record<string, JurisdictionFacts> = {
  us: { currency: 'USD', agency: 'IRS', portal: 'irs.gov', locale: 'en-US' },
  ca: { currency: 'CAD', agency: 'CRA', portal: 'canada.ca', locale: 'en-CA' },
  au: { currency: 'AUD', agency: 'ATO', portal: 'ato.gov.au', locale: 'en-AU' },
  uk: { currency: 'GBP', agency: 'HMRC', portal: 'gov.uk', locale: 'en-GB' },
};

export function jurisdictionFacts(jurisdiction: string | null | undefined) {
  const key = (jurisdiction || '').toLowerCase();
  // Unknown jurisdiction falls back to a neutral label rather than silently
  // naming the wrong agency, which is the bug this map exists to fix.
  return JURISDICTION_FACTS[key]
    || { currency: 'USD', agency: 'your tax authority', portal: 'your tax authority', locale: 'en-US' };
}

/**
 * Flatten a filing into worksheet rows, in template order.
 *
 * Mirrors `renderFilingPDF`'s traversal exactly — same `forms[formCode].fields`
 * access, same "skip undefined unless required" rule — so the CSV and the
 * printable copy can never disagree about what the filing contains.
 */
export function buildWorksheetRows(
  forms: Record<string, any>,
  templates: any[],
): WorksheetRow[] {
  const rows: WorksheetRow[] = [];
  for (const template of templates) {
    const formData = forms[template.formCode];
    if (!formData?.fields) continue;
    for (const section of template.sections || []) {
      for (const field of section.fields || []) {
        const value = formData.fields[field.fieldId];
        if (value === undefined && !field.required) continue;
        rows.push({
          formCode: template.formCode,
          formName: template.formName || template.formCode,
          section: section.title || '',
          lineNumber: field.lineNumber || '',
          label: field.label || field.fieldId,
          value: value ?? null,
          type: field.type || 'text',
        });
      }
    }
  }
  return rows;
}

/** RFC 4180 quoting. Labels contain commas ("Meals, entertainment") and the
 *  odd quote, and a worksheet that breaks a spreadsheet import is no use. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * The accountant-importable artifact.
 *
 * CSV rather than a proprietary JSON shape because the consumer is a person
 * with a spreadsheet or tax software, not an integration. Amounts are written
 * as plain decimal numbers with a separate currency column, so they arrive in
 * a spreadsheet as numbers rather than as text needing a cleanup pass.
 */
export function renderWorksheetCSV(rows: WorksheetRow[], meta: WorksheetMeta): string {
  const facts = jurisdictionFacts(meta.jurisdiction);
  const lines: string[] = [];

  // A leading comment block would break a naive CSV parser, so the provenance
  // goes in real columns on a header row instead.
  lines.push(['Form', 'Line', 'Description', 'Amount', 'Currency'].join(','));
  for (const r of rows) {
    const amount =
      r.type === 'currency' && typeof r.value === 'number'
        ? (r.value / 100).toFixed(2)
        : r.value === null
          ? ''
          : String(r.value);
    lines.push([
      csvCell(r.formCode),
      csvCell(r.lineNumber),
      csvCell(r.label),
      csvCell(amount),
      csvCell(r.type === 'currency' ? meta.currency : ''),
    ].join(','));
  }

  // The disclaimer is part of the file, not just the download page, because
  // the file is what gets forwarded to an accountant.
  lines.push('');
  lines.push(csvCell(
    `AgentBook worksheet for tax year ${meta.taxYear} (${meta.jurisdiction.toUpperCase()}). ` +
    `Line numbers refer to the official ${facts.agency} forms. ` +
    `This is NOT a ${facts.agency} submission file — AgentBook is not an authorised e-file ` +
    `transmitter. Give this to your accountant, or use it to complete your return at ${facts.portal}. ` +
    (meta.reviewed
      ? 'These figures passed AgentBook\'s filing review.'
      : 'These figures have NOT been through AgentBook\'s filing review.'),
  ));
  return lines.join('\n');
}

export function worksheetFilename(jurisdiction: string, taxYear: number): string {
  return `agentbook-worksheet-${(jurisdiction || 'xx').toLowerCase()}-${taxYear}.csv`;
}
