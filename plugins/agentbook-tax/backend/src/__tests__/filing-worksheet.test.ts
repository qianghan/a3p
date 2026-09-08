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
   * so coverage is the quality measure. Measured today:
   *
   *     ca  42/61 fields  (69%)
   *     us  26/37 fields  (70%)
   *     au   2/23 fields  ( 9%)   <- known gap
   *
   * AU carries only `P8` (gross payments on the business schedule) and `1`
   * (salary or wages). The rest are blank, so an Australian accountant gets
   * labels with nothing to key them against. That is a real product gap and it
   * is the largest single contributor to AU's tax-depth deficit.
   *
   * It is NOT closed here on purpose. Filling those in means asserting ATO
   * item references, and guessing at a regulatory reference is worse than
   * leaving it blank — a wrong item number is a misfiled return, and unlike a
   * blank it looks authoritative. Raising the AU floor below requires a
   * published ATO source, not inference.
   *
   * The floors stop coverage regressing and make any improvement deliberate.
   */
  it.each([
    ['ca', ALL_CA_FORMS, 40],
    ['us', ALL_US_FORMS, 24],
    ['au', ALL_AU_FORMS, 2],
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
