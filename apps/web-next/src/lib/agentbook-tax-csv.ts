/**
 * CSV serialisers for the year-end tax package (PR 5).
 *
 * Each function takes the gathered `PackageData` (the pure shape produced
 * by `agentbook-tax-package#gatherPackageData`) and returns a CSV string
 * suitable for upload to Vercel Blob and download by the user's
 * accountant. RFC 4180 quoting — same pattern used by the mileage export
 * route at `/api/v1/agentbook-expense/mileage/export/route.ts`.
 *
 * No DB I/O here; these are pure functions exercised by the unit tests.
 * That keeps the privacy guarantee: only fields explicitly serialised
 * below ever land in the CSV. Sensitive fields (passwordHash,
 * accessTokenEnc, apiKey) cannot leak — they aren't in the input shape.
 */

import type { PackageData } from './agentbook-tax-package';

/**
 * RFC 4180 quoting + Excel formula-injection prevention.
 *
 * If a cell starts with `= + - @ \t \r`, Excel / Google Sheets will
 * interpret the value as a formula and may execute it (CVE-style data
 * exfiltration via `=HYPERLINK(...)` or `=cmd|'...'`). Prefix the cell
 * with a single quote so the spreadsheet treats it as text. The single
 * quote is invisible in the rendered cell but defangs the formula.
 *
 * Then apply the standard RFC 4180 wrap if the value contains a comma,
 * quote, or newline.
 */
function csvEscape(value: string): string {
  let v = value;
  if (v.length > 0 && /^[=+\-@\t\r]/.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function row(cells: (string | number)[]): string {
  return cells.map((c) => csvEscape(String(c))).join(',');
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * P&L by tax line — one row per line key on the relevant return form.
 * Header + body + footer total. The line keys are already
 * jurisdiction-tagged ("Schedule C Line 24a - Travel" etc.) so the
 * accountant can transcribe directly to the return.
 */
export function renderPnlCsv(data: PackageData): string {
  const lines: string[] = [];
  lines.push(row(['Tax Line', 'Amount (USD)']));
  const sorted = Object.entries(data.pnlByLine).sort(([a], [b]) => a.localeCompare(b));
  for (const [line, cents] of sorted) {
    lines.push(row([line, dollars(cents)]));
  }
  lines.push('');
  const total = Object.values(data.pnlByLine).reduce((s, v) => s + v, 0);
  lines.push(row(['Total', dollars(total)]));
  lines.push(row(['Period start', data.period.start.toISOString().slice(0, 10)]));
  lines.push(row(['Period end', data.period.end.toISOString().slice(0, 10)]));
  lines.push(row(['Jurisdiction', data.jurisdiction]));
  return lines.join('\n') + '\n';
}

/**
 * Mileage detail CSV — one row per trip, plus a totals footer. Unit is
 * preserved so a CRA T2125 reader sees km and a Schedule C reader sees
 * miles, matching the original entry.
 */
export function renderMileageCsv(data: PackageData): string {
  const lines: string[] = [];
  lines.push(row(['Date', 'Quantity', 'Unit', 'Purpose', 'Deductible amount (USD)']));
  for (const m of data.mileage.entries) {
    lines.push(row([
      m.date.toISOString().slice(0, 10),
      m.miles.toFixed(2),
      m.unit,
      m.purpose,
      dollars(m.deductibleAmountCents),
    ]));
  }
  lines.push('');
  lines.push(row(['Total Quantity', data.mileage.totalUnit.toFixed(2)]));
  lines.push(row(['Total Deductible', dollars(data.mileage.totalDeductibleCents)]));
  return lines.join('\n') + '\n';
}

/**
 * Deductions roll-up CSV — header, per-category totals, grand total
 * line. This is the "headline number" view the accountant uses to
 * cross-check the per-line P&L.
 */
export function renderDeductionsCsv(data: PackageData): string {
  const lines: string[] = [];
  lines.push(row(['Category', 'Amount (USD)']));
  const sorted = Object.entries(data.deductions.byCategory).sort(([, a], [, b]) => b - a);
  for (const [cat, cents] of sorted) {
    lines.push(row([cat, dollars(cents)]));
  }
  lines.push('');
  lines.push(row(['Grand Total', dollars(data.deductions.totalCents)]));
  lines.push(row(['Mileage deductible', dollars(data.mileage.totalDeductibleCents)]));
  return lines.join('\n') + '\n';
}
