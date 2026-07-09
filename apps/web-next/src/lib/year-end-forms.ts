/**
 * Pure year-end form builder. Aggregates an employee's stubs for a year into a
 * W-2 (US) / T4 (CA) / P60 (UK) / Payment Summary (AU) box payload.
 */

export interface YearEndStub {
  grossCents: number;
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number;
  sgCents?: number; // Superannuation Guarantee (AU) — optional, defaults to 0
}

export interface YearEndForm {
  formType: 'W-2' | 'T4' | 'P60' | 'Payment Summary';
  employeeName: string;
  year: number;
  boxes: Record<string, number>;
}

const FORM_TYPE: Record<string, YearEndForm['formType']> = {
  us: 'W-2', ca: 'T4', uk: 'P60', au: 'Payment Summary',
};

export function buildYearEndForm(
  employeeName: string,
  jurisdiction: string,
  year: number,
  stubs: YearEndStub[],
): YearEndForm {
  let gross = 0, fed = 0, state = 0, fica = 0, sg = 0;
  for (const s of stubs) {
    gross += s.grossCents;
    fed += s.federalTaxCents;
    state += s.stateTaxCents;
    fica += s.ficaCents;
    sg += s.sgCents ?? 0;
  }
  const formType = FORM_TYPE[jurisdiction] ?? 'W-2';
  // Box labels differ per form; keep canonical keys the UI can render.
  const boxes: Record<string, number> = {
    grossWagesCents: gross,
    incomeTaxWithheldCents: fed,
    stateTaxWithheldCents: state,
    ficaWithheldCents: fica,
  };
  // Superannuation contributions are reported separately on an AU Payment
  // Summary (they're not withheld from the employee's pay, unlike FICA/CPP/NI).
  if (sg > 0) boxes.superannuationPaidCents = sg;
  return { formType, employeeName, year, boxes };
}
