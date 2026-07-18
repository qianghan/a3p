/**
 * Pure year-end form builder. Aggregates an employee's stubs for a year into a
 * W-2 (US) / T4 (CA) / P60 (UK) / Payment Summary (AU) box payload.
 */

import { splitCaDeductions } from './payroll-engine.js';

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
  /** AbEmployee.id, when the caller has one — lets the frontend target one specific employee's PDF (e.g. two employees named "Jane Smith") instead of matching by name. Optional to keep this a backward-compatible addition for existing callers. */
  employeeId?: string;
}

const FORM_TYPE: Record<string, YearEndForm['formType']> = {
  us: 'W-2', ca: 'T4', uk: 'P60', au: 'Payment Summary',
};

export function buildYearEndForm(
  employeeName: string,
  jurisdiction: string,
  year: number,
  stubs: YearEndStub[],
  employeeId?: string,
  region?: string,
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

  let boxes: Record<string, number>;
  if (jurisdiction === 'ca') {
    // CA-3 remediation: real CRA box numbers, derived from the employee's
    // aggregated annual gross for the year via the same rate/cap logic
    // already used to compute each pay stub's withholding (no schema
    // migration needed — see this PR's plan doc for the rationale).
    const split = splitCaDeductions(gross, region);
    boxes = {
      box14EmploymentIncomeCents: gross,
      box18EiPremiumsCents: split.eiCents,
      box22IncomeTaxDeductedCents: fed,
      // Insurable/pensionable-earnings boxes, back-derived from this
      // simplified engine's own contribution-cap constants (not the CRA's
      // separately-published YMPE/MIE to the exact dollar — see Global
      // Constraints in this PR's plan doc).
      box24EiInsurableEarningsCents: Math.min(gross, Math.round((split.pensionBoxLabel === 'QPP' ? 86_067 : 104_912) / (split.pensionBoxLabel === 'QPP' ? 0.0131 : 0.0166))),
      box26PensionableEarningsCents: Math.min(gross, Math.round(split.pensionBoxLabel === 'QPP' ? 4_339_20 / 0.0640 : 3_867_50 / 0.0595)),
    };
    if (split.pensionBoxLabel === 'QPP') {
      boxes.box17QppContributionsCents = split.pensionCents;
      boxes.box55PpipPremiumsCents = split.qpipCents;
      boxes.box56PpipInsurableEarningsCents = Math.min(gross, Math.round(484_12 / 0.00494));
    } else {
      boxes.box16CppContributionsCents = split.pensionCents;
    }
  } else {
    // Box labels differ per form; keep canonical keys the UI can render.
    boxes = {
      grossWagesCents: gross,
      incomeTaxWithheldCents: fed,
      stateTaxWithheldCents: state,
      ficaWithheldCents: fica,
    };
    // Superannuation contributions are reported separately on an AU Payment
    // Summary (they're not withheld from the employee's pay, unlike FICA/CPP/NI).
    if (sg > 0) boxes.superannuationPaidCents = sg;
  }
  return { formType, employeeName, year, boxes, ...(employeeId ? { employeeId } : {}) };
}
