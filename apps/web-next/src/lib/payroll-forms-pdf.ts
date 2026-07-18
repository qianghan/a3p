/**
 * Real PDF renderer for W-2/T4/P60/Payment Summary (year-end) and
 * 941/940/BAS/T4-remittance/PAYE/SG (tax-deposit) payroll documents.
 *
 * Closes the gap where "Download" on the payroll page opened raw JSON —
 * the same gap `agentbook-invoice-pdf.ts` closed for invoices ("closes the
 * long-open gap where /invoices/:id/pdf served HTML masquerading as a
 * PDF"). Mirrors that file's established @react-pdf/renderer pattern
 * exactly: shared StyleSheet, a Document/Page/Text/View tree built with
 * React.createElement, renderToBuffer.
 *
 * These are structured, correctly-labeled documents with the real IRS box
 * and line numbers and computed figures — not pixel-perfect facsimiles of
 * the official forms (same bar agentbook-invoice-pdf.ts itself set).
 */

import 'server-only';
import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: '#111',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  companyBlock: { flexDirection: 'column' },
  companyName: { fontSize: 16, fontWeight: 700, marginBottom: 2 },
  companyMeta: { fontSize: 9, color: '#666' },
  formLabel: {
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: 1,
    color: '#222',
    textAlign: 'right',
  },
  formSubLabel: { fontSize: 9, color: '#666', textAlign: 'right', marginTop: 2 },
  metaGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  metaBlock: { flexDirection: 'column' },
  metaLabel: { fontSize: 9, color: '#888', textTransform: 'uppercase' },
  metaValue: { fontSize: 11, marginTop: 2 },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    fontWeight: 700,
    fontSize: 9,
    textTransform: 'uppercase',
    color: '#444',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#eee',
  },
  cellLabel: { flexGrow: 3, flexShrink: 1 },
  cellAmount: { width: 100, textAlign: 'right' },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#222',
    fontWeight: 700,
    fontSize: 12,
  },
  notesBlock: { marginTop: 24, fontSize: 9, color: '#555' },
  notesLabel: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    marginBottom: 4,
    color: '#888',
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: '#999',
    textAlign: 'center',
  },
});

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

// Standard combined US FICA rates, used only to split a single combined
// ficaCents figure into its Social Security / Medicare display components
// for box/line presentation — not a recomputation from actual per-employee
// wage bases. Employee-side rates: 6.2% SS + 1.45% Medicare = 7.65% total;
// the same ratio is used to apportion the 941's combined (employee +
// employer) FICA figure into its 12.4% SS / 2.9% Medicare display lines.
const SS_RATE = 6.2;
const MEDICARE_RATE = 1.45;
const SS_SHARE = SS_RATE / (SS_RATE + MEDICARE_RATE);
const MEDICARE_SHARE = MEDICARE_RATE / (SS_RATE + MEDICARE_RATE);

function DocShell(props: {
  formLabel: string;
  formSubLabel?: string;
  employerName: string;
  metaBlocks: Array<{ label: string; value: string }>;
  rows: Array<{ label: string; value: string; bold?: boolean }>;
  total: { label: string; value: string };
  footnote?: string;
  footerText: string;
}): React.ReactElement {
  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: 'LETTER', style: styles.page },
      // Header
      React.createElement(
        View,
        { style: styles.headerRow },
        React.createElement(
          View,
          { style: styles.companyBlock },
          React.createElement(Text, { style: styles.companyName }, props.employerName),
        ),
        React.createElement(
          View,
          null,
          React.createElement(Text, { style: styles.formLabel }, props.formLabel),
          props.formSubLabel &&
            React.createElement(Text, { style: styles.formSubLabel }, props.formSubLabel),
        ),
      ),
      // Meta grid
      React.createElement(
        View,
        { style: styles.metaGrid },
        ...props.metaBlocks.map((m, i) =>
          React.createElement(
            View,
            { style: styles.metaBlock, key: i },
            React.createElement(Text, { style: styles.metaLabel }, m.label),
            React.createElement(Text, { style: styles.metaValue }, m.value),
          ),
        ),
      ),
      // Table header
      React.createElement(
        View,
        { style: styles.tableHeader },
        React.createElement(Text, { style: styles.cellLabel }, 'Line / Box'),
        React.createElement(Text, { style: styles.cellAmount }, 'Amount'),
      ),
      // Rows
      ...props.rows.map((r, i) =>
        React.createElement(
          View,
          { style: styles.tableRow, key: i },
          React.createElement(Text, { style: styles.cellLabel }, r.label),
          React.createElement(Text, { style: styles.cellAmount }, r.value),
        ),
      ),
      // Total
      React.createElement(
        View,
        { style: styles.grandTotalRow },
        React.createElement(Text, null, props.total.label),
        React.createElement(Text, null, props.total.value),
      ),
      // Footnote
      props.footnote &&
        React.createElement(
          View,
          { style: styles.notesBlock },
          React.createElement(Text, { style: styles.notesLabel }, 'Note'),
          React.createElement(Text, null, props.footnote),
        ),
      // Footer
      React.createElement(Text, { style: styles.footer, fixed: true }, props.footerText),
    ),
  );
}

