/**
 * Pure payroll tax-deposit computation. From processed pay stubs in a quarter,
 * derive the remittance obligation + form + due date per jurisdiction.
 *
 * US: Form 941 (income tax withheld + FICA employee + employer-match FICA),
 *     quarterly, due the last day of the month after quarter end.
 * CA: T4 remittance (income tax + CPP×2 + EI×1.4).
 * UK: PAYE/NI remittance. AU: BAS (PAYG withholding).
 */

export interface DepositStub {
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number; // employee-side FICA/CPP+EI/NI
}

export interface Deposit {
  form: string;
  periodLabel: string;
  amountCents: number;
  dueDate: string; // ISO date
}

export function quarterOf(date: Date): { q: number; year: number } {
  return { q: Math.floor(date.getMonth() / 3) + 1, year: date.getFullYear() };
}

/** Last day of the month following the quarter end. */
export function depositDueDate(year: number, q: number): string {
  // Quarter end months: Q1→Mar, Q2→Jun, Q3→Sep, Q4→Dec. Due end of next month.
  const dueMonthIndex = q * 3; // 0-based month AFTER quarter end (Apr=3, Jul=6, Oct=9, Jan=12→next yr)
  const dueYear = dueMonthIndex > 11 ? year + 1 : year;
  const m = dueMonthIndex % 12;
  const lastDay = new Date(dueYear, m + 1, 0).getDate();
  return new Date(dueYear, m, lastDay).toISOString().slice(0, 10);
}

const FORM_BY_JURISDICTION: Record<string, string> = { us: '941', ca: 't4', uk: 'paye', au: 'bas' };

export function computeDeposit(stubs: DepositStub[], jurisdiction: string, date: Date): Deposit {
  const { q, year } = quarterOf(date);
  let income = 0;
  let employeeFica = 0;
  for (const s of stubs) {
    income += s.federalTaxCents + s.stateTaxCents;
    employeeFica += s.ficaCents;
  }
  // Employer matches FICA (US) / CPP×1 + EI×0.4 (CA). Approximate the employer
  // share as equal to the employee FICA for US 941; for others use employee only.
  const employerMatch = jurisdiction === 'us' ? employeeFica : 0;
  const amountCents = income + employeeFica + employerMatch;
  return {
    form: FORM_BY_JURISDICTION[jurisdiction] ?? '941',
    periodLabel: `${year}-Q${q}`,
    amountCents,
    dueDate: depositDueDate(year, q),
  };
}
