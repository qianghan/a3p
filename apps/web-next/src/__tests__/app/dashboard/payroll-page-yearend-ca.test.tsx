/**
 * Payroll page — CA/Quebec T4 year-end box display (PARITY-6, Task 1).
 *
 * Root cause: the year-end tab read the US/UK/AU-generic box key names
 * (grossWagesCents/incomeTaxWithheldCents/ficaWithheldCents), which don't
 * exist on a CA/Quebec T4 form object (buildYearEndForm() in
 * apps/web-next/src/lib/year-end-forms.ts returns CRA box-numbered keys
 * instead: box14EmploymentIncomeCents, box22IncomeTaxDeductedCents,
 * box16CppContributionsCents/box17QppContributionsCents,
 * box18EiPremiumsCents, box55PpipPremiumsCents). Every CA employee's
 * year-end row silently showed $0 gross / $0 tax.
 *
 * NOTE on currency assertions: formatCurrencyCents (apps/web-next/src/lib/
 * jurisdiction-currency.ts) always passes `maximumFractionDigits: 0` to
 * Intl.NumberFormat, so fractional-dollar cents amounts render rounded to
 * the nearest whole dollar, not with cents. E.g. 386_750 cents ($3,867.50)
 * renders as "$3,868", not "$3,867.50" — verified with
 * `(386750/100).toLocaleString('en-US',{style:'currency',currency:'USD',
 * maximumFractionDigits:0})` before writing these assertions.
 *
 * NOTE on scoping: both worked-example employees deliberately share the
 * same $90,000 gross / $1,200,000 tax boxes (to demonstrate the same
 * annual base run through the non-Quebec vs Quebec splitCaDeductions
 * branches), so a bare screen.getByText(/gross \$90,000/i) would match
 * both rows and throw. Assertions are scoped with `within()` to each
 * employee's own row (name + summary line share an inner wrapping <div>).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import PayrollPage from '@/app/(dashboard)/payroll/page';

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });
}

function rowFor(employeeName: string): HTMLElement {
  const nameEl = screen.getByText(employeeName);
  const row = nameEl.closest('div');
  if (!row) throw new Error(`could not find wrapping row for ${employeeName}`);
  return row as HTMLElement;
}

describe('Payroll page — CA year-end box display (PARITY-6)', () => {
  beforeEach(() => {
    global.fetch = vi.fn((url: string) => {
      if (url.includes('/employees')) return jsonResponse({ success: true, data: [] });
      if (url.includes('/pay-runs')) return jsonResponse({ success: true, data: [] });
      if (url.includes('/tax-deposits')) return jsonResponse({ success: true, data: [] });
      if (url.includes('/year-end')) {
        return jsonResponse({
          success: true,
          data: {
            forms: [
              {
                formType: 'T4',
                employeeName: 'Jane ON',
                year: 2025,
                boxes: {
                  box14EmploymentIncomeCents: 9_000_000,
                  box22IncomeTaxDeductedCents: 1_200_000,
                  box16CppContributionsCents: 386_750,
                  box18EiPremiumsCents: 104_912,
                },
                employeeId: 'emp-on',
              },
              {
                formType: 'T4',
                employeeName: 'Marie QC',
                year: 2025,
                boxes: {
                  box14EmploymentIncomeCents: 9_000_000,
                  box22IncomeTaxDeductedCents: 1_200_000,
                  box17QppContributionsCents: 433_920,
                  box18EiPremiumsCents: 86_067,
                  // NOT the QPIP cap (48412) — $90,000 gross * 0.00494 =
                  // 44,460, which is under the cap, so the real (uncapped)
                  // value applies here. Verified against
                  // apps/web-next/src/lib/__tests__/payroll-engine.test.ts's
                  // own splitCaDeductions(90_000_00, 'QC') fixture.
                  box55PpipPremiumsCents: 44_460,
                },
                employeeId: 'emp-qc',
              },
            ],
          },
        });
      }
      return jsonResponse({ success: true, data: [] });
    }) as unknown as typeof fetch;
  });

  it('shows real gross/tax/CPP/EI figures for a non-Quebec CA employee (not $0)', async () => {
    render(<PayrollPage />);
    fireEvent.click(await screen.findByText('Year-end'));

    await waitFor(() => {
      expect(screen.getByText('Jane ON')).toBeInTheDocument();
    });
    const row = rowFor('Jane ON');
    expect(within(row).getByText(/gross \$90,000/i)).toBeInTheDocument();
    expect(within(row).getByText(/tax \$12,000/i)).toBeInTheDocument();
    // 386_750 cents = $3,867.50 — formatCurrencyCents rounds to whole
    // dollars (maximumFractionDigits: 0), so this renders as $3,868.
    expect(within(row).getByText(/CPP \$3,868/i)).toBeInTheDocument();
    // 104_912 cents = $1,049.12 — rounds to $1,049.
    expect(within(row).getByText(/EI \$1,049/i)).toBeInTheDocument();
  });

  it('shows QPP/QPIP (not CPP) for a Quebec employee', async () => {
    render(<PayrollPage />);
    fireEvent.click(await screen.findByText('Year-end'));

    await waitFor(() => {
      expect(screen.getByText('Marie QC')).toBeInTheDocument();
    });
    const row = rowFor('Marie QC');
    // 433_920 cents = $4,339.20 — rounds to $4,339.
    expect(within(row).getByText(/QPP \$4,339/i)).toBeInTheDocument();
    // 44_460 cents = $444.60 — rounds to $445.
    expect(within(row).getByText(/QPIP \$445/i)).toBeInTheDocument();
    expect(within(row).queryByText(/CPP \$/i)).not.toBeInTheDocument();
  });
});
