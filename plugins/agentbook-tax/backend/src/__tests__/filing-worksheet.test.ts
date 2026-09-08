import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorksheetRows, renderWorksheetCSV, worksheetFilename, jurisdictionFacts,
} from '../filing-worksheet.js';
import { ALL_CA_FORMS, ALL_US_FORMS, ALL_AU_FORMS } from '../tax-forms.js';

const SRC = join(__dirname, '..');

/**
 * The bug this file exists to prevent:
 *
 * `UsPastFilingPack.generateEFileExport` read `f1040['11']`, `['15']`, `['22']`
 * and `['25a']`. The US 1040 template defines `total_income_9`,
 * `taxable_income`, `total_tax_24` and `withholding_25a`. Zero overlap, so
 * every amount in the emitted "IRS MeF" file was 0.00 — for a filer with real
 * income — and the instructions said to give it to a CPA for e-filing. The CA
 * NETFILE twin had the same defect.
 *
 * Nothing caught it because the numbers came from a hand-written list of line
 * numbers that lived nowhere near the templates, and the e2e test accepted
 * "XML or 404" without ever asserting a value.
 */

describe('the worksheet reads real fields, not invented ones', () => {
  const CASES = [
    ['ca', ALL_CA_FORMS, 'T2125', 'gross_sales_8000', 9_100_000],
    ['us', ALL_US_FORMS, '1040', 'total_income_9', 8_450_000],
    ['au', ALL_AU_FORMS, 'BusinessSchedule', null, 0],
  ] as const;

  it.each(CASES.filter((c) => c[3] !== null))(
    '%s: a real amount reaches the CSV',
    (jurisdiction, templates, formCode, fieldId, cents) => {
      const forms = { [formCode]: { fields: { [fieldId!]: cents } } };
      const rows = buildWorksheetRows(forms, templates as any[]);
      const facts = jurisdictionFacts(jurisdiction);
      const csv = renderWorksheetCSV(rows, {
        jurisdiction, taxYear: 2025, currency: facts.currency, agency: facts.agency, reviewed: false,
      });

      // The whole failure was silent zeros, so assert the VALUE, not that a
      // row exists. 9_100_000 cents must appear as 91000.00.
      const expected = (cents / 100).toFixed(2);
      expect(csv, `${jurisdiction}: ${fieldId} did not reach the CSV`).toContain(expected);
      expect(csv).not.toMatch(new RegExp(`,0\\.00,${facts.currency}`));
    },
  );

  /**
   * Line-number coverage per jurisdiction, pinned.
   *
   * A worksheet is only worth anything if its rows say WHERE each number goes,
   * so coverage is the quality measure. Measured now:
   *
   *     ca  42/61 fields  (69%)
   *     us  26/37 fields  (70%)
   *     au  23/34 fields  (68%)
   *
   * AU was 2/23. Getting it here took two steps, and the first one is why the
   * second was needed: reading the actual ATO instructions to source the two
   * quotable mappings showed that the AU expense rows — advertising,
   * insurance, legal, office supplies, travel, telephone — were the US
   * Schedule C shape and had NO counterpart on the ATO's P8. No amount of
   * labelling could have fixed that; the rows themselves had to be replaced by
   * P8's own. See the header on AU_BUSINESS_SCHEDULE_2025.
   *
   * Eleven AU references carry a label letter read from a complete sentence in
   * the published instructions. Four rows carry "P8" with no letter, because
   * the page contradicts itself — label K is stated for both opening stock and
   * rent — or states none. That is deliberate: a wrong letter on a tax
   * worksheet looks authoritative in a way a blank does not.
   *
   * The floors stop coverage regressing and make any improvement deliberate.
   */
  it.each([
    ['ca', ALL_CA_FORMS, 40],
    ['us', ALL_US_FORMS, 24],
    ['au', ALL_AU_FORMS, 21],
  ])('%s keeps its line-number coverage', (j, templates, floor) => {
    const forms: Record<string, any> = {};
    for (const t of templates as any[]) {
      forms[t.formCode] = { fields: {} };
      for (const s of t.sections || []) {
        for (const f of s.fields || []) forms[t.formCode].fields[f.fieldId] = f.type === 'currency' ? 12345 : 'x';
      }
    }
    const rows = buildWorksheetRows(forms, templates as any[]);
    expect(rows.length, `${j} produced no rows`).toBeGreaterThan(10);
    const withLines = rows.filter((r) => r.lineNumber !== '').length;
    expect(withLines, `${j} line-number coverage fell below its pinned floor`).toBeGreaterThanOrEqual(floor);
  });

  it('AU is covered — it previously had no export at all', () => {
    const forms: Record<string, any> = {};
    for (const t of ALL_AU_FORMS as any[]) {
      forms[t.formCode] = { fields: {} };
      for (const s of t.sections || []) for (const f of s.fields || []) forms[t.formCode].fields[f.fieldId] = f.type === 'currency' ? 500000 : 'x';
    }
    const csv = renderWorksheetCSV(buildWorksheetRows(forms, ALL_AU_FORMS as any[]), {
      jurisdiction: 'au', taxYear: 2025, currency: 'AUD', agency: 'ATO', reviewed: false,
    });
    expect(csv).toContain('5000.00');
    expect(csv).toContain('AUD');
    expect(csv).toContain('ATO');
  });
});

