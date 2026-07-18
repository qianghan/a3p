import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  renderW2Pdf,
  render941Pdf,
  render940Pdf,
  renderGenericDepositPdf,
  type W2PdfData,
  type PayrollDepositPdfData,
} from '../payroll-forms-pdf';

function expectRealPdf(buf: Buffer) {
  expect(buf).toBeInstanceOf(Buffer);
  expect(buf.length).toBeGreaterThan(500); // even a minimal PDF is >500 bytes
  const header = buf.subarray(0, 8).toString('utf8');
  expect(header).toMatch(/^%PDF-/); // PDF spec: file MUST start with %PDF-<version>
}

describe('renderW2Pdf', () => {
  const w2: W2PdfData = {
    employeeName: 'Jane Doe',
    employerName: 'Acme Consulting',
    year: 2026,
    formType: 'W-2',
    boxes: {
      grossWagesCents: 6_000_00,
      incomeTaxWithheldCents: 800_00,
      stateTaxWithheldCents: 100_00,
      ficaWithheldCents: 459_00,
    },
  };

  it('produces a real PDF buffer for a US W-2', async () => {
    const buf = await renderW2Pdf(w2);
    expectRealPdf(buf);
  }, 20_000);

  it('produces a real PDF buffer for a CA T4', async () => {
    const buf = await renderW2Pdf({ ...w2, formType: 'T4', boxes: { grossWagesCents: 5_000_00, incomeTaxWithheldCents: 600_00 } });
    expectRealPdf(buf);
  }, 20_000);

  it('produces a real PDF buffer for an AU Payment Summary with superannuation', async () => {
    const buf = await renderW2Pdf({
      ...w2,
      formType: 'Payment Summary',
      boxes: { grossWagesCents: 12_000_00, incomeTaxWithheldCents: 1_600_00, ficaWithheldCents: 0, superannuationPaidCents: 1_440_00 },
    });
    expectRealPdf(buf);
  }, 20_000);

  it('handles a form with no state tax box present', async () => {
    const buf = await renderW2Pdf({ ...w2, boxes: { grossWagesCents: 3_000_00, incomeTaxWithheldCents: 400_00, ficaWithheldCents: 229_50 } });
    expectRealPdf(buf);
  }, 20_000);
});

describe('render941Pdf', () => {
  const dep: PayrollDepositPdfData = {
    form: '941',
    employerName: 'Acme Consulting',
    periodLabel: '2026-Q2',
    dueDate: '2026-07-31',
    amountCents: 400_00 + 229_50 + 229_50,
    grossWagesCents: 10_000_00,
    breakdown: { incomeTaxWithheldCents: 400_00, employeeFicaCents: 229_50, employerFicaCents: 229_50 },
  };

  it('produces a real PDF buffer with a breakdown', async () => {
    const buf = await render941Pdf(dep);
    expectRealPdf(buf);
  }, 20_000);

  it('handles a missing breakdown/gross wages gracefully (n/a line)', async () => {
    const buf = await render941Pdf({ form: '941', employerName: 'Acme', periodLabel: '2026-Q1', dueDate: '2026-04-30', amountCents: 0 });
    expectRealPdf(buf);
  }, 20_000);
});

describe('render940Pdf', () => {
  it('produces a real PDF buffer', async () => {
    const buf = await render940Pdf({
      form: '940',
      employerName: 'Acme Consulting',
      periodLabel: '2026',
      dueDate: '2027-01-31',
      amountCents: 6_000,
      grossWagesCents: 10_000_00,
    });
    expectRealPdf(buf);
  }, 20_000);

  it('handles missing gross wages (n/a line)', async () => {
    const buf = await render940Pdf({ form: '940', employerName: 'Acme', periodLabel: '2026', dueDate: '2027-01-31', amountCents: 3_600 });
    expectRealPdf(buf);
  }, 20_000);
});

describe('renderGenericDepositPdf', () => {
  it.each(['t4', 'paye', 'bas', 'sg', 'unknown-form'])('produces a real PDF buffer for form=%s', async (form) => {
    const buf = await renderGenericDepositPdf({
      form,
      employerName: 'Acme Consulting',
      periodLabel: '2026-Q2',
      dueDate: '2026-07-28',
      amountCents: 1_200_00,
    });
    expectRealPdf(buf);
  }, 20_000);
});
