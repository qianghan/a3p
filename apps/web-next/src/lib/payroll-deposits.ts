/**
 * Pure payroll tax-deposit computation. From processed pay stubs in a quarter,
 * derive the remittance obligation + form + due date per jurisdiction.
 *
 * US: Form 941 (income tax withheld + FICA employee + employer-match FICA),
 *     quarterly, due the last day of the month after quarter end.
 * CA: T4 remittance (income tax + CPP×2 + EI×1.4).
 * UK: PAYE/NI remittance. AU: BAS (PAYG withholding) — a separate remittance
 *     from Superannuation Guarantee, which goes to super funds, not the ATO
 *     (see computeSgDeposit below).
 */

export interface DepositStub {
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number; // employee-side FICA/CPP+EI/NI
  sgCents?: number; // Superannuation Guarantee (AU) — optional, defaults to 0
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

/**
 * Superannuation Guarantee is due 28 days after every calendar quarter end,
 * uniformly for all 4 quarters — unlike BAS/PAYG withholding (depositDueDate
 * above), which gets a "last day of the following month" rule that happens to
 * land a month later than SG for the Oct-Dec quarter specifically (BAS: 28
 * Feb: SG: 28 Jan). Confirmed against the AU jurisdiction pack's calendar
 * deadlines (packages/agentbook-jurisdictions/src/au/calendar-deadlines.ts).
 */
export function sgDepositDueDate(year: number, q: number): string {
  const quarterEndMonthIndex = q * 3 - 1; // 0-based: Q1->2(Mar) Q2->5(Jun) Q3->8(Sep) Q4->11(Dec)
  const quarterEndDate = new Date(year, quarterEndMonthIndex + 1, 0); // last day of the quarter-end month
  const due = new Date(quarterEndDate);
  due.setDate(due.getDate() + 28);
  return due.toISOString().slice(0, 10);
}

/**
 * AU-only. Superannuation Guarantee is remitted to employees' super funds —
 * a completely separate obligation from BAS/PAYG withholding (computeDeposit
 * above), with its own form code and due-date rule, not a component folded
 * into the BAS amount.
 */
export function computeSgDeposit(stubs: { sgCents?: number }[], date: Date): Deposit {
  const { q, year } = quarterOf(date);
  const amountCents = stubs.reduce((sum, s) => sum + (s.sgCents ?? 0), 0);
  return {
    form: 'sg',
    periodLabel: `${year}-Q${q}`,
    amountCents,
    dueDate: sgDepositDueDate(year, q),
  };
}