describe('the worksheet names the right agency and currency', () => {
  it.each([
    ['us', 'USD', 'IRS', 'irs.gov'],
    ['ca', 'CAD', 'CRA', 'canada.ca'],
    ['au', 'AUD', 'ATO', 'ato.gov.au'],
  ])('%s -> %s / %s', (j, currency, agency, portal) => {
    const f = jurisdictionFacts(j);
    expect(f.currency).toBe(currency);
    expect(f.agency).toBe(agency);
    expect(f.portal).toBe(portal);
  });

  it('an unknown jurisdiction names no agency rather than the wrong one', () => {
    // The printable copy hardcoded "CRA" for every filing, so a US filer's
    // document named the wrong revenue agency. Guessing is the bug.
    const f = jurisdictionFacts('zz');
    expect(f.agency).not.toBe('CRA');
    expect(f.agency).not.toBe('IRS');
    expect(f.agency).toBe('your tax authority');
  });

  it('states that it is not a submission file, in the file itself', () => {
    const csv = renderWorksheetCSV([], {
      jurisdiction: 'us', taxYear: 2025, currency: 'USD', agency: 'IRS', reviewed: false,
    });
    // The file is what gets forwarded to an accountant; a disclaimer that
    // lives only on the download page does not travel with it.
    expect(csv).toContain('NOT a IRS submission file');
    expect(csv).toContain('not an authorised e-file');
  });

  it('records whether the figures passed review', () => {
    const meta = { jurisdiction: 'ca', taxYear: 2025, currency: 'CAD', agency: 'CRA' };
    expect(renderWorksheetCSV([], { ...meta, reviewed: true })).toContain('passed AgentBook');
    expect(renderWorksheetCSV([], { ...meta, reviewed: false })).toContain('NOT been through');
  });
});