// ---------------------------------------------------------------------------
// W-2 / T4 / P60 / Payment Summary (year-end forms)
// ---------------------------------------------------------------------------

export interface W2PdfData {
  employeeName: string;
  employerName: string;
  year: number;
  boxes: Record<string, number>; // from YearEndForm.boxes
  formType: string; // 'W-2' | 'T4' | 'P60' | 'Payment Summary'
}

/**
 * IRS box labels apply only when formType === 'W-2' (US). For the other
 * jurisdictions' year-end forms (T4/P60/Payment Summary), the same
 * canonical `boxes` keys (from year-end-forms.ts) are shown under generic,
 * jurisdiction-neutral labels instead of borrowing US box numbers that
 * don't apply there.
 */
export async function renderW2Pdf(data: W2PdfData): Promise<Buffer> {
  const b = data.boxes;
  const isW2 = data.formType === 'W-2';
  const isT4 = data.formType === 'T4';
  const combinedFica = b.ficaWithheldCents ?? 0;

  const rows: Array<{ label: string; value: string }> = [];
  if (isW2) {
    rows.push({ label: 'Box 1 — Wages, tips, other compensation', value: fmtMoney(b.grossWagesCents ?? 0) });
    rows.push({ label: 'Box 2 — Federal income tax withheld', value: fmtMoney(b.incomeTaxWithheldCents ?? 0) });
    rows.push({ label: 'Box 4 — Social security tax withheld', value: fmtMoney(Math.round(combinedFica * SS_SHARE)) });
    rows.push({ label: 'Box 6 — Medicare tax withheld', value: fmtMoney(Math.round(combinedFica * MEDICARE_SHARE)) });
    if (b.stateTaxWithheldCents) {
      rows.push({ label: 'Box 17 — State income tax', value: fmtMoney(b.stateTaxWithheldCents) });
    }
  } else if (isT4) {
    rows.push({ label: 'Box 14 — Employment income', value: fmtMoney(b.box14EmploymentIncomeCents ?? 0) });
    if (b.box16CppContributionsCents != null) {
      rows.push({ label: 'Box 16 — Employee’s CPP contributions', value: fmtMoney(b.box16CppContributionsCents) });
    }
    if (b.box17QppContributionsCents != null) {
      rows.push({ label: 'Box 17 — Employee’s QPP contributions', value: fmtMoney(b.box17QppContributionsCents) });
    }
    rows.push({ label: 'Box 18 — Employee’s EI premiums', value: fmtMoney(b.box18EiPremiumsCents ?? 0) });
    rows.push({ label: 'Box 22 — Income tax deducted', value: fmtMoney(b.box22IncomeTaxDeductedCents ?? 0) });
    if (b.box24EiInsurableEarningsCents != null) {
      rows.push({ label: 'Box 24 — EI insurable earnings', value: fmtMoney(b.box24EiInsurableEarningsCents) });
    }
    if (b.box26PensionableEarningsCents != null) {
      rows.push({ label: 'Box 26 — CPP/QPP pensionable earnings', value: fmtMoney(b.box26PensionableEarningsCents) });
    }
    if (b.box55PpipPremiumsCents != null) {
      rows.push({ label: 'Box 55 — Employee’s PPIP (QPIP) premiums', value: fmtMoney(b.box55PpipPremiumsCents) });
    }
    if (b.box56PpipInsurableEarningsCents != null) {
      rows.push({ label: 'Box 56 — PPIP insurable earnings', value: fmtMoney(b.box56PpipInsurableEarningsCents) });
    }
  } else {
    rows.push({ label: 'Gross wages', value: fmtMoney(b.grossWagesCents ?? 0) });
    rows.push({ label: 'Income tax withheld', value: fmtMoney(b.incomeTaxWithheldCents ?? 0) });
    if (b.stateTaxWithheldCents) {
      rows.push({ label: 'Provincial/state tax withheld', value: fmtMoney(b.stateTaxWithheldCents) });
    }
    if (combinedFica) {
      rows.push({ label: 'Employee contributions (CPP/EI/NI)', value: fmtMoney(combinedFica) });
    }
    if (b.superannuationPaidCents) {
      rows.push({ label: 'Superannuation paid (employer)', value: fmtMoney(b.superannuationPaidCents) });
    }
  }

  const totalWithheld = isT4
    ? (b.box22IncomeTaxDeductedCents ?? 0) + (b.box16CppContributionsCents ?? b.box17QppContributionsCents ?? 0) + (b.box18EiPremiumsCents ?? 0) + (b.box55PpipPremiumsCents ?? 0)
    : (b.incomeTaxWithheldCents ?? 0) + (b.stateTaxWithheldCents ?? 0) + combinedFica;

  const doc = DocShell({
    formLabel: data.formType.toUpperCase(),
    formSubLabel: `Tax year ${data.year}`,
    employerName: data.employerName,
    metaBlocks: [
      { label: 'Employee', value: data.employeeName },
      { label: 'Tax year', value: String(data.year) },
    ],
    rows,
    total: { label: 'Total withheld', value: fmtMoney(totalWithheld) },
    footnote: isW2
      ? 'Box 4/Box 6 split from combined FICA withholding at the standard 6.2%/1.45% proportion.'
      : isT4
        ? 'Box 24/26 (and Box 56 for Quebec) are derived from this engine’s own contribution-rate constants, not a separate published earnings threshold.'
        : undefined,
    footerText: `${data.employeeName} · ${data.formType} ${data.year} · Generated by AgentBook · ${new Date().toISOString().slice(0, 10)}`,
  });
  return (await renderToBuffer(doc as any)) as Buffer;
}

// ---------------------------------------------------------------------------
// T4A (Canada) — statement of pension, retirement, annuity, and OTHER
// income, used here for contractor "fees for services" (Box 048). This is
// a genuinely new capability (CA-3 remediation) — previously only an
// eligibility REPORT existed (getContractorSummaries flags a contractor
// crossed the $500 threshold), with no actual document to generate.
// ---------------------------------------------------------------------------

export interface T4APdfData {
  payerName: string;
  recipientName: string;
  year: number;
  feesForServicesCents: number;
}

/**
 * AbVendor has no SIN/business-number/address fields today (confirmed by
 * reading packages/database/prisma/schema.prisma — id/name/normalizedName/
 * defaultCategoryId/transactionCount/lastSeen/deletedAt/createdAt/updatedAt
 * only), so this slip cannot include the recipient's SIN or mailing
 * address. Rather than fabricate placeholder data, this renders a real,
 * correctly-labeled Box 048 figure with an explicit, visible disclosure of
 * what's missing — matching the "real document, not a facsimile, and
 * honest about scope" bar already set by the W-2/941/940 renderers.
 */
export async function renderT4APdf(data: T4APdfData): Promise<Buffer> {
  const rows = [
    { label: 'Box 048 — Fees for services', value: fmtMoney(data.feesForServicesCents) },
  ];
  const doc = DocShell({
    formLabel: 'T4A',
    formSubLabel: `Tax year ${data.year}`,
    employerName: data.payerName,
    metaBlocks: [
      { label: 'Recipient', value: data.recipientName },
      { label: 'Tax year', value: String(data.year) },
    ],
    rows,
    total: { label: 'Total fees for services', value: fmtMoney(data.feesForServicesCents) },
    footnote: 'Recipient SIN and mailing address are not currently collected in AgentBook and are omitted from this slip — add them to the vendor record before filing with the CRA.',
    footerText: `${data.recipientName} · T4A ${data.year} · Generated by AgentBook · ${new Date().toISOString().slice(0, 10)}`,
  });
  return (await renderToBuffer(doc as any)) as Buffer;
}

// ---------------------------------------------------------------------------
// Tax-deposit forms: 941 (US quarterly), 940 (US annual FUTA), and a
// generic fallback for the other jurisdictions' deposit forms (t4/paye/bas/sg).
// ---------------------------------------------------------------------------

export interface PayrollDepositPdfData {
  form: string; // '941' | '940' | 'bas' | 't4' | 'paye' | 'sg'
  employerName: string;
  periodLabel: string;
  dueDate: string;
  amountCents: number;
  /** Total gross wages for the period — powers the wages line on 941/940. Undefined when not re-derivable (e.g. no stubs found for the period). */
  grossWagesCents?: number;
  breakdown?: { incomeTaxWithheldCents: number; employeeFicaCents: number; employerFicaCents: number };
}