describe('CSV is well formed', () => {
  it('quotes labels containing commas and quotes', () => {
    const rows = buildWorksheetRows(
      { X: { fields: { a: 100 } } },
      [{ formCode: 'X', formName: 'X', sections: [{ title: 's', fields: [
        { fieldId: 'a', label: 'Meals, entertainment and "other"', lineNumber: '8523', type: 'currency', required: true },
      ] }] }],
    );
    const csv = renderWorksheetCSV(rows, {
      jurisdiction: 'ca', taxYear: 2025, currency: 'CAD', agency: 'CRA', reviewed: false,
    });
    expect(csv).toContain('"Meals, entertainment and ""other"""');
    // A worksheet that breaks a spreadsheet import is no use to an accountant.
    const dataLine = csv.split('\n').find((l) => l.includes('8523'))!;
    expect(dataLine.match(/(?:^|,)(?=(?:[^"]*"[^"]*")*[^"]*$)/g)!.length).toBe(5);
  });
});

describe('no fabricated agency submission format survives anywhere', () => {
  /**
   * The strongest guard here. Emitting a file that LOOKS like an agency
   * submission is the failure mode — a user who acts on it files a false
   * return. AgentBook cannot be a transmitter without an EFIN (IRS), NETFILE
   * certification (CRA) or a registered software ID (ATO), none of which is
   * obtainable in code.
   */
  const ROOTS = [
    join(SRC, '..', '..', '..', '..', 'packages', 'agentbook-jurisdictions', 'src'),
    SRC,
  ];

  function walk(dir: string): string[] {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== '__tests__' && e !== 'node_modules') out.push(...walk(p)); }
      else if (e.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('declares no IRS / CRA / ATO XML namespace', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        const src = readFileSync(f, 'utf8');
        // `urn:us:treasury:irs:mef:2025` and `urn:cra-arc.gc.ca:netfile:t1:2025`
        // were both invented; no agency publishes them.
        if (/xmlns\s*=\s*["'][^"']*(irs|cra-arc|ato\.gov|hmrc)[^"']*["']/i.test(src)) offenders.push(f);
      }
    }
    expect(offenders, `fabricated agency namespace in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('emits no file named for a submission format', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        const src = readFileSync(f, 'utf8');
        if (/filename[^\n]*(mef|netfile|sbr|pls)\b/i.test(src)) offenders.push(f);
      }
    }
    expect(offenders, `submission-format filename in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('tells nobody to submit our output to a tax authority', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        const src = readFileSync(f, 'utf8');
        if (/instructions:[^\n]*(submit it at|e-filing via|for e-filing)/i.test(src)) offenders.push(f);
      }
    }
    expect(offenders, `submission instructions in:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('filename', () => {
  it('says worksheet, not a submission format', () => {
    expect(worksheetFilename('us', 2025)).toBe('agentbook-worksheet-us-2025.csv');
    expect(worksheetFilename('us', 2025)).not.toMatch(/mef|netfile/i);
  });
});

describe('the AU schedule matches the ATO form, not Schedule C', () => {
  /**
   * The rows below are the P8 Expenses section as published, in order, from
   * the ATO's "Expenses P8" page. This is the assertion the previous version
   * of the AU pack would have failed on every single row but one — it carried
   * advertising, insurance, legal and professional, office supplies, travel
   * and telephone, none of which exist on an Australian return.
   *
   * Source: ato.gov.au, Business and professional items schedule 2026
   * instructions (NAT 2543-06.2026), Expenses P8. Read 2026-09-08.
   */
  const P8_EXPENSE_ROWS = [
    'Opening stock', 'Purchases and other costs', 'Closing stock', 'Cost of sales',
    'Foreign resident withholding', 'Contractor, sub-contractor and commission',
    'Superannuation', 'Bad debts', 'Lease', 'Rent', 'Interest expenses within Australia',
    'Interest expenses overseas', 'Depreciation', 'Motor vehicle',
    'Repairs and maintenance', 'All other expenses', 'Home office', 'Total expenses',
  ];

  const schedule = (ALL_AU_FORMS as any[]).find((f) => f.formCode === 'BusinessSchedule');
  const expenseSection = schedule.sections.find((s: any) => s.sectionId === 'expenses');
  const labels: string[] = expenseSection.fields.map((f: any) => f.label);

  it('has a row for every P8 expense line', () => {
    const missing = P8_EXPENSE_ROWS.filter(
      (row) => !labels.some((l) => l.toLowerCase().startsWith(row.toLowerCase())),
    );
    expect(missing, `P8 rows with no field: ${missing.join(' | ')}`).toEqual([]);
  });

  it('has no rows the ATO form does not have', () => {
    // The Schedule C leftovers. Each of these is a real US/CA category and a
    // fiction on an Australian return, where they all land in "All other
    // expenses".
    const NOT_ON_P8 = ['Advertising', 'Insurance', 'Legal and professional', 'Office supplies', 'Travel expenses', 'Telephone and internet'];
    const strays = NOT_ON_P8.filter((n) => labels.some((l) => l.toLowerCase().startsWith(n.toLowerCase())));
    expect(strays, `rows that do not exist on P8: ${strays.join(' | ')}`).toEqual([]);
  });

  it('rolls the nine "all other" accounts into one line, including suspense', () => {
    const allOther = expenseSection.fields.find((f: any) => f.fieldId === 'all_other_expenses');
    expect(allOther.sourceQuery).toMatch(/^expense_categories:/);
    const codes = allOther.sourceQuery.split(':')[1].split(',');
    // 6999 is the uncategorised-expense suspense account. It belongs here so
    // an expense nobody categorised is still claimed rather than silently
    // dropped from the return.
    expect(codes).toContain('6999');
    expect(codes.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps the three field IDs the AU review pack gates submission on', () => {
    const ids = schedule.sections.flatMap((s: any) => s.fields.map((f: any) => f.fieldId));
    for (const id of ['gross_business_income', 'total_expenses', 'net_business_income']) {
      expect(ids, `${id} is named by au/tax-review-pack.ts as a critical field`).toContain(id);
    }
  });

  it('totals every expense row, so nothing is computed out of the return', () => {
    const total = expenseSection.fields.find((f: any) => f.fieldId === 'total_expenses');
    const summed: string[] = total.formula.replace(/^SUM\(|\)$/g, '').split(',');
    const expenseIds = expenseSection.fields
      .map((f: any) => f.fieldId)
      .filter((id: string) => !['total_expenses', 'net_business_income', 'opening_stock', 'purchases_and_other_costs', 'closing_stock'].includes(id));
    // Stock rows feed cost_of_sales rather than the total directly, which is
    // how the ATO form works; everything else must be in the sum.
    const dropped = expenseIds.filter((id: string) => !summed.includes(id));
    expect(dropped, `expense rows missing from the total: ${dropped.join(', ')}`).toEqual([]);
  });
});