export async function render941Pdf(data: PayrollDepositPdfData): Promise<Buffer> {
  const combinedFica = (data.breakdown?.employeeFicaCents ?? 0) + (data.breakdown?.employerFicaCents ?? 0);
  const rows = [
    { label: 'Line 2 — Wages, tips, and other compensation', value: data.grossWagesCents != null ? fmtMoney(data.grossWagesCents) : 'n/a' },
    { label: 'Line 3 — Federal income tax withheld', value: fmtMoney(data.breakdown?.incomeTaxWithheldCents ?? 0) },
    { label: 'Line 5a — Taxable social security wages × 12.4% (combined)', value: fmtMoney(Math.round(combinedFica * SS_SHARE)) },
    { label: 'Line 5c — Taxable Medicare wages × 2.9% (combined)', value: fmtMoney(Math.round(combinedFica * MEDICARE_SHARE)) },
  ];
  const doc = DocShell({
    formLabel: 'FORM 941',
    formSubLabel: "Employer's Quarterly Federal Tax Return",
    employerName: data.employerName,
    metaBlocks: [
      { label: 'Period', value: data.periodLabel },
      { label: 'Due date', value: fmtDate(data.dueDate) },
    ],
    rows,
    total: { label: 'Line 10 — Total taxes before adjustments', value: fmtMoney(data.amountCents) },
    footnote:
      'Line 5a/5c apportioned from combined employee + employer FICA at the standard 12.4%/2.9% (SS/Medicare) proportion, not recomputed from separate per-employee SS/Medicare wage bases.',
    footerText: `Form 941 · ${data.periodLabel} · Generated by AgentBook · ${new Date().toISOString().slice(0, 10)}`,
  });
  return (await renderToBuffer(doc as any)) as Buffer;
}

export async function render940Pdf(data: PayrollDepositPdfData): Promise<Buffer> {
  const rows = [
    { label: 'Line 3 — Total payments to all employees', value: data.grossWagesCents != null ? fmtMoney(data.grossWagesCents) : 'n/a' },
    { label: 'Line 7 — Total taxable FUTA wages', value: data.grossWagesCents != null ? fmtMoney(data.grossWagesCents) : 'n/a' },
    { label: 'Line 8 — FUTA tax before adjustments (0.6%)', value: fmtMoney(data.amountCents) },
  ];
  const doc = DocShell({
    formLabel: 'FORM 940',
    formSubLabel: "Employer's Annual Federal Unemployment (FUTA) Tax Return",
    employerName: data.employerName,
    metaBlocks: [
      { label: 'Year', value: data.periodLabel },
      { label: 'Due date', value: fmtDate(data.dueDate) },
    ],
    rows,
    total: { label: 'Total FUTA tax due', value: fmtMoney(data.amountCents) },
    footnote:
      'Line 7 assumes the full gross wages shown are within the FUTA wage base — this planning tool does not track the per-employee $7,000 annual wage-base cap across pay runs (see computeFutaDeposit in payroll-deposits.ts). Not a certified figure for actual 940 filing.',
    footerText: `Form 940 · ${data.periodLabel} · Generated by AgentBook · ${new Date().toISOString().slice(0, 10)}`,
  });
  return (await renderToBuffer(doc as any)) as Buffer;
}

const GENERIC_FORM_LABEL: Record<string, { label: string; sub: string }> = {
  t4: { label: 'T4 REMITTANCE', sub: 'Employer remittance of income tax + CPP + EI' },
  paye: { label: 'PAYE/NI', sub: 'Employer remittance of PAYE income tax + National Insurance' },
  bas: { label: 'BAS', sub: 'Business Activity Statement — PAYG withholding' },
  sg: { label: 'SUPERANNUATION GUARANTEE', sub: 'Employer superannuation contribution remittance' },
};

/** Fallback for non-US deposit forms (t4/paye/bas/sg) — no IRS-style sub-line breakdown exists for these, just the period/due-date/amount. */
export async function renderGenericDepositPdf(data: PayrollDepositPdfData): Promise<Buffer> {
  const meta = GENERIC_FORM_LABEL[data.form] ?? { label: data.form.toUpperCase(), sub: 'Payroll tax remittance' };
  const doc = DocShell({
    formLabel: meta.label,
    formSubLabel: meta.sub,
    employerName: data.employerName,
    metaBlocks: [
      { label: 'Period', value: data.periodLabel },
      { label: 'Due date', value: fmtDate(data.dueDate) },
    ],
    rows: [{ label: 'Amount due', value: fmtMoney(data.amountCents) }],
    total: { label: 'Total due', value: fmtMoney(data.amountCents) },
    footerText: `${meta.label} · ${data.periodLabel} · Generated by AgentBook · ${new Date().toISOString().slice(0, 10)}`,
  });
  return (await renderToBuffer(doc as any)) as Buffer;
}
